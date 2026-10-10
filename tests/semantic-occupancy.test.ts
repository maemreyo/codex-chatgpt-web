import { expect, test } from "bun:test";
import { SemanticEpochOccupancy, semanticEpochOccupancies } from "../src/adapters/chatgpt-web/semantic-occupancy";
import { ChatGptTurnSession, ChatGptTextFeed, ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-execution";
import { settleActiveCompactionSource, settleActiveZeroRiskCompactionSource } from "../src/adapters/chatgpt-web/compaction-handoff";
import { parseRequest } from "../src/responses/parser";
import type { TurnBroker, TurnBrokerOwner } from "../src/adapters/chatgpt-web/turn-broker";

test("epoch occupancy counts accepted submissions and tool results once across reconnects", () => {
  const ledger = new SemanticEpochOccupancy(50_000, true, "chatgpt-web-sol");
  ledger.record("submit:trace1", 2_000);
  ledger.record("submit:trace1", 2_000);
  ledger.recordToolResult("call-one", "A".repeat(8_000));
  const counted = ledger.value;
  ledger.recordToolResult("call-one", "A".repeat(8_000));
  expect(ledger.value).toBe(counted);
  expect(ledger.confidence).toBe("known");
  expect(counted).toBeGreaterThan(2_000);
});

test("guard considers the whole batch before recording or delivering anything", () => {
  const ledger = new SemanticEpochOccupancy(20_000, true, "chatgpt-web-sol");
  ledger.record("submit:trace2", 6_000);
  const prior = ledger.value;
  expect(ledger.canDeliverBatch([
    { callId: "call-small", content: "safe" },
    { callId: "call-big", content: "x".repeat(20_000) },
  ])).toBe(false);
  expect(ledger.value).toBe(prior);
  expect(ledger.canDeliverBatch([{ callId: "call-small", content: "safe" }])).toBe(true);
});

test("compaction handoff permits accumulated pressure but refuses one atomic oversized result", () => {
  const ledger = new SemanticEpochOccupancy(40_000, true, "chatgpt-web-sol");
  ledger.record("previous", 39_000);
  expect(ledger.canDeliverBatch([{ callId: "one", content: "a" }])).toBe(false);
  expect(ledger.canFitAtomicResults([{ content: "a" }])).toBe(true);
  expect(ledger.canFitAtomicResults([{ content: "word ".repeat(50_000) }])).toBe(false);
  expect(ledger.batchPressureReason([{ callId: "one", content: "a" }])).toBe("accumulated_occupancy");
  expect(ledger.batchPressureReason([{ callId: "one", content: "word ".repeat(50_000) }]))
    .toBe("atomic_result_oversize");
});

test("unknown restart occupancy and observed size rejection fail closed", () => {
  const unknown = new SemanticEpochOccupancy(90_000, false, "chatgpt-web-sol");
  unknown.record("submit:trace3", 100);
  expect(unknown.value).toBeNull();
  expect(unknown.canDeliverBatch([{ callId: "call1", content: "tiny" }])).toBe(false);
  expect(unknown.batchPressureReason([{ callId: "call1", content: "tiny" }])).toBe("unknown_occupancy");
  const known = new SemanticEpochOccupancy(90_000, true, "chatgpt-web-sol");
  known.markRejected();
  expect(known.canDeliverBatch([{ callId: "call2", content: "tiny" }])).toBe(false);
  expect(known.confidence).toBe("unknown");
});

test("a verified fresh launcher lease resets rejected or unknown browser occupancy", () => {
  const rejected = new SemanticEpochOccupancy(90_000, true, "chatgpt-web-sol");
  rejected.record("prior", 20_000);
  rejected.markRejected();
  expect(rejected.canDeliverBatch([{ callId: "pending", content: "small" }])).toBeFalse();
  rejected.resetForVerifiedFreshLease();
  expect(rejected.confidence).toBe("known");
  expect(rejected.value).toBe(0);
  expect(rejected.canDeliverBatch([{ callId: "pending", content: "small" }])).toBeTrue();

  const lost = new SemanticEpochOccupancy(90_000, false, "chatgpt-web-sol");
  expect(lost.confidence).toBe("unknown");
  lost.resetForVerifiedFreshLease();
  expect(lost.confidence).toBe("known");
  expect(lost.value).toBe(0);
});

test("an epochless retained tab starts with unknown pressure until a verified fresh lease", () => {
  const key = `epochless-native-thread-${process.pid}-${Date.now()}`;
  const unknown = semanticEpochOccupancies.forConversation(key, false, 90_000, "chatgpt-web-sol");
  expect(unknown.batchPressureReason([{ callId: "pending", content: "result" }]))
    .toBe("unknown_occupancy");
  unknown.resetForVerifiedFreshLease();
  unknown.record("canonical-multipart-stages", 79_000);
  expect(semanticEpochOccupancies.forConversation(key, false, 90_000, "chatgpt-web-sol"))
    .toBe(unknown);
  expect(unknown.batchPressureReason([{ callId: "pending", content: "result" }]))
    .toBe("accumulated_occupancy");
});

test("ledger is shared for one retained epoch key but recreated for a new epoch", () => {
  const key = `semantic-reseed-${process.pid}-${Date.now()}`;
  const first = semanticEpochOccupancies.forConversation(key, true, 90_000, "chatgpt-web-sol");
  first.recordOutput("visible assistant output");
  expect(semanticEpochOccupancies.forConversation(key, false, 90_000, "chatgpt-web-sol")).toBe(first);
  const replacement = semanticEpochOccupancies.forConversation(`${key}:new`, true, 90_000, "chatgpt-web-sol");
  expect(replacement).not.toBe(first);
  expect(replacement.value).toBe(0);
  expect(semanticEpochOccupancies.forConversation(`${key}:old-restart`, false, 90_000, "chatgpt-web-sol").confidence).toBe("unknown");
});

test("lost retained tab rebases a known or unknown epoch ledger before charging the new full projection", () => {
  for (const known of [true, false]) {
    const ledger = new SemanticEpochOccupancy(60_000, known, "chatgpt-web-sol");
    ledger.record("old-prompt", 31_000);
    ledger.recordOutput("old response");
    ledger.markRejected();
    ledger.resetForFreshConversation();
    expect(ledger.confidence).toBe("known");
    expect(ledger.value).toBe(0);
    ledger.record("old-prompt", 9_000);
    expect(ledger.value).toBe(9_000);
    expect(ledger.canDeliverBatch([{ callId: "new", content: "small" }])).toBe(true);
  }
});

test("evicted occupancy never becomes a falsely fresh retained browser tab", () => {
  const prefix = `semantic-eviction-${process.pid}-${Date.now()}`;
  const oldestKey = `${prefix}:old`;
  const oldest = semanticEpochOccupancies.forConversation(oldestKey, true, 90_000, "chatgpt-web-sol");
  oldest.record("accepted", 10_000);
  for (let index = 0; index < 520; index += 1) {
    semanticEpochOccupancies.forConversation(`${prefix}:${index}`, true, 90_000, "chatgpt-web-sol");
  }
  const recalled = semanticEpochOccupancies.forConversation(oldestKey, true, 90_000, "chatgpt-web-sol");
  expect(recalled).not.toBe(oldest);
  expect(recalled.confidence).toBe("unknown");
  expect(recalled.value).toBeNull();
  expect(recalled.canDeliverBatch([{ callId: "pending", content: "tiny" }])).toBeFalse();
});

test("pressure replay leaves the full batch intact until canonical compaction settles each call once", async () => {
  const occupancy = new SemanticEpochOccupancy(30_000, true, "chatgpt-web-sol");
  occupancy.record("existing-epoch", 27_000);
  const batch = [{ callId: "first", content: "result-one" }, { callId: "second", content: "result-two" }];
  let resolveBrowser!: (text: string) => void;
  const browser = new Promise<string>(resolve => { resolveBrowser = resolve; });
  const session = new ChatGptTurnSession({
    mode: "tools", token: Promise.resolve("broker-token"), browser,
    physicalSettlement: browser.then(() => undefined),
    semanticOccupancy: occupancy,
    externalProgress: { recordToolResult() {} } as never,
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {},
  });
  session.setOutstanding(batch.map(result => ({ callId: result.callId, wireName: "exec_command", freeform: false })));
  const parsed = parseRequest({
    model: "chatgpt-web/gpt-5.6-sol",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "pressure-thread", turn_id: "pressure-turn" }) },
    input: [
      { type: "message", role: "user", id: "pressure-user", content: "run", internal_chat_message_metadata_passthrough: { turn_id: "pressure-turn" } },
      { type: "function_call_output", call_id: "first", output: "result-one" },
      { type: "function_call_output", call_id: "second", output: "result-two" },
      { type: "compaction_trigger" },
    ],
  });
  const before = occupancy.value;
  expect(occupancy.canDeliverBatch(batch)).toBe(false);
  expect(occupancy.canDeliverBatch(batch)).toBe(false);
  expect(session.outstanding().map(item => item.callId)).toEqual(["first", "second"]);
  expect(occupancy.value).toBe(before);
  const delivered: string[] = [];
  let requested = 0;
  const broker = {
    requestCompaction() { requested += 1; return 0; },
    completeTool(_token: string, callId: string) {
      delivered.push(callId);
      if (delivered.length === 2) resolveBrowser("Canonical compaction ready");
    },
    compactionDeliveryCount() { return 0; },
    revoke() {},
  } as unknown as TurnBroker;
  await expect(settleActiveCompactionSource(parsed, session, broker)).resolves.toMatchObject({ answer: "Canonical compaction ready" });
  expect(requested).toBe(1);
  expect(delivered).toEqual(["first", "second"]);
  expect(session.outstanding()).toHaveLength(0);
  expect(occupancy.value).toBeGreaterThan(before!);
  await expect(settleActiveCompactionSource(parsed, session, broker)).rejects.toThrow("no MCP tool boundary");
  expect(delivered).toEqual(["first", "second"]);
});

