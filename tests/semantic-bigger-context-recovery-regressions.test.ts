import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { SemanticCostCaps } from "../src/adapters/chatgpt-web/semantic-cost-caps";
import { semanticEpochOccupancies } from "../src/adapters/chatgpt-web/semantic-occupancy";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { parseRequest } from "../src/responses/parser";
import { estimateTokens } from "../src/lib/token-estimate";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const OLD_RESULT = `REGRESSION-EXACT-OLD-RESULT ${"alpha beta gamma delta ".repeat(36_000)}`;

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "sem-bigger-recovery-"));
  const threadId = `sem_bigger_${basename(dir)}`;
  const statePath = join(dir, "epochs.json");
  const socketPath = join(dir, "broker.sock");
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://sem-bigger-${threadId}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(dir, "launcher.json"),
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: false,
      experimentalSemanticMemory: true,
      experimentalBiggerContext: true,
      semanticCheckpointStatePath: statePath,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const submitted: Array<{ key?: string; text: string; parts: readonly string[] }> = [];
  const ownedSessions = new Set<string>();
  let nextLauncherLeaseReused: boolean | undefined;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const reused = nextLauncherLeaseReused;
    nextLauncherLeaseReused = undefined;
    if (reused !== undefined) await turn.onPreparedSelected?.(reused);
    const prepared = reused === true && turn.prepareResume ? await turn.prepareResume() : await turn.prepare();
    submitted.push({
      ...(turn.conversationKey ? { key: turn.conversationKey } : {}),
      text: prepared.text,
      parts: prepared.multipart?.parts ?? [],
    });
    prepared.release();
    if (reused !== undefined) await turn.onSubmitted?.();
    const answer = `REG answer ${submitted.length}`;
    turn.onTextDelta(answer);
    return answer;
  };

  const environment = `<environment_context><cwd>${dir}</cwd><filesystem><workspace_roots><root>${dir}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
  const nativeTurn = (id: string) => ({ internal_chat_message_metadata_passthrough: { turn_id: `${threadId}:${id}` } });
  const extend = (canonical: unknown[], id: string) => [
    ...canonical,
    { type: "message", role: "user", content: [{ type: "input_text", text: environment }], ...nativeTurn(id) },
    { type: "message", role: "user", id: `${threadId}:user_${id}`, content: `REG instruction ${id}`, ...nativeTurn(id) },
  ];
  const request = (id: string, input: unknown[], family: "5.6" | "6" = "5.6"): CodexParsedRequest => {
    const parsed = parseRequest({
      model: CHATGPT_WEB_MODEL_ID,
      stream: true,
      reasoning: { effort: "high" },
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: threadId, turn_id: `${threadId}:${id}`, request_kind: "turn",
      }) },
      input,
    });
    parsed._chatgptModelFamily = family;
    return parsed;
  };
  const run = async (parsed: CodexParsedRequest) => {
    ownedSessions.add(`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`);
    const events: AdapterEvent[] = [];
    await createChatGptWebAdapter(provider).runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    return events;
  };
  const restart = async () => {
    for (const key of ownedSessions) await chatGptTurnSessions.retireAndWait(key);
    ownedSessions.clear();
  };
  return {
    dir, threadId, statePath, provider, submitted, extend, request, run, restart,
    setNextLauncherLeaseReused(reused: boolean) { nextLauncherLeaseReused = reused; },
    epoch() { return JSON.parse(readFileSync(statePath, "utf8")).epochs[threadId]; },
    async close() {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await restart();
      await TurnBroker.forSocket(socketPath).close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("launcher cache miss validates a fresh epoch and resets stale physical occupancy", async () => {
  const f = makeHarness();
  try {
    const second = await seedEpoch(f);
    const key = f.submitted[1]!.key!;
    const ledger = semanticEpochOccupancies.forConversation(key, true, 111_193, CHATGPT_WEB_MODEL_ID);
    ledger.record("prior-retained-tab", 45_000);
    const priorOccupancy = ledger.value!;
    await f.restart(); // The bridge survives, but the launcher no longer has its retained tab.
    const third = f.extend([
      ...second,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "REG answer 2" }] },
    ], "cache-miss");
    f.setNextLauncherLeaseReused(false);
    expect((await f.run(f.request("cache-miss", third))).at(-1))
      .toMatchObject({ type: "done", stopReason: "stop" });
    expect(f.submitted[2]!.key).toBe(key);
    expect(f.submitted[2]!.text).toContain("REG-IMMUTABLE-DEVELOPER-AUTHORITY");
    expect(f.submitted[2]!.text).toContain("REG instruction cache-miss");
    expect(f.submitted[2]!.parts).toHaveLength(0);
    expect(ledger.confidence).toBe("known");
    expect(ledger.value).toBeGreaterThan(0);
    expect(ledger.value).toBeLessThan(priorOccupancy);

    const occupancyAfterFreshLease = ledger.value!;
    await f.restart();
    const fourth = f.extend([
      ...third,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "REG answer 3" }] },
    ], "retained");
    f.setNextLauncherLeaseReused(true);
    expect((await f.run(f.request("retained", fourth))).at(-1))
      .toMatchObject({ type: "done", stopReason: "stop" });
    expect(f.submitted[3]!.key).toBe(key);
    expect(ledger.value).toBeGreaterThan(occupancyAfterFreshLease);
  } finally {
    await f.close();
  }
}, 20_000);

async function seedEpoch(f: ReturnType<typeof makeHarness>) {
  const first = f.extend([
    { type: "message", role: "developer", content: "REG-IMMUTABLE-DEVELOPER-AUTHORITY" },
  ], "first");
  expect((await f.run(f.request("first", first))).at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  const second = f.extend([
    ...first,
    { type: "function_call", name: "exec_command", call_id: "reg_old_call", arguments: '{"cmd":"inspect"}' },
    { type: "function_call_output", call_id: "reg_old_call", output: OLD_RESULT },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "REG answer 1" }] },
  ], "second");
  expect(estimateTokens(JSON.stringify(second))).toBeGreaterThan(90_000);
  expect((await f.run(f.request("second", second))).at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  expect(f.epoch()).toMatchObject({ semanticEpoch: 1, modelFamily: "5.6", tier: 0 });
  expect(f.submitted).toHaveLength(2);
  expect(f.submitted[1]!.parts).toHaveLength(0); // A semantic epoch must fit one physical submission.
  expect(f.submitted[1]!.text).toContain("[tool result omitted:");
  expect(f.submitted[1]!.text).not.toContain("REGRESSION-EXACT-OLD-RESULT");
  return second;
}

test("combined SEM+Bigger Context resumes the persisted epoch after restart without canonical loss", async () => {
  const f = makeHarness();
  try {
    const second = await seedEpoch(f);
    const persisted = readFileSync(f.statePath, "utf8");
    const oldKey = f.submitted[1]!.key;
    expect(oldKey).toBeTruthy();
    await f.restart(); // No native-turn source remains; the epoch is read from disk.
    const third = f.extend([
      ...second,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "REG answer 2" }] },
    ], "third");
    expect((await f.run(f.request("third", third))).at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
    expect(f.submitted).toHaveLength(3);
    expect(f.submitted[2]!.key).toBe(oldKey);
    expect(f.submitted[2]!.parts).toHaveLength(0);
    expect(f.submitted[2]!.text).toContain("REG-IMMUTABLE-DEVELOPER-AUTHORITY");
    expect(f.submitted[2]!.text).toContain("REG instruction third");
    expect(f.submitted[2]!.text).toContain("[tool result omitted:");
    expect(f.submitted[2]!.text).not.toContain("REGRESSION-EXACT-OLD-RESULT");
    expect(readFileSync(f.statePath, "utf8")).toBe(persisted); // Cooldown must not overwrite the checkpoint.
    expect(second.some(item => JSON.stringify(item).includes("REGRESSION-EXACT-OLD-RESULT"))).toBeTrue();
  } finally {
    await f.close();
  }
}, 20_000);

test("a model-family change reseeds immediately after restart despite the rotation cooldown", async () => {
  const f = makeHarness();
  try {
    const second = await seedEpoch(f);
    const oldEpoch = f.epoch();
    const oldKey = f.submitted[1]!.key;
    await f.restart();
    const third = f.extend([
      ...second,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "REG answer 2" }] },
    ], "third");
    expect((await f.run(f.request("third", third, "6"))).at(-1))
      .toMatchObject({ type: "done", stopReason: "stop" });
    expect(f.epoch()).toMatchObject({ semanticEpoch: 2, modelFamily: "6", tier: 0 });
    expect(f.epoch().sourceTurnId).toBe(`${f.threadId}:second`);
    expect(f.epoch().coveredHistoryDigest).not.toBe(oldEpoch.coveredHistoryDigest);
    expect(f.submitted[2]!.key).toBeTruthy();
    expect(f.submitted[2]!.key).not.toBe(oldKey);
    expect(f.submitted[2]!.parts).toHaveLength(0);
    expect(f.submitted[2]!.text).toContain("REG-IMMUTABLE-DEVELOPER-AUTHORITY");
    expect(f.submitted[2]!.text).not.toContain("REGRESSION-EXACT-OLD-RESULT");
  } finally {
    await f.close();
  }
}, 20_000);

test("rotation cap falls back to lossless canonical Bigger Context multipart", async () => {
  const f = makeHarness();
  try {
    const first = f.extend([
      { type: "message", role: "developer", content: "REG-CAP-AUTHORITY-MUST-SURVIVE" },
    ], "first");
    expect((await f.run(f.request("first", first))).at(-1)).toMatchObject({ type: "done" });
    const costKey = JSON.stringify([chatGptWebExecutionNamespace(f.provider), f.threadId]);
    const caps = new SemanticCostCaps(Date.now, 4, 4, join(f.dir, "semantic-cost-caps.json"));
    for (let i = 0; i < 4; i++) expect(caps.recordRotation(costKey, `prior_${i}`)).toBeTrue();
    expect(caps.count(costKey)).toBe(4);
    const second = f.extend([
      ...first,
      { type: "function_call", name: "exec_command", call_id: "reg_fallback_call", arguments: "{}" },
      { type: "function_call_output", call_id: "reg_fallback_call", output: OLD_RESULT },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "REG answer 1" }] },
    ], "second");
    expect((await f.run(f.request("second", second))).at(-1))
      .toMatchObject({ type: "done", stopReason: "stop" });
    const fallback = f.submitted[1]!;
    expect(fallback.key).toBeUndefined(); // Fresh canonical submission, no claimed semantic epoch.
    expect(fallback.parts.length).toBeGreaterThan(1);
    const records = fallback.parts.flatMap(part => (JSON.parse(part) as { records: unknown[] }).records);
    const completeTransport = JSON.stringify(records);
    expect(completeTransport).toContain("REG-CAP-AUTHORITY-MUST-SURVIVE");
    expect(completeTransport).toContain("REG instruction first");
    expect(completeTransport).toContain("REG instruction second");
    expect(completeTransport).toContain("REGRESSION-EXACT-OLD-RESULT");
    expect(completeTransport).not.toContain("[tool result omitted:");
    expect(caps.count(costKey)).toBe(4);
    expect(existsSync(f.statePath)).toBeFalse();
  } finally {
    await f.close();
  }
}, 20_000);

test("oversized SEM inline projection falls back before epoch commit or rotation charge", async () => {
  const f = makeHarness();
  try {
    const first = f.extend([
      { type: "message", role: "developer", content: "PREFLIGHT-AUTHORITY-MUST-SURVIVE" },
    ], "first");
    expect((await f.run(f.request("first", first))).at(-1))
      .toMatchObject({ type: "done", stopReason: "stop" });
    const second = f.extend([
      ...first,
      { type: "function_call", name: "exec_command", call_id: "oversize_old", arguments: "{}" },
      { type: "function_call_output", call_id: "oversize_old", output: OLD_RESULT },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "REG answer 1" }] },
    ], "oversized");
    (second.at(-1) as { content: string }).content += "X".repeat(510_000);

    expect((await f.run(f.request("oversized", second))).at(-1))
      .toMatchObject({ type: "done", stopReason: "stop" });
    const fallback = f.submitted[1]!;
    expect(fallback.key).toBeUndefined();
    expect(fallback.parts.length).toBeGreaterThan(1);
    const completeTransport = fallback.parts.join("\n");
    expect(completeTransport).toContain("PREFLIGHT-AUTHORITY-MUST-SURVIVE");
    expect(completeTransport).toContain("REGRESSION-EXACT-OLD-RESULT");
    expect(completeTransport).toContain("X".repeat(10_000));
    expect(completeTransport).not.toContain("[tool result omitted:");
    expect(existsSync(f.statePath)).toBeFalse();
    const costKey = JSON.stringify([chatGptWebExecutionNamespace(f.provider), f.threadId]);
    expect(new SemanticCostCaps(Date.now, 4, 4, join(f.dir, "semantic-cost-caps.json")).count(costKey)).toBe(0);
  } finally {
    await f.close();
  }
}, 20_000);
