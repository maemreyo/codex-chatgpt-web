import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { CHATGPT_WEB_BACKEND_MODEL, resolveChatGptWebContextLimits,
  resolveChatGptWebPhysicalContextLimits } from "../src/chatgpt-web-models";
import { defaultConfig } from "../src/config";
import { estimateTokens } from "../src/lib/token-estimate";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { parseRequest } from "../src/responses/parser";
import { semanticLogReport } from "../scripts/semantic-log-report";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

// Deliberately small, fixed fake workload. These are test acceptance bounds, not
// runtime rolling-hour caps, model billing, or measured account usage.
const NATIVE_TURNS = 6;
const MAX_FAKE_EXTRA_SUBMISSIONS_PER_100_TURNS = 0;
const MAX_FAKE_INPUT_OVERHEAD_PER_100_TURNS = 100_000;
const SETTLED_TOOL_BODY = `TOOL-CONTENT-DO-NOT-LOG ${"alpha beta gamma delta ".repeat(160)}`;
const FIXED_ENVIRONMENT = `<environment_context><cwd>/virtual/s8-stock-cost</cwd>`
  + `<filesystem><workspace_roots><root>/virtual/s8-stock-cost</root></workspace_roots>`
  + `<permission_profile type="disabled"><file_system type="unrestricted" />`
  + `</permission_profile></filesystem></environment_context>`;

function stableFakePrompt(text: string, fixtureDir: string): string {
  // Browser control IDs and sandbox paths are fresh every replay; they do not
  // represent workload tokens. Normalize them before comparing token estimates.
  return text.replaceAll(fixtureDir, "/virtual/s8-harness")
    .replace(/\b(?:control|turn|handoff|binding)_[a-f0-9]{20,}\b/g, "control_FIXED_ID");
}

function nativeTurn(id: string) {
  return { internal_chat_message_metadata_passthrough: { turn_id: id } };
}

function makeRequest(turnId: string, input: unknown[]): CodexParsedRequest {
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    reasoning: { effort: "high" },
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "s8_stock_cost_thread", turn_id: turnId, request_kind: "turn",
      }),
    },
    input,
  });
  parsed._chatgptModelFamily = "5.6";
  return parsed;
}

type FakeReplay = {
  browserSubmissions: number;
  nativeTurnsCompleted: number;
  estimatedSubmittedInputTokens: number;
  epochs: string[];
  semanticLines: string[];
};