test("partial compaction broker failure cancels the retained source without replaying acknowledged results", async () => {
  const occupancy = new SemanticEpochOccupancy(30_000, true, "chatgpt-web-sol");
  const before = occupancy.value;
  let rejectBrowser!: (reason: Error) => void;
  const browser = new Promise<string>((_resolve, reject) => { rejectBrowser = reject; });
  let cancellations = 0;
  let progress = 0;
  const session = new ChatGptTurnSession({
    mode: "tools", token: Promise.resolve("partial-token"), browser,
    physicalSettlement: browser.then(() => undefined, () => undefined),
    semanticOccupancy: occupancy,
    externalProgress: { recordToolResult() { progress += 1; } } as never,
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel(reason?: Error) {
      cancellations += 1;
      rejectBrowser(reason ?? new Error("partial handoff canceled"));
    },
  });
  session.setOutstanding([
    { callId: "first", wireName: "exec_command", freeform: false },
    { callId: "second", wireName: "exec_command", freeform: false },
  ]);
  const parsed = parseRequest({
    model: "chatgpt-web/gpt-5.6-sol",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "partial-thread", turn_id: "partial-turn" }) },
    input: [
      { type: "message", role: "user", id: "partial-user", content: "run", internal_chat_message_metadata_passthrough: { turn_id: "partial-turn" } },
      { type: "function_call_output", call_id: "first", output: "first exact result" },
      { type: "function_call_output", call_id: "second", output: "second exact result" },
      { type: "compaction_trigger" },
    ],
  });
  const attempted: string[] = [];
  const acknowledged: string[] = [];
  let revoked = 0;
  const broker = {
    requestCompaction() { return 0; },
    completeTool(_token: string, callId: string) {
      attempted.push(callId);
      if (callId === "second") throw new Error("simulated second-result transport failure");
      acknowledged.push(callId);
    },
    revoke() { revoked += 1; },
  } as unknown as TurnBroker;

  await expect(settleActiveCompactionSource(parsed, session, broker))
    .rejects.toThrow("simulated second-result transport failure");
  expect(acknowledged).toEqual(["first"]);
  expect(attempted).toEqual(["first", "second"]);
  expect(progress).toBe(1);
  expect(session.outstanding().map(item => item.callId)).toEqual(["second"]);
  expect(occupancy.value).toBeGreaterThan(before!);
  expect(cancellations).toBe(1);
  expect(revoked).toBe(1);
  expect((await session.browserOutcome).type).toBe("error");
  await expect(settleActiveCompactionSource(parsed, session, broker)).rejects.toThrow("no MCP tool boundary");
  expect(attempted).toEqual(["first", "second"]);
});

