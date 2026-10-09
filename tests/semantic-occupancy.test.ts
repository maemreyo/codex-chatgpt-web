import { expect, test } from "bun:test";
import { SemanticEpochOccupancy, semanticEpochOccupancies } from "../src/adapters/chatgpt-web/semantic-occupancy";
import { ChatGptTurnSession, ChatGptTextFeed, ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-execution";
import { settleActiveCompactionSource } from "../src/adapters/chatgpt-web/compaction-handoff";
import { parseRequest } from "../src/responses/parser";
import type { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

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
});

test("unknown restart occupancy and observed size rejection fail closed", () => {
  const unknown = new SemanticEpochOccupancy(90_000, false, "chatgpt-web-sol");
  unknown.record("submit:trace3", 100);
  expect(unknown.value).toBeNull();
  expect(unknown.canDeliverBatch([{ callId: "call1", content: "tiny" }])).toBe(false);
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