async function fakeReplay(semanticEnabled: boolean): Promise<FakeReplay> {
  const dir = mkdtempSync(join(tmpdir(), "s8-stock-cost-"));
  const socketPath = join(dir, "broker.sock");
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://s8-stock-cost-${dir}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(dir, "launcher.json"),
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
      experimentalSemanticMemory: semanticEnabled,
      semanticCheckpointStatePath: join(dir, "semantic-epochs.json"),
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const semanticLines: string[] = [];
  const epochs: string[] = [];
  let browserSubmissions = 0;
  let nativeTurnsCompleted = 0;
  let estimatedSubmittedInputTokens = 0;
  const info = spyOn(console, "info").mockImplementation((...args) => {
    for (const value of args) {
      if (typeof value === "string" && value.startsWith('{"event":"semantic_')) semanticLines.push(value);
    }
  });
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserSubmissions += 1;
    const prepared = await turn.prepare();
    try {
      estimatedSubmittedInputTokens += estimateTokens(stableFakePrompt(prepared.text, dir));
      epochs.push(turn.conversationKey ?? "none");
    } finally {
      prepared.release();
    }
    const answer = `Fixed fake answer ${browserSubmissions}`;
    turn.onTextDelta(answer);
    return answer;
  };

  const history: unknown[] = [{ type: "message", role: "developer", content: "Preserve early developer authority." }];
  try {
    const adapter = createChatGptWebAdapter(provider);
    for (let turn = 1; turn <= NATIVE_TURNS; turn += 1) {
      const id = `s8_cost_turn_${turn}`;
      history.push(
        { type: "message", role: "user", content: [{ type: "input_text", text: FIXED_ENVIRONMENT }], ...nativeTurn(id) },
        { type: "message", role: "user", id: `s8_cost_user_${turn}`, content: `Complete fixed step ${turn}`, ...nativeTurn(id) },
        { type: "function_call", call_id: `s8_cost_call_${turn}`, name: "exec_command", arguments: '{"cmd":"status"}' },
        { type: "function_call_output", call_id: `s8_cost_call_${turn}`, output: SETTLED_TOOL_BODY },
      );
      const events: Array<{ type: string; stopReason?: string }> = [];
      await adapter.runTurn!(makeRequest(id, structuredClone(history)), { headers: new Headers() },
        event => events.push(event));
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
      nativeTurnsCompleted += 1;
      history.push({ type: "message", role: "assistant",
        content: [{ type: "output_text", text: `Fixed fake answer ${turn}` }] });
    }
    return { browserSubmissions, nativeTurnsCompleted, estimatedSubmittedInputTokens, epochs, semanticLines };
  } finally {
    info.mockRestore();
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(socketPath).close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("S8 fake legacy vs Tier 0 SEM: bounded added work, real cost events and rotation cooldown", async () => {
  const legacy = await fakeReplay(false);
  const sem = await fakeReplay(true);
  expect(legacy.nativeTurnsCompleted).toBe(NATIVE_TURNS);
  expect(sem.nativeTurnsCompleted).toBe(NATIVE_TURNS);
  expect(legacy.browserSubmissions).toBe(NATIVE_TURNS);
  expect(sem.browserSubmissions).toBe(NATIVE_TURNS);
  expect(legacy.semanticLines).toEqual([]);

  const dir = mkdtempSync(join(tmpdir(), "s8-cost-report-"));
  try {
    const logPath = join(dir, "launcher.jsonl");
    writeFileSync(logPath, sem.semanticLines.join("\n") + "\n", "utf8");
    const report = semanticLogReport(logPath);
    const cost = report.loggedCost;
    // The first native turn has no completed earlier turn to rotate or charge.
    expect(report.turns).toBe(NATIVE_TURNS - 1);
    expect(cost.samples).toBe(NATIVE_TURNS - 1);
    expect(cost.legacyEquivalentSubmissions + 1).toBe(legacy.browserSubmissions);
    expect(cost.epochRotations).toBe(report.rotations);
    expect(cost.epochRotations).toBe(3); // turns 2, 4, 6, with one intervening reuse
    expect(report.skipsByReason.cooldown).toBe(2);
    expect(new Set(sem.epochs).size).toBe(1 + cost.epochRotations);
    expect(cost.reseedInputTokensEst).toBeGreaterThan(0);
    expect(cost.checkpointTailRequests).toBe(0); // V1 Tier 0 has no private tail
    expect(cost.checkpointTailTokensEst).toBe(0);
    expect(cost.webCompactionSubmissions).toBe(0);
    expect(cost.extraStageSubmissions).toBe(0);
    expect(cost.discardedTails).toBe(0);
    expect(cost.additionalSubmissionsPer100Legacy).toBe(0);
    expect(JSON.stringify(report)).not.toContain("TOOL-CONTENT-DO-NOT-LOG");
    expect(sem.semanticLines.join("\n")).not.toContain("TOOL-CONTENT-DO-NOT-LOG");

    const extraSubmissionsPer100Turns = 100 * (sem.browserSubmissions - legacy.browserSubmissions) / NATIVE_TURNS;
    const extraEstimatedInputTokensPer100Turns = 100 *
      (sem.estimatedSubmittedInputTokens - legacy.estimatedSubmittedInputTokens) / NATIVE_TURNS;
    expect(extraSubmissionsPer100Turns).toBeLessThanOrEqual(MAX_FAKE_EXTRA_SUBMISSIONS_PER_100_TURNS);
    expect(extraEstimatedInputTokensPer100Turns).toBeLessThanOrEqual(MAX_FAKE_INPUT_OVERHEAD_PER_100_TURNS);
    // The tokenizer sees a few variable runtime markers, so report the estimate
    // rounded to 1k tokens; the acceptance assertion above uses the raw count.
    console.log(JSON.stringify({ fixture: "S8 fake six-turn replay", extraSubmissionsPer100Turns,
      extraEstimatedInputTokensPer100TurnsRounded1k:
        Math.round(extraEstimatedInputTokensPer100Turns / 1_000) * 1_000, rotations: report.rotations,
      cooldownSkips: report.skipsByReason.cooldown }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S8 stock flags are independently off and the default model catalog is unchanged", () => {
  for (const mode of ["browser-only", "full"] as const) {
    const config = defaultConfig(mode);
    expect(config).toMatchObject({
      experimentalSemanticMemory: false,
      experimentalWebCompactor: false,
      experimentalSemanticLogicalWindow: false,
    });
  }
  const native = { models: [{
    slug: "native", display_name: "Native", priority: 1, visibility: "list",
    supported_in_api: true, tool_mode: "code_mode_only", shell_type: "shell_command",
    supported_reasoning_levels: [
      { effort: "low", description: "Low" }, { effort: "medium", description: "Medium" },
      { effort: "high", description: "High" }, { effort: "xhigh", description: "Extra High" },
    ],
  }] };
  const defaultStock = defaultConfig("full");
  expect(augmentNativeModelCatalog(native, defaultStock)).toEqual(augmentNativeModelCatalog(native, {
    ...defaultStock, experimentalSemanticMemory: true, experimentalWebCompactor: true,
  }));
  const stock = { ...defaultStock, experimentalBiggerContext: false };
  const semWithoutLogical = { ...stock, experimentalSemanticMemory: true, experimentalWebCompactor: true };
  const baselineCatalog = augmentNativeModelCatalog(native, stock);
  expect(augmentNativeModelCatalog(native, semWithoutLogical)).toEqual(baselineCatalog);

  const enabled = { ...semWithoutLogical, experimentalSemanticLogicalWindow: true };
  const optInCatalog = augmentNativeModelCatalog(native, enabled);
  const baselineRows = baselineCatalog.models as Array<Record<string, unknown>>;
  const optInRows = optInCatalog.models as Array<Record<string, unknown>>;
  const bySlug = (rows: Array<Record<string, unknown>>, slug: string) =>
    rows.find(row => row.slug === slug);
  expect(bySlug(optInRows, "native")).toEqual(bySlug(baselineRows, "native"));
  for (const slug of ["chatgpt-web/gpt-5.6-sol", "chatgpt-web/gpt-6-sol"]) {
    expect(bySlug(optInRows, slug)).toMatchObject({ context_window: 240_000, auto_compact_token_limit: 220_000 });
    expect(bySlug(baselineRows, slug)?.context_window).not.toBe(240_000);
  }
  expect(bySlug(optInRows, "chatgpt-web/gpt-6-sol-instant"))
    .toEqual(bySlug(baselineRows, "chatgpt-web/gpt-6-sol-instant"));
  expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", stock, "5.6"))
    .toEqual(resolveChatGptWebPhysicalContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", stock, "5.6"));
  expect(resolveChatGptWebPhysicalContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", enabled, "5.6"))
    .toEqual(resolveChatGptWebPhysicalContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", stock, "5.6"));
});