test("Zero Risk compaction cancels on ambiguous second-result acknowledgement loss", async () => {
  let rejectBrowser!: (reason: Error) => void;
  const browser = new Promise<string>((_resolve, reject) => { rejectBrowser = reject; });
  let cancellations = 0;
  let progress = 0;
  const session = new ChatGptTurnSession({
    mode: "tools", token: Promise.resolve("zero-risk-partial-token"), browser,
    physicalSettlement: browser.then(() => undefined, () => undefined),
    manualControl: { surfaceNonce: "test-surface-nonce" },
    externalProgress: { recordToolResult() { progress += 1; } } as never,
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel(reason?: Error) {
      cancellations += 1;
      rejectBrowser(reason ?? new Error("zero risk compaction canceled"));
    },
  });
  session.setOutstanding([
    { callId: "first", wireName: "exec_command", freeform: false },
    { callId: "second", wireName: "exec_command", freeform: false },
  ]);
  const parsed = parseRequest({
    model: "chatgpt-web/gpt-5.6-sol",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "zero-risk-thread", turn_id: "zero-risk-turn" }) },
    input: [
      { type: "message", role: "user", id: "zero-risk-user", content: "run", internal_chat_message_metadata_passthrough: { turn_id: "zero-risk-turn" } },
      { type: "function_call_output", call_id: "first", output: "first exact result" },
      { type: "function_call_output", call_id: "second", output: "second exact result" },
      { type: "compaction_trigger" },
    ],
  });
  const brokerReceived: string[] = [];
  let revoked = 0;
  const broker = {
    async requestCompaction() { return 0; },
    async completeTool(_token: string, callId: string) {
      brokerReceived.push(callId);
      // The broker may have applied this result before the client lost its ACK.
      if (callId === "second") throw new Error("simulated lost second acknowledgement");
    },
    revoke() { revoked += 1; },
  } as unknown as TurnBrokerOwner;

  await expect(settleActiveZeroRiskCompactionSource(parsed, session, broker))
    .rejects.toThrow("simulated lost second acknowledgement");
  expect(brokerReceived).toEqual(["first", "second"]);
  expect(progress).toBe(1);
  expect(session.outstanding().map(item => item.callId)).toEqual(["second"]);
  expect(cancellations).toBe(1);
  expect(revoked).toBe(1);
  expect((await session.browserOutcome).type).toBe("error");
  await expect(settleActiveZeroRiskCompactionSource(parsed, session, broker)).rejects.toThrow("no manual MCP tool boundary");
  expect(brokerReceived).toEqual(["first", "second"]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function settledWithin<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("compaction settlement remained pending after cancellation")), 250);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function compactionCancellationFixture(token: Promise<string>, manual = false, callIds = ["pending"]) {
  const browser = deferred<string>();
  let cancellations = 0;
  let progress = 0;
  const session = new ChatGptTurnSession({
    mode: "tools", token, browser: browser.promise,
    physicalSettlement: browser.promise.then(() => undefined, () => undefined),
    ...(manual ? { manualControl: { surfaceNonce: "cancellation-fixture" } } : {}),
    externalProgress: { recordToolResult() { progress += 1; } } as never,
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel(reason?: Error) {
      cancellations += 1;
      browser.reject(reason ?? new Error("synthetic compaction cancellation"));
    },
  });
  session.setOutstanding(callIds.map(callId => ({ callId, wireName: "exec_command", freeform: false })));
  const parsed = parseRequest({
    model: "chatgpt-web/gpt-5.6-sol",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "cancellation-thread", turn_id: "cancellation-turn" }) },
    input: [
      { type: "message", role: "user", id: "cancellation-user", content: "run", internal_chat_message_metadata_passthrough: { turn_id: "cancellation-turn" } },
      ...callIds.map(callId => ({ type: "function_call_output" as const, call_id: callId, output: `exact ${callId} result` })),
      { type: "compaction_trigger" },
    ],
  });
  return { session, parsed, get cancellations() { return cancellations; }, get progress() { return progress; } };
}

