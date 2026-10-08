import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { encodeCompactionSummary } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import { estimateTokens } from "../src/lib/token-estimate";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const largeResult = `S8-EXACT-OLD-EVIDENCE ${"alpha beta gamma delta ".repeat(36_000)}`;

function nativeTurn(id: string) {
  return { internal_chat_message_metadata_passthrough: { turn_id: id } };
}

function request(turnId: string, input: unknown[], compaction = false): CodexParsedRequest {
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    reasoning: { effort: "high" },
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "s8_recovery_thread",
        turn_id: turnId,
        request_kind: compaction ? "compaction" : "turn",
      }),
    },
    input,
  });
  parsed._chatgptModelFamily = "5.6";
  return parsed;
}

function rawInput(parsed: CodexParsedRequest): unknown[] {
  return (parsed._rawBody as { input: unknown[] }).input;
}

function makeFixture() {
  const dir = mkdtempSync(join(process.platform === "win32" ? import.meta.dir : "/tmp", "s8-recovery-"));
  const statePath = join(dir, "semantic-epochs.json");
  const brokerSocketPath = join(dir, "broker.sock");
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://s8-recovery-${dir}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(dir, "launcher.json"),
      brokerSocketPath,
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
      experimentalSemanticMemory: true,
      semanticCheckpointStatePath: statePath,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const prompts: string[] = [];
  const keys: string[] = [];
  let ordinarySubmissions = 0;
  let retainedHandoffs = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    if (turn.compaction && turn.requireRetainedConversation) {
      retainedHandoffs += 1;
      const prepared = await turn.prepareResume!();
      const token = prepared.text.match(/turn_token (control_[a-f0-9]{32})/)?.[1];
      const handoffId = prepared.text.match(/handoff_id (handoff_[a-f0-9]{32})/)?.[1];
      prepared.release();
      if (!token || !handoffId) throw new Error("Missing fake retained compaction binding");
      await callTurnBroker(brokerSocketPath, {
        method: "submit_compaction_handoff",
        token,
        handoffId,
        summary: "S8 verified canonical compact summary",
      });
      return "Fake retained handoff acknowledged";
    }
    ordinarySubmissions += 1;
    const prepared = await turn.prepare();
    prompts.push(prepared.text);
    keys.push(turn.conversationKey ?? "missing");
    prepared.release();
    const answer = `S8 answer ${ordinarySubmissions}`;
    turn.onTextDelta(answer);
    return answer;
  };
  return {
    dir, statePath, provider, prompts, keys,
    get ordinarySubmissions() { return ordinarySubmissions; },
    get retainedHandoffs() { return retainedHandoffs; },
    async close() {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      chatGptTurnSessions.clear();
      await TurnBroker.forSocket(brokerSocketPath).close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seedOversizedHistory(fixture: ReturnType<typeof makeFixture>) {
  const environment = `<environment_context><cwd>${fixture.dir}</cwd><filesystem><workspace_roots><root>${fixture.dir}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
  const initialInput = [
    { type: "message", role: "developer", content: "S8-EARLY-AUTHORITY must remain exact." },
    { type: "message", role: "user", content: [{ type: "input_text", text: environment }], ...nativeTurn("s8_turn_1") },
    { type: "message", role: "user", id: "s8_user_1", content: "Begin the S8 source", ...nativeTurn("s8_turn_1") },
  ];
  const first = request("s8_turn_1", initialInput);
  const adapter = createChatGptWebAdapter(fixture.provider);
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(first, { headers: new Headers() }, event => events.push(event));
  expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  const secondInput = [
    ...initialInput,
    { type: "function_call", call_id: "s8_old_call", name: "exec_command", arguments: '{"cmd":"status"}' },
    { type: "function_call_output", call_id: "s8_old_call", output: largeResult },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "S8 answer 1" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: environment }], ...nativeTurn("s8_turn_2") },
    { type: "message", role: "user", id: "s8_user_2", content: "Continue after settled evidence", ...nativeTurn("s8_turn_2") },
  ];
  const second = request("s8_turn_2", secondInput);
  expect(estimateTokens(JSON.stringify(secondInput))).toBeGreaterThan(90_000);
  const secondEvents: AdapterEvent[] = [];
  await adapter.runTurn!(second, { headers: new Headers() }, event => secondEvents.push(event));
  expect(secondEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  expect(existsSync(fixture.statePath)).toBeTrue();
  expect(JSON.parse(readFileSync(fixture.statePath, "utf8")).epochs.s8_recovery_thread)
    .toMatchObject({ semanticEpoch: 1, modelFamily: "5.6", tier: 0 });
  return { second, environment };
}

test("S8: valid persisted epoch survives process restart with oversized canonical history", async () => {
  const fixture = makeFixture();
  try {
    const { second, environment } = await seedOversizedHistory(fixture);
    const originalEpoch = JSON.parse(readFileSync(fixture.statePath, "utf8")).epochs.s8_recovery_thread;
    const before = fixture.ordinarySubmissions;
    chatGptTurnSessions.clear(); // Simulate a new process with no live source or occupancy.
    const third = request("s8_turn_3", [
      ...rawInput(second),
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "S8 answer 2" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: environment }], ...nativeTurn("s8_turn_3") },
      { type: "message", role: "user", id: "s8_user_3", content: "Continue after restart", ...nativeTurn("s8_turn_3") },
    ]);
    const events: AdapterEvent[] = [];
    await createChatGptWebAdapter(fixture.provider).runTurn!(third, { headers: new Headers() }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
    expect(fixture.ordinarySubmissions).toBe(before + 1);
    expect(fixture.prompts.at(-1)).toContain("S8-EARLY-AUTHORITY");
    expect(fixture.prompts.at(-1)).toContain("Continue after restart");
    expect(fixture.prompts.at(-1)).toContain("[tool result omitted:");
    expect(fixture.prompts.at(-1)).not.toContain("S8-EXACT-OLD-EVIDENCE");
    expect(fixture.keys.at(-1)).not.toBe("missing");
    expect(JSON.parse(readFileSync(fixture.statePath, "utf8")).epochs.s8_recovery_thread.semanticEpoch)
      .toBeGreaterThanOrEqual(originalEpoch.semanticEpoch);
  } finally {
    await fixture.close();
  }
});

test("S8: ninth turn reuses a verified persisted epoch after restart at 220-240k canonical tokens", async () => {
  const fixture = makeFixture();
  const environment = `<environment_context><cwd>${fixture.dir}</cwd><filesystem><workspace_roots><root>${fixture.dir}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
  const settledResult = "alpha beta gamma delta ".repeat(7_000);
  let canonical: unknown[] = [
    { type: "message", role: "developer", content: "S8-RESTART-AUTHORITY must remain exact." },
  ];
  let persistedEpoch: number | undefined;
  try {
    const adapter = createChatGptWebAdapter(fixture.provider);
    for (let n = 1; n <= 9; n += 1) {
      if (n === 9) {
        persistedEpoch = JSON.parse(readFileSync(fixture.statePath, "utf8"))
          .epochs.s8_recovery_thread.semanticEpoch;
        expect(persistedEpoch).toBeGreaterThanOrEqual(3);
        chatGptTurnSessions.clear(); // Restart: persisted checkpoint remains, live source does not.
      }
      const id = `s8_long_turn_${n}`;
      const parsed = request(id, [
        ...canonical,
        { type: "message", role: "user", content: [{ type: "input_text", text: environment }], ...nativeTurn(id) },
        { type: "message", role: "user", id: `s8_long_user_${n}`, content: `Continue stage ${n}`, ...nativeTurn(id) },
      ]);
      if (n === 9) {
        const canonicalTokens = estimateTokens(JSON.stringify(rawInput(parsed)));
        expect(canonicalTokens).toBeGreaterThanOrEqual(220_000);
        expect(canonicalTokens).toBeLessThanOrEqual(240_000);
      }
      const events: AdapterEvent[] = [];
      await adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
      canonical = [
        ...rawInput(parsed),
        { type: "function_call", call_id: `s8_long_call_${n}`, name: "exec_command", arguments: '{"cmd":"status"}' },
        { type: "function_call_output", call_id: `s8_long_call_${n}`, output: `S8-OLD-EVIDENCE-${n} ${settledResult}` },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: `S8 answer ${n}` }] },
      ];
    }
    expect(fixture.ordinarySubmissions).toBe(9);
    expect(fixture.keys[8]).toBe(fixture.keys[7]); // No unverified epoch reseed after restart.
    expect(JSON.parse(readFileSync(fixture.statePath, "utf8"))
      .epochs.s8_recovery_thread.semanticEpoch).toBe(persistedEpoch);
    expect(fixture.prompts[8]).toContain("S8-RESTART-AUTHORITY");
    expect(fixture.prompts[8]).toContain("Continue stage 9");
    expect(fixture.prompts[8]).toContain("[tool result omitted:");
    expect(fixture.prompts[8]).not.toContain("S8-OLD-EVIDENCE-1 alpha beta gamma delta");
  } finally {
    await fixture.close();
  }
});

