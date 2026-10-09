import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { estimateTokens } from "../src/lib/token-estimate";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { semanticEpochOccupancies } from "../src/adapters/chatgpt-web/semantic-occupancy";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

const root = join(tmpdir(), `semantic-adapter-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function brokerEndpoint(name: string): string {
  return process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), name), "win32")
    : join(tmpdir(), `${name}.sock`);
}

const environmentXml = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;

function turn(turnId: string) {
  return { internal_chat_message_metadata_passthrough: { turn_id: turnId } };
}

function request(turnId: string, input: unknown[]): CodexParsedRequest {
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    reasoning: { effort: "high" },
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_semantic_adapter", turn_id: turnId, request_kind: "turn" }),
    },
    input,
  });
  parsed._chatgptModelFamily = "5.6";
  return parsed;
}

function rawInput(parsed: CodexParsedRequest): unknown[] {
  const input = (parsed._rawBody as { input?: unknown } | undefined)?.input;
  if (!Array.isArray(input)) throw new Error("semantic adapter fixture requires raw input");
  return input;
}

test("hidden semantic mode rotates between completed native turns without an extra browser submission", async () => {
  const socketPath = brokerEndpoint(`semantic-adapter-${process.pid}-${Date.now()}`);
  const statePath = join(root, `semantic-epochs-${Date.now()}.json`);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://semantic-adapter-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
      experimentalSemanticMemory: true,
      experimentalBiggerContext: true,
      semanticCheckpointStatePath: statePath,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const prompts: string[] = [];
  const keys: string[] = [];
  const hasSizeRejectionHook: boolean[] = [];
  const restartedFullCharges: Array<{ ledger: number | null; actual: number }> = [];
  let browserSubmissions = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserSubmissions += 1;
    hasSizeRejectionHook.push(typeof turn.onSizeRejection === "function");
    const prepared = await turn.prepare();
    if ((browserSubmissions === 2 || browserSubmissions === 3) && turn.conversationKey) {
      // Same semantic epoch key, but the launcher lost its physical tab before
      // the third request. The full projection must replace the old occupancy.
      await turn.onPreparedSelected?.(false);
      await turn.onSubmitted?.();
      const ledger = semanticEpochOccupancies.forConversation(
        turn.conversationKey, false, 240_000, turn.modelId,
      );
      restartedFullCharges.push({
        ledger: ledger.value,
        actual: estimateCompiledChatGptWebInputTokens(prepared, turn.modelId),
      });
    }
    prompts.push(prepared.text);
    keys.push(turn.conversationKey ?? "missing");
    prepared.release();
    const answer = `Semantic answer ${browserSubmissions}`;
    turn.onTextDelta(answer);
    return answer;
  };

  const firstInput = [
    { type: "message", role: "developer", content: "Keep repository policy exact." },
    { type: "message", role: "user", content: [{ type: "input_text", text: environmentXml }], ...turn("turn_1") },
    { type: "message", role: "user", id: "user_1", content: "Inspect the project", ...turn("turn_1") },
    { type: "function_call", call_id: "call_old", name: "exec_command", arguments: JSON.stringify({ cmd: "git status --short" }) },
    { type: "function_call_output", call_id: "call_old", output: `OLD-SECRET-BODY ${"x".repeat(5000)}` },
  ];
  const first = request("turn_1", firstInput);
  const second = request("turn_2", [
    ...structuredClone(firstInput),
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Semantic answer 1" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: environmentXml }], ...turn("turn_2") },
    { type: "message", role: "user", id: "user_2", content: "Continue after the completed turn", ...turn("turn_2") },
  ]);
  const third = request("turn_3", [
    ...structuredClone(rawInput(second)),
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Semantic answer 2" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: environmentXml }], ...turn("turn_3") },
    { type: "message", role: "user", id: "user_3", content: "Continue through the cooldown", ...turn("turn_3") },
  ]);
  const fourth = request("turn_4", [
    ...structuredClone(rawInput(third)),
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Semantic answer 3" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: environmentXml }], ...turn("turn_4") },
    { type: "message", role: "user", id: "user_4", content: "Continue after the cooldown", ...turn("turn_4") },
  ]);

  try {
    const adapter = createChatGptWebAdapter(provider);
    await adapter.runTurn!(first, { headers: new Headers() }, () => {});
    await adapter.runTurn!(second, { headers: new Headers() }, () => {});
    await adapter.runTurn!(third, { headers: new Headers() }, () => {});
    await adapter.runTurn!(fourth, { headers: new Headers() }, () => {});

    expect(browserSubmissions).toBe(4);
    expect(keys[0]).not.toBe("missing");
    expect(keys[1]).not.toBe("missing");
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[1]);
    expect(keys[3]).not.toBe(keys[2]);
    expect(restartedFullCharges).toHaveLength(2);
    expect(restartedFullCharges[0].ledger).toBeGreaterThanOrEqual(restartedFullCharges[0].actual - 100);
    expect(restartedFullCharges[1].ledger).toBeGreaterThanOrEqual(restartedFullCharges[1].actual - 100);
    expect(restartedFullCharges[1].ledger).toBeLessThan(
      restartedFullCharges[0].ledger! + restartedFullCharges[1].actual,
    );
    expect(hasSizeRejectionHook).toEqual([true, true, true, true]);
    expect(prompts[0]).toContain("OLD-SECRET-BODY");
    expect(prompts[1]).toContain("[tool result omitted: tool=exec_command");
    expect(prompts[1]).not.toContain("OLD-SECRET-BODY");
    expect(prompts[1]).toContain("Keep repository policy exact.");
    expect(prompts[1]).toContain("Continue after the completed turn");
    expect(prompts[1]).toContain("<semantic_artifact_ledger");
    expect(prompts[2]).toContain("Continue through the cooldown");
    expect(prompts[2]).not.toContain("OLD-SECRET-BODY");
    expect(prompts[3]).toContain("Continue after the cooldown");
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(socketPath).close();
  }
});

test("an existing native-turn session bypasses semantic reseed preflight on an exact replay", async () => {
  const socketPath = brokerEndpoint(`semantic-replay-${process.pid}-${Date.now()}`);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://semantic-replay-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
      experimentalSemanticMemory: true,
      semanticCheckpointStatePath: join(root, `semantic-replay-epochs-${Date.now()}.json`),
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserSubmissions = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserSubmissions += 1;
    const prepared = await turn.prepare();
    prepared.release();
    turn.onTextDelta("Replay-safe answer");
    return "Replay-safe answer";
  };

  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: environmentXml }], ...turn("turn_replay") },
    { type: "message", role: "user", id: "user_replay", content: "Keep this native turn alive", ...turn("turn_replay") },
  ];
  const initial = request("turn_replay", input);
  const replay = request("turn_replay", [
    ...structuredClone(input),
    { type: "message", role: "developer", content: "x".repeat(500_000), ...turn("turn_replay") },
  ]);

  try {
    const adapter = createChatGptWebAdapter(provider);
    await adapter.runTurn!(initial, { headers: new Headers() }, () => {});
    await adapter.runTurn!(replay, { headers: new Headers() }, () => {});
    expect(browserSubmissions).toBe(1);
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(socketPath).close();
  }
});

test("canonical history reaches the guarded 220-240k target across multiple physically bounded epochs", async () => {
  const socketPath = brokerEndpoint(`semantic-long-${process.pid}-${Date.now()}`);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://semantic-long-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
      experimentalSemanticMemory: true,
      semanticCheckpointStatePath: join(root, `semantic-long-epochs-${Date.now()}.json`),
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const keys: string[] = [];
  const prompts: string[] = [];
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async browserTurn => {
    const prepared = await browserTurn.prepare();
    keys.push(browserTurn.conversationKey ?? "missing");
    prompts.push(prepared.text);
    prepared.release();
    const answer = `Long-run answer ${keys.length}`;
    browserTurn.onTextDelta(answer);
    return answer;
  };

  const largeSettledResult = "alpha beta gamma delta ".repeat(7_000);
  let canonical: unknown[] = [
    { type: "message", role: "developer", content: "KEEP-EARLY-AUTHORITY-SENTINEL exactly." },
  ];
  let lastCanonicalTokens = 0;
  try {
    const adapter = createChatGptWebAdapter(provider);
    for (let n = 1; n <= 9; n += 1) {
      const id = `long_turn_${n}`;
      const parsed = request(id, [
        ...canonical,
        { type: "message", role: "user", content: [{ type: "input_text", text: environmentXml }], ...turn(id) },
        { type: "message", role: "user", id: `long_user_${n}`, content: `Continue verified stage ${n}`, ...turn(id) },
      ]);
      lastCanonicalTokens = estimateTokens(JSON.stringify(rawInput(parsed)));
      await adapter.runTurn!(parsed, { headers: new Headers() }, () => {});
      canonical = [...rawInput(parsed),
        { type: "function_call", call_id: `long_call_${n}`, name: "exec_command", arguments: '{"cmd":"status"}' },
        { type: "function_call_output", call_id: `long_call_${n}`, output: `EVIDENCE-${n} ${largeSettledResult}` },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: `Long-run answer ${n}` }] },
      ];
    }
    expect(lastCanonicalTokens).toBeGreaterThanOrEqual(220_000);
    expect(lastCanonicalTokens).toBeLessThanOrEqual(240_000);
    expect(keys).toHaveLength(9);
    expect(new Set(keys).size).toBeGreaterThanOrEqual(4);
    expect(prompts.every(prompt => prompt.includes("KEEP-EARLY-AUTHORITY-SENTINEL"))).toBe(true);
    expect(prompts.slice(1).some(prompt => prompt.includes("[tool result omitted:"))).toBe(true);
    expect(prompts.at(-1)).not.toContain("EVIDENCE-1 alpha beta gamma delta");
    expect(prompts.at(-1)).toContain("Continue verified stage 9");
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(socketPath).close();
  }
}, 20_000);