test("automatic compaction aborts while acquiring a token and revokes a token arriving later", async () => {
  const lateToken = deferred<string>();
  const fixture = compactionCancellationFixture(lateToken.promise);
  const { session, parsed } = fixture;
  const controller = new AbortController();
  const revoked: string[] = [];
  let brokerCalls = 0;
  const broker = {
    requestCompaction() { brokerCalls += 1; return 0; },
    completeTool() { brokerCalls += 1; },
    revoke(token: string) { revoked.push(token); },
  } as unknown as TurnBroker;
  const operation = settleActiveCompactionSource(parsed, session, broker, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("automatic caller canceled"));
  await expect(settledWithin(operation)).rejects.toThrow("automatic caller canceled");
  expect(session.outstanding().map(item => item.callId)).toEqual(["pending"]);
  expect(brokerCalls).toBe(0);
  expect(session.isActive()).toBe(false);
  expect(fixture.cancellations).toBe(1);
  lateToken.resolve("automatic-late-token");
  await new Promise(resolve => setImmediate(resolve));
  expect(revoked).toEqual(["automatic-late-token"]);
});

test("Zero Risk aborts a pending token and revokes its late remote capability", async () => {
  const lateToken = deferred<string>();
  const fixture = compactionCancellationFixture(lateToken.promise, true);
  const controller = new AbortController();
  const revoked: string[] = [];
  let brokerCalls = 0;
  const broker = {
    async requestCompaction() { brokerCalls += 1; return 0; },
    async completeTool() { brokerCalls += 1; },
    async revoke(token: string) { revoked.push(token); },
  } as unknown as TurnBrokerOwner;
  const operation = settleActiveZeroRiskCompactionSource(fixture.parsed, fixture.session, broker, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("Zero Risk caller canceled"));
  await expect(settledWithin(operation)).rejects.toThrow("Zero Risk caller canceled");
  expect(fixture.cancellations).toBe(1);
  expect(fixture.session.isActive()).toBe(false);
  expect(fixture.session.outstanding().map(item => item.callId)).toEqual(["pending"]);
  expect(brokerCalls).toBe(0);
  lateToken.resolve("zero-risk-late-token");
  await new Promise(resolve => setImmediate(resolve));
  expect(revoked).toEqual(["zero-risk-late-token"]);
});

