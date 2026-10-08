import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import type { CodexProviderConfig } from "../src/types";
import {
  SemanticCostCaps, SEMANTIC_COST_WINDOW_MS, SEMANTIC_ROTATIONS_PER_HOUR, SEMANTIC_WEB_COMPACTIONS_PER_HOUR,
} from "../src/adapters/chatgpt-web/semantic-cost-caps";

test("rolling-hour rotation cap charges committed epochs once, including repeated native requests", () => {
  expect(SEMANTIC_ROTATIONS_PER_HOUR).toBe(4); // Preserve the S8 nine-turn fixture.
  let now = 1_000_000;
  const caps = new SemanticCostCaps(() => now);
  const id = "native-thread-a";
  for (let index = 1; index <= SEMANTIC_ROTATIONS_PER_HOUR; index++) {
    const operation = `epoch-${index}`;
    expect(caps.canRotate(id, operation)).toBe(true);
    expect(caps.recordRotation(id, operation)).toBe(true);
    expect(caps.recordRotation(id, operation)).toBe(true);
    expect(caps.count(id)).toBe(index);
    now += 10_000;
  }
  expect(caps.canRotate(id, "epoch-5")).toBe(false);
  expect(caps.recordRotation(id, "epoch-5")).toBe(false);
  expect(caps.count(id)).toBe(SEMANTIC_ROTATIONS_PER_HOUR);
  expect(caps.canRotate("native-thread-b", "epoch-4")).toBe(true);
  expect(caps.recordRotation("native-thread-b", "epoch-4")).toBe(true);
  expect(caps.count("native-thread-b")).toBe(1);

  now = 1_000_000 + SEMANTIC_COST_WINDOW_MS;
  expect(caps.count(id)).toBe(SEMANTIC_ROTATIONS_PER_HOUR - 1);
  expect(caps.recordRotation(id, "epoch-5")).toBe(true);
  expect(caps.count(id)).toBe(SEMANTIC_ROTATIONS_PER_HOUR);
  now += SEMANTIC_COST_WINDOW_MS;
  expect(caps.count(id)).toBe(0);
  expect(caps.count("native-thread-b")).toBe(0);
});

test("missing native thread identity fails closed; zero budget blocks first rotation", () => {
  const caps = new SemanticCostCaps(() => 5000, 0);
  expect(() => caps.canRotate("", "epoch-1")).toThrow("native thread identity");
  expect(caps.canRotate("thread", "epoch-1")).toBe(false);
  expect(caps.recordRotation("thread", "epoch-1")).toBe(false);
  expect(caps.count("thread")).toBe(0);
});