for (const state of ["missing", "corrupt"] as const) {
  test(`S8: ${state} epoch permits only exact same-process source; restart fails closed`, async () => {
    const fixture = makeFixture();
    try {
      const { second } = await seedOversizedHistory(fixture);
      const sourceKey = `${chatGptWebExecutionNamespace(fixture.provider)}:${chatGptTurnExecutionKey(second)}`;
      const source = chatGptTurnSessions.find(sourceKey);
      expect(source?.conversationKey()).toBeTruthy();
      // The fake worker has no launcher to release. Leave the exact retained source in memory.
      source!.runtime.releaseRetainedConversation = async () => {};
      if (state === "missing") rmSync(fixture.statePath);
      else writeFileSync(fixture.statePath, "{truncated epoch", "utf8");
      const compactInput = [...rawInput(second), { type: "compaction_trigger" }];
      const compact = request(`s8_compact_${state}`, compactInput, true);
      expect(compact._compactionRequest).toBeTrue();
      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(fixture.provider).runTurn!(compact, { headers: new Headers() }, event => events.push(event));
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
      expect(events.some(event => event.type === "text_delta"
        && event.text.includes("S8 verified canonical compact summary"))).toBeTrue();
      expect(fixture.retainedHandoffs).toBe(1);
      expect(fixture.ordinarySubmissions).toBe(2);

      // A new adapter process has neither the source session nor a usable checkpoint.
      chatGptTurnSessions.clear();
      if (state === "missing") rmSync(fixture.statePath, { force: true });
      else writeFileSync(fixture.statePath, "{truncated epoch", "utf8");
      const afterRestart = request(`s8_restart_${state}`, compactInput, true);
      const rejected: AdapterEvent[] = [];
      await createChatGptWebAdapter(fixture.provider).runTurn!(afterRestart, { headers: new Headers() }, event => rejected.push(event));
      expect(rejected.find(event => event.type === "error")).toMatchObject({
        type: "error", status: 409, code: "semantic_epoch_recovery_required", retryable: false,
      });
      expect(fixture.retainedHandoffs).toBe(1);
      expect(fixture.ordinarySubmissions).toBe(2);
      if (state === "corrupt") {
        expect(readdirSync(fixture.dir).some(name => name.startsWith("semantic-epochs.json.corrupt-"))).toBeTrue();
      }
    } finally {
      await fixture.close();
    }
  });
}

