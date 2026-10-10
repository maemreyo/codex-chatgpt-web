import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { SemanticCostCaps } from "../src/adapters/chatgpt-web/semantic-cost-caps";
import { ChatGptSemanticEpochStore } from "../src/adapters/chatgpt-web/semantic-epoch-store";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "sem-s8-matrix-"));
  const threadId = `s8_matrix_${basename(dir)}`;
  const statePath = join(dir, "semantic-epochs.json");
  const brokerSocketPath = join(dir, "broker.sock");
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `browser://s8-matrix-${dir}`,
    chatgptWeb: {
      browserHost: "launcher", browserHostDescriptorPath: join(dir, "launcher.json"),
      brokerSocketPath, localToolsEnabled: true,
      solAvailable: true, extraHighAvailable: true, proAvailable: true,
      experimentalSemanticMemory: true, semanticCheckpointStatePath: statePath,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const prompts: string[] = [];
  const ownedExecutionKeys = new Set<string>();
  let submissions = 0;
  let fakeRun = async (turn: BrowserTurn) => {
    submissions++;
    const prepared = await turn.prepare();
    prompts.push(prepared.text);
    prepared.release();
    const answer = `S8 fake answer ${submissions}`;
    turn.onTextDelta(answer);
    return answer;
  };
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = turn => fakeRun(turn);
  const environment = `<environment_context><cwd>${dir}</cwd><filesystem><workspace_roots><root>${dir}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
  const nativeTurnId = (id: string) => `${threadId}:${id}`;
  const nativeTurn = (id: string) => ({ internal_chat_message_metadata_passthrough: { turn_id: nativeTurnId(id) } });
  const initial: unknown[] = [
    { type: "message", role: "developer", content: "S8-KEEP-EXACT-DEVELOPER-AUTHORITY" },
  ];
  const request = (turnId: string, input: unknown[], compaction = false, withTools = false): CodexParsedRequest => {
    const parsed = parseRequest({
      model: CHATGPT_WEB_MODEL_ID, stream: true, reasoning: { effort: "high" },
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: threadId, turn_id: nativeTurnId(turnId), request_kind: compaction ? "compaction" : "turn",
      }) },
      ...(withTools ? { tools: [{ type: "function", name: "exec_command", description: "Fake tool",
        parameters: { type: "object" } }] } : {}),
      input,
    });
    parsed._chatgptModelFamily = "5.6";
    return parsed;
  };
  const extend = (canonical: unknown[], id: string): unknown[] => [
    ...canonical,
    { type: "message", role: "user", content: [{ type: "input_text", text: environment }], ...nativeTurn(id) },
    { type: "message", role: "user", id: `${threadId}:user_${id}`, content: `S8 instruction ${id}`, ...nativeTurn(id) },
  ];
  const run = async (parsed: CodexParsedRequest) => {
    const events: AdapterEvent[] = [];
    if (!parsed._compactionRequest) {
      ownedExecutionKeys.add(`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`);
    }
    await createChatGptWebAdapter(provider).runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    return events;
  };
  const restart = async () => {
    for (const key of ownedExecutionKeys) await chatGptTurnSessions.retireAndWait(key);
    ownedExecutionKeys.clear();
  };
  return {
    dir, threadId, statePath, brokerSocketPath, provider, prompts, initial,
    request, extend, run, restart,
    setWorkerRun(run: (turn: BrowserTurn) => Promise<string>) { fakeRun = run; },
    get submissions() { return submissions; },
    epoch() { return JSON.parse(readFileSync(statePath, "utf8")).epochs[threadId]; },
    async close() {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await restart();
      await TurnBroker.forSocket(brokerSocketPath).close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function expectAdapterErrorEvent(
  run: () => Promise<AdapterEvent[]>,
  expected: { status: number; code: string; retryable: boolean },
): Promise<AdapterEvent[]> {
  // The adapter emits typed errors for both pre-runtime guards and compaction
  // handoff failures. Its public runTurn promise must resolve in these cases.
  const events = await run();
  const errors = events.filter(event => event.type === "error");
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ type: "error", ...expected });
  expect(events.at(-1)).toMatchObject({ type: "error", ...expected });
  expect(events.some(event => event.type === "done" || event.type === "tool_call_start")).toBeFalse();
  return events;
}

test("S8 fixture isolation: one native restart does not retire another test thread", async () => {
  const first = makeHarness();
  const second = makeHarness();
  try {
    expect(first.threadId).not.toBe(second.threadId);
    expect(first.statePath).not.toBe(second.statePath);
    expect(first.brokerSocketPath).not.toBe(second.brokerSocketPath);
    const a = first.request("same_turn_label", first.extend(first.initial, "same_turn_label"));
    const b = second.request("same_turn_label", second.extend(second.initial, "same_turn_label"));
    expect(chatGptTurnExecutionKey(a)).not.toBe(chatGptTurnExecutionKey(b));
    expect((await first.run(a)).at(-1)).toMatchObject({ type: "done" });
    expect((await second.run(b)).at(-1)).toMatchObject({ type: "done" });
    const firstKey = `${chatGptWebExecutionNamespace(first.provider)}:${chatGptTurnExecutionKey(a)}`;
    const secondKey = `${chatGptWebExecutionNamespace(second.provider)}:${chatGptTurnExecutionKey(b)}`;
    expect(chatGptTurnSessions.find(firstKey)).toBeDefined();
    const untouched = chatGptTurnSessions.find(secondKey);
    expect(untouched).toBeDefined();
    await first.restart();
    expect(chatGptTurnSessions.find(firstKey)).toBeUndefined();
    expect(chatGptTurnSessions.find(secondKey)).toBe(untouched);
  } finally {
    await first.close();
    await second.close();
  }
});

test("S8 physical cap exhaustion: fifth rotation cannot bypass occupied epoch or retry into another submission", async () => {
  const f = makeHarness();
  let canonical = f.initial;
  try {
    // Completed-turn evidence grows beyond the legacy budget; rotations occur at
    // turns 2/4/6/8, with one cooldown reuse between each committed epoch.
    let latest: CodexParsedRequest | undefined;
    for (let stage = 1; stage <= 9; stage++) {
      const id = `stage_${stage}`;
      const input = f.extend(canonical, id);
      latest = f.request(id, input);
      expect((await f.run(latest)).at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
      canonical = [
        ...input,
        { type: "function_call", call_id: `old_${stage}`, name: "exec_command", arguments: '{"cmd":"status"}' },
        { type: "function_call_output", call_id: `old_${stage}`,
          output: `S8-EXACT-OLD-EVIDENCE-${stage} ${"alpha beta gamma delta ".repeat(5_500)}` },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: `S8 fake answer ${stage}` }] },
      ];
    }
    expect(f.submissions).toBe(9);
    expect(f.epoch()).toMatchObject({ semanticEpoch: 4, tier: 0 });
    const costKey = f.threadId;
    const caps = new SemanticCostCaps(Date.now, 4, 4, join(f.dir, "semantic-cost-caps.json"));
    expect(caps.count(costKey)).toBe(4);
    const persisted = readFileSync(f.statePath, "utf8");

    // The fourth retained epoch has insufficient physical room for another
    // browser request. The fifth rotation is prohibited by the rolling cap.
    const source = chatGptTurnSessions.find(
      `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(latest!)}`,
    );
    const occupancy = source?.runtime.semanticOccupancy;
    expect(occupancy?.confidence).toBe("known");
    if (!occupancy || occupancy.value === null) throw new Error("Missing retained semantic occupancy");
    occupancy.record("fake-physical-pressure", Math.max(0, occupancy.physicalLimit - occupancy.value - 1_000));
    const blocked = f.request("stage_10", f.extend(canonical, "stage_10"));
    const before = f.submissions;
    const pressureError = { status: 409, code: "semantic_epoch_recovery_required", retryable: false };
    const first = await expectAdapterErrorEvent(() => f.run(blocked), pressureError);
    expect(await expectAdapterErrorEvent(() => f.run(blocked), pressureError)).toEqual(first);
    expect(f.submissions).toBe(before);
    expect(readFileSync(f.statePath, "utf8")).toBe(persisted);
    expect(caps.count(costKey)).toBe(4);
  } finally {
    await f.close();
  }
}, 20_000);

test("S8 restart rejects checkpoint whose covered-history digest no longer matches canonical evidence", async () => {
  const f = makeHarness();
  try {
    const first = f.extend(f.initial, "original");
    expect((await f.run(f.request("original", first))).at(-1)).toMatchObject({ type: "done" });
    const oldEvidence = `S8-PRESERVE-THIS-RESULT ${"alpha beta gamma delta ".repeat(36_000)}`;
    const secondInput = f.extend([
      ...first,
      { type: "function_call", call_id: "original_call", name: "exec_command", arguments: '{"cmd":"status"}' },
      { type: "function_call_output", call_id: "original_call", output: oldEvidence },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "S8 fake answer 1" }] },
    ], "second");
    expect((await f.run(f.request("second", secondInput))).at(-1)).toMatchObject({ type: "done" });
    expect(f.epoch().semanticEpoch).toBe(1);
    const checkpointBytes = readFileSync(f.statePath, "utf8");
    const previous = f.epoch();
    const before = f.submissions;

    // Restart removes the only live locator. A changed result is not covered
    // by the persisted digest even though the epoch file itself is valid JSON.
    await f.restart();
    const third = f.extend([
      ...secondInput.map(item => (item as { type?: string }).type === "function_call_output"
        ? { ...(item as Record<string, unknown>), output: oldEvidence.replace("PRESERVE", "MUTATED") }
        : item),
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "S8 fake answer 2" }] },
    ], "third");
    await expectAdapterErrorEvent(() => f.run(f.request("third", third)), {
      status: 409, code: "semantic_epoch_recovery_required", retryable: false,
    });
    expect(f.submissions).toBe(before);
    // A mismatched canonical digest invalidates the persisted epoch exactly
    // once. Durable quarantine replaces the unsafe checkpoint; it must not
    // silently regenerate another epoch from the mutated native history.
    const quarantinedBytes = readFileSync(f.statePath, "utf8");
    expect(quarantinedBytes).not.toBe(checkpointBytes);
    const persisted = JSON.parse(quarantinedBytes) as {
      epochs: Record<string, unknown>;
      quarantines: Record<string, { reason: string; semanticEpoch: number }>;
    };
    expect(persisted.epochs[f.threadId]).toBeUndefined();
    expect(persisted.quarantines[f.threadId]).toMatchObject({
      reason: "digest_mismatch", semanticEpoch: previous.semanticEpoch,
    });
    const restartedStore = new ChatGptSemanticEpochStore(f.statePath);
    expect(restartedStore.isQuarantined(f.threadId)).toBeTrue();
    expect(restartedStore.get(f.threadId)).toBeUndefined();
    await expectAdapterErrorEvent(() => f.run(f.request("third", third)), {
      status: 409, code: "semantic_epoch_recovery_required", retryable: false,
    });
    expect(f.submissions).toBe(before);
    expect(readFileSync(f.statePath, "utf8")).toBe(quarantinedBytes);
  } finally {
    await f.close();
  }
}, 15_000);

test("S8 interrupted tool and lost locator: oversized compaction fails before any duplicate result delivery", async () => {
  const f = makeHarness();
  const broker = TurnBroker.forSocket(f.brokerSocketPath);
  const originalComplete = broker.completeTool.bind(broker);
  const delivered: string[] = [];
  broker.completeTool = (token, callId, result) => {
    delivered.push(callId);
    originalComplete(token, callId, result);
  };
  let pendingInvocation: Promise<BrokerToolResult> | undefined;
  let attemptedCompactions = 0;
  try {
    const first = f.extend(f.initial, "seed");
    expect((await f.run(f.request("seed", first))).at(-1)).toMatchObject({ type: "done" });
    const activeInput = f.extend([
      ...first,
      { type: "function_call", call_id: "settled_old_call", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "settled_old_call",
        output: `S8-LARGE-SETTLED-EVIDENCE ${"alpha beta gamma delta ".repeat(36_000)}` },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "S8 fake answer 1" }] },
    ], "active");

    f.setWorkerRun(async turn => {
      if (turn.compaction) {
        attemptedCompactions++;
        throw new Error("No retained source or verified checkpoint: browser must never be called");
      }
      const prepared = await turn.prepare();
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      prepared.release();
      if (!token) throw new Error("Missing tool binding in fake browser");
      await turn.onSubmitted?.();
      const claim = await callTurnBroker<{ bindingId: string }>(f.brokerSocketPath, {
        method: "claim", token,
      });
      const progress = turn.externalProgress;
      if (!progress) throw new Error("Missing tool progress boundary");
      const before = progress.snapshot().lastToolBatchRevision;
      pendingInvocation = callTurnBroker<BrokerToolResult>(f.brokerSocketPath, {
        method: "invoke", bindingId: claim.bindingId, wireName: "exec_command",
        arguments: { cmd: "S8-original-tool-execution" },
      }, null);
      void pendingInvocation.catch(() => {}); // Expected retirement after the simulated process loss.
      let snapshot = progress.snapshot();
      while (snapshot.lastToolBatchRevision <= before) {
        snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
      }
      await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
      const signal = turn.abortSignal;
      if (!signal) throw new Error("Expected abortable native tool browser");
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Original browser interrupted")),
          { once: true });
      });
    });
    const active = f.request("active", activeInput, false, true);
    const events = await f.run(active);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
    const starts = events.filter((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> =>
      event.type === "tool_call_start");
    expect(starts).toHaveLength(1);
    const callId = starts[0]!.id;
    const source = chatGptTurnSessions.find(
      `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(active)}`,
    );
    expect(source?.outstanding().map(tool => tool.callId)).toEqual([callId]);
    expect(f.epoch().semanticEpoch).toBe(1);

    // Retain the complete exact pending result in canonical input. There is no
    // longer an addressable browser session or valid persisted epoch after restart.
    const originalResult = "S8-CALL-RESULT-MUST-NOT-BE-LOST";
    const compact = f.request("compaction_after_restart", [
      ...activeInput,
      { type: "function_call", call_id: callId, name: "exec_command",
        arguments: '{"cmd":"S8-original-tool-execution"}' },
      { type: "function_call_output", call_id: callId, output: originalResult },
      { type: "compaction_trigger" },
    ], true, true);
    expect(compact._compactionRequest).toBeTrue();
    await f.restart();
    rmSync(f.statePath);
    const failure = { status: 409, code: "semantic_epoch_recovery_required", retryable: false };
    const rejected = await expectAdapterErrorEvent(() => f.run(compact), failure);
    expect(await expectAdapterErrorEvent(() => f.run(compact), failure)).toEqual(rejected);
    expect(attemptedCompactions).toBe(0);
    expect(delivered).toEqual([]);
  } finally {
    broker.completeTool = originalComplete;
    await f.close();
  }
}, 15_000);

test("S8 restart rejects well-formed JSON with invalid epoch schema without rewriting persisted evidence", async () => {
  const f = makeHarness();
  try {
    const first = f.extend(f.initial, "original");
    expect((await f.run(f.request("original", first))).at(-1)).toMatchObject({ type: "done" });
    const second = f.extend([
      ...first,
      { type: "function_call", call_id: "old", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "old", output: `old ${"alpha beta gamma delta ".repeat(36_000)}` },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "S8 fake answer 1" }] },
    ], "second");
    expect((await f.run(f.request("second", second))).at(-1)).toMatchObject({ type: "done" });
    const state = JSON.parse(readFileSync(f.statePath, "utf8"));
    state.epochs[f.threadId].tier = 99;
    const damaged = `${JSON.stringify(state)}\n`;
    writeFileSync(f.statePath, damaged);
    await f.restart();
    const before = f.submissions;
    // Direct store access throws. The adapter wraps that same typed failure
    // into exactly one public error event, rather than rejecting runTurn.
    const expected = { status: 409, code: "semantic_epoch_state_invalid", retryable: false };
    expect(() => new ChatGptSemanticEpochStore(f.statePath).get(f.threadId, true))
      .toThrow("invalid epoch records");
    const events = await expectAdapterErrorEvent(
      () => f.run(f.request("third", f.extend(second, "third"))), expected,
    );
    expect(events.find(event => event.type === "error")).toMatchObject(expected);
    expect(f.submissions).toBe(before);
    expect(readFileSync(f.statePath, "utf8")).toBe(damaged);
  } finally {
    await f.close();
  }
}, 15_000);