test("Zero Risk aborts an in-flight remote result send without replaying uncertain delivery", async () => {
  const fixture = compactionCancellationFixture(Promise.resolve("zero-risk-in-flight"), true);
  const controller = new AbortController();
  const brokerPending = deferred<void>();
  const started = deferred<void>();
  const revoked: string[] = [];
  const sends: string[] = [];
  const broker = {
    async requestCompaction() { return 0; },
    completeTool(_token: string, callId: string) {
      sends.push(callId);
      started.resolve();
      return brokerPending.promise;
    },
    async revoke(token: string) { revoked.push(token); },
  } as unknown as TurnBrokerOwner;
  const operation = settleActiveZeroRiskCompactionSource(fixture.parsed, fixture.session, broker, controller.signal);
  await settledWithin(started.promise);
  controller.abort(new Error("Zero Risk broker request canceled"));
  await expect(settledWithin(operation)).rejects.toThrow("Zero Risk broker request canceled");
  expect(fixture.cancellations).toBe(1);
  expect(fixture.session.isActive()).toBe(false);
  expect(fixture.session.outstanding().map(item => item.callId)).toEqual(["pending"]);
  expect(fixture.progress).toBe(0);
  expect(revoked).toEqual(["zero-risk-in-flight"]);
  await expect(settleActiveZeroRiskCompactionSource(fixture.parsed, fixture.session, broker))
    .rejects.toThrow("no manual MCP tool boundary");
  expect(sends).toEqual(["pending"]);
});

test("Zero Risk retains delivery and remote revocation failures without replaying an uncertain result", async () => {
  const fixture = compactionCancellationFixture(Promise.resolve("zero-risk-fault"), true, ["first", "second"]);
  const deliveryError = new Error("second result acknowledgement lost");
  const revokeError = new Error("remote revocation failed");
  const calls: string[] = [];
  const broker = {
    async requestCompaction() { return 0; },
    async completeTool(_token: string, callId: string) {
      calls.push(callId);
      if (callId === "second") throw deliveryError;
    },
    async revoke() { throw revokeError; },
  } as unknown as TurnBrokerOwner;
  let failure: unknown;
  try {
    await settledWithin(settleActiveZeroRiskCompactionSource(fixture.parsed, fixture.session, broker));
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([deliveryError, revokeError]);
  expect(fixture.cancellations).toBe(1);
  expect(fixture.session.isActive()).toBe(false);
  expect(fixture.progress).toBe(1);
  expect(fixture.session.outstanding().map(item => item.callId)).toEqual(["second"]);
  await expect(settleActiveZeroRiskCompactionSource(fixture.parsed, fixture.session, broker))
    .rejects.toThrow("no manual MCP tool boundary");
  expect(calls).toEqual(["first", "second"]);
});

test("Zero Risk bounds a hung remote revoke while preserving the delivery failure", async () => {
  const fixture = compactionCancellationFixture(Promise.resolve("zero-risk-revoke-hang"), true);
  const deliveryError = new Error("result acknowledgement missing before revoke timeout");
  let sends = 0;
  let revocations = 0;
  const broker = {
    async requestCompaction() { return 0; },
    async completeTool() { sends += 1; throw deliveryError; },
    revoke() {
      revocations += 1;
      return new Promise<void>(() => {});
    },
  } as unknown as TurnBrokerOwner;
  const started = Date.now();
  let failure: unknown;
  try {
    await settleActiveZeroRiskCompactionSource(fixture.parsed, fixture.session, broker);
  } catch (error) {
    failure = error;
  }
  expect(Date.now() - started).toBeLessThan(7_000);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0]).toBe(deliveryError);
  expect((failure as AggregateError).errors[1]).toMatchObject({ name: "TimeoutError" });
  expect(fixture.cancellations).toBe(1);
  expect(fixture.session.isActive()).toBe(false);
  expect(fixture.session.outstanding().map(item => item.callId)).toEqual(["pending"]);
  expect(sends).toBe(1);
  expect(revocations).toBe(1);
}, 8_000);