test("S8: explicit canonical compact allows legacy downgrade without the oversized prefix", async () => {
  const fixture = makeFixture();
  try {
    const { second, environment } = await seedOversizedHistory(fixture);
    const sourceKey = `${chatGptWebExecutionNamespace(fixture.provider)}:${chatGptTurnExecutionKey(second)}`;
    chatGptTurnSessions.find(sourceKey)!.runtime.releaseRetainedConversation = async () => {};
    const compact = request("s8_downgrade_compact", [...rawInput(second), { type: "compaction_trigger" }], true);
    const compactEvents: AdapterEvent[] = [];
    await createChatGptWebAdapter(fixture.provider).runTurn!(compact, { headers: new Headers() }, event => compactEvents.push(event));
    expect(compactEvents.at(-1)).toMatchObject({ type: "done" });
    const summary = compactEvents.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> =>
      event.type === "text_delta").map(event => event.text).join("");
    expect(summary).toContain("S8 verified canonical compact summary");
    expect(fixture.retainedHandoffs).toBe(1);

    chatGptTurnSessions.clear();
    const legacyProvider: CodexProviderConfig = {
      ...fixture.provider,
      chatgptWeb: { ...fixture.provider.chatgptWeb, experimentalSemanticMemory: false },
    };
    const followup = request("s8_downgraded_turn", [
      { type: "message", role: "developer", content: "S8-EARLY-AUTHORITY must remain exact." },
      { type: "compaction", encrypted_content: encodeCompactionSummary(summary) },
      { type: "message", role: "user", content: [{ type: "input_text", text: environment }], ...nativeTurn("s8_downgraded_turn") },
      { type: "message", role: "user", id: "s8_downgrade_user", content: "Continue with legacy after verified compact", ...nativeTurn("s8_downgraded_turn") },
    ]);
    const events: AdapterEvent[] = [];
    await createChatGptWebAdapter(legacyProvider).runTurn!(followup, { headers: new Headers() }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
    expect(fixture.ordinarySubmissions).toBe(3);
    expect(fixture.prompts.at(-1)).toContain("Continue with legacy after verified compact");
    expect(fixture.prompts.at(-1)).toContain("S8 verified canonical compact summary");
    expect(fixture.prompts.at(-1)).not.toContain("S8-EXACT-OLD-EVIDENCE");
  } finally {
    await fixture.close();
  }
});