test("rotation and compaction reservations survive fresh instances and expire independently", () => {
  const dir = mkdtempSync(join(tmpdir(), "semantic-cost-resume-"));
  const file = join(dir, "caps.json");
  let now = 1_000_000;
  const caps = () => new SemanticCostCaps(() => now, 2, 2, file);
  try {
    expect(caps().recordRotation("thread-a", "epoch-1")).toBe(true);
    expect(caps().recordCompaction("thread-a", "compact-1")).toBe(true);
    expect(caps().recordCompaction("thread-a", "compact-1")).toBe(true);
    expect(caps().recordRotation("thread-a", "epoch-2")).toBe(true);
    expect(caps().recordCompaction("thread-a", "compact-2")).toBe(true);
    const restarted = caps();
    expect(restarted.count("thread-a")).toBe(2);
    expect(restarted.count("thread-a", "compactions")).toBe(2);
    expect(restarted.canRotate("thread-a", "epoch-3")).toBe(false);
    expect(restarted.recordCompaction("thread-a", "compact-3")).toBe(false);
    expect(restarted.recordCompaction("thread-a", "compact-2")).toBe(true);
    expect(restarted.recordCompaction("thread-b", "compact-3")).toBe(true);
    const bytes = readFileSync(file, "utf8");
    expect(bytes).not.toContain("thread-a");
    expect(bytes).not.toContain("compact-2");
    now += SEMANTIC_COST_WINDOW_MS;
    expect(caps().count("thread-a")).toBe(0);
    expect(caps().count("thread-a", "compactions")).toBe(0);
    expect(caps().recordCompaction("thread-a", "compact-3")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic cross-instance reservations honor the cap and idempotency", () => {
  const dir = mkdtempSync(join(tmpdir(), "semantic-cost-fence-"));
  const file = join(dir, "caps.json");
  try {
    const first = new SemanticCostCaps(() => 1_000_000, 1, 1, file);
    const other = new SemanticCostCaps(() => 1_000_000, 1, 1, file);
    expect(first.canRotate("thread", "epoch-a")).toBe(true);
    expect(other.canRotate("thread", "epoch-b")).toBe(true);
    expect(first.recordRotation("thread", "epoch-a")).toBe(true);
    expect(other.recordRotation("thread", "epoch-b")).toBe(false);
    expect(other.recordRotation("thread", "epoch-a")).toBe(true);
    expect(other.recordCompaction("thread", "compact-a")).toBe(true);
    expect(first.recordCompaction("thread", "compact-b")).toBe(false);
    expect(first.recordCompaction("thread", "compact-a")).toBe(true);
    expect(existsSync(`${file}.lock`)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt state, conflicting lock, and failed durable write fail closed without reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "semantic-cost-corrupt-"));
  const file = join(dir, "caps.json");
  try {
    writeFileSync(file, '{"version":1,"threads":{"invalid":{}}}');
    const corrupted = new SemanticCostCaps(() => 1_000_000, 2, 2, file);
    expect(() => corrupted.canRotate("thread", "epoch")).toThrow("corrupt or unreadable");
    expect(() => corrupted.recordCompaction("thread", "compact")).toThrow("unavailable");
    expect(readFileSync(file, "utf8")).toContain("invalid");
    rmSync(file);
    mkdirSync(`${file}.lock`);
    const locked = new SemanticCostCaps(() => 1_000_000, 2, 2, file);
    expect(() => locked.recordRotation("thread", "epoch")).toThrow("lock, state or durable write failure");
    expect(existsSync(file)).toBe(false);
    rmSync(`${file}.lock`, { recursive: true });
    mkdirSync(file);
    const unwritable = new SemanticCostCaps(() => 1_000_000, 2, 2, file);
    expect(() => unwritable.recordCompaction("thread", "compact")).toThrow("lock, state or durable write failure");
    expect(() => unwritable.recordCompaction("thread", "compact")).toThrow("previous read/write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Web compaction guardrail is explicit, with independent rotation budget", () => {
  expect(SEMANTIC_WEB_COMPACTIONS_PER_HOUR).toBeGreaterThan(0);
  const caps = new SemanticCostCaps(() => 1_000_000, 0, 1);
  expect(caps.recordRotation("thread", "epoch")).toBe(false);
  expect(caps.recordCompaction("thread", "compact-1")).toBe(true);
  expect(caps.recordCompaction("thread", "compact-1")).toBe(true);
  expect(caps.recordCompaction("thread", "compact-2")).toBe(false);
});

test("real Responses compaction adapter rejects cap exhaustion with 409 before any browser submission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "semantic-cost-response-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `browser://semantic-cost-${dir}`,
    chatgptWeb: {
      localToolsEnabled: false, solAvailable: true, proAvailable: true,
      experimentalSemanticMemory: true,
      semanticCheckpointStatePath: join(dir, "semantic-epochs.json"),
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let submissions = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prompt = await turn.prepare();
    expect(prompt.text).toContain("COMP" );
    prompt.release();
    submissions++;
    turn.onSubmitted?.();
    turn.onTextDelta("Verified compaction summary");
    return "Verified compaction summary";
  };
  const config = defaultConfig("full");
  config.experimentalWebCompactor = true;
  config.experimentalSemanticMemory = true;
  const request = (turnId: string, stream = false) => new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "gpt-6.1-sol", stream, reasoning: { effort: "high" },
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: "cap_thread", turn_id: turnId, request_kind: "compaction",
      }) },
      input: [
        { type: "message", role: "user", content: "COMP: preserve this canonical decision",
          internal_chat_message_metadata_passthrough: { turn_id: turnId } },
        { type: "compaction_trigger" },
      ],
    }),
  });
  try {
    for (let index = 1; index <= SEMANTIC_WEB_COMPACTIONS_PER_HOUR; index++) {
      const response = await responseRequest(request(`cap_turn_${index}`), config,
        () => createChatGptWebAdapter(provider), { rememberState: false });
      expect(response.status).toBe(200);
      const body = await response.json() as { status?: string };
      expect(body.status).toBe("completed");
      expect(submissions).toBe(index);
    }
    // A fresh adapter after each request reloads budget from disk, like daemon restart.
    const rejected = await responseRequest(request("cap_turn_exhausted"), config,
      () => createChatGptWebAdapter(provider), { rememberState: false });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      status: "failed", error: { code: "semantic_web_compaction_cap_hit" },
    });
    expect(submissions).toBe(SEMANTIC_WEB_COMPACTIONS_PER_HOUR);

    const streamed = await responseRequest(request("cap_turn_stream", true), config,
      () => createChatGptWebAdapter(provider), { rememberState: false });
    expect(streamed.status).toBe(200); // SSE headers precede execution; failure is in response.failed.
    const wire = await streamed.text();
    expect(wire).toContain("response.failed");
    expect(wire).toContain("semantic_web_compaction_cap_hit");
    expect(submissions).toBe(SEMANTIC_WEB_COMPACTIONS_PER_HOUR);

    // Same native operation after restart must not charge twice or submit again.
    const replay = await responseRequest(request("cap_turn_1"), config,
      () => createChatGptWebAdapter(provider), { rememberState: false });
    expect(replay.status).toBe(200);
    expect(submissions).toBe(SEMANTIC_WEB_COMPACTIONS_PER_HOUR);
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});
