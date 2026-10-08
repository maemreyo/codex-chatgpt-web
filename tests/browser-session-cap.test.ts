import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, resolveBrowserConfig, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { reserveChatGptBrowserTurn, resolveMaxBrowserSessions } from "../src/adapters/chatgpt-web/concurrency";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig, loadConfig, providerConfig, saveConfig } from "../src/config";

const originalHome = process.env.CODEX_CHATGPT_WEB_HOME;
const roots: string[] = [];
afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test("JSON maxBrowserSessions defaults to 5, persists 8, and rejects all out-of-range values", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-browser-cap-"));
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  const config = defaultConfig();
  expect(config.maxBrowserSessions).toBe(5);
  const persisted: Record<string, unknown> = { ...config };
  const write = () => writeFileSync(join(root, "config.json"), JSON.stringify(persisted));
  delete persisted.maxBrowserSessions;
  write();
  expect(loadConfig().maxBrowserSessions).toBe(5);
  saveConfig({ ...config, maxBrowserSessions: 8 });
  const loaded = loadConfig();
  expect(loaded.maxBrowserSessions).toBe(8);
  expect(providerConfig(loaded).chatgptWeb?.maxBrowserSessions).toBe(8);
  expect(resolveBrowserConfig(providerConfig(loaded)).maxBrowserSessions).toBe(8);
  for (const invalid of [4, 9, 5.5, "8", null, NaN, Infinity]) {
    persisted.maxBrowserSessions = invalid;
    write();
    expect(() => loadConfig()).toThrow("Invalid maxBrowserSessions");
    expect(() => resolveMaxBrowserSessions(invalid)).toThrow("maxBrowserSessions");
  }
  expect(resolveBrowserConfig({ adapter: "chatgpt-web", baseUrl: "https://chatgpt.com" }).maxBrowserSessions).toBe(5);
  expect(() => resolveBrowserConfig({
    adapter: "chatgpt-web", baseUrl: "https://chatgpt.com", chatgptWeb: { maxBrowserSessions: 9 },
  })).toThrow("maxBrowserSessions");
});

test("turn registry accepts exactly 8 and returns typed exhaustion while preserving existing turns", async () => {
  const sessions = new ChatGptTurnSessions();
  const resolveTurn: Array<() => void> = [];
  const start = () => {
    let done!: (value: string) => void;
    const browser = new Promise<string>(resolve => { done = resolve; });
    resolveTurn.push(() => done("complete"));
    return {
      mode: "read-only" as const,
      browser,
      physicalSettlement: browser.then(() => undefined),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => done("cancelled"),
    };
  };
  const active = Array.from({ length: 8 }, (_unused, index) => sessions.getOrCreate(`turn_${index}`, start,
    undefined, undefined, undefined, undefined, undefined, 8));
  expect(sessions.activeCount()).toBe(8);
  expect(sessions.getOrCreate("turn_0", start, undefined, undefined, undefined, undefined, undefined, 8)).toBe(active[0]);
  try {
    sessions.getOrCreate("turn_8", start, undefined, undefined, undefined, undefined, undefined, 8);
    throw new Error("expected a typed capacity error");
  } catch (error) {
    expect(error).toBeInstanceOf(ChatGptWebAdapterError);
    expect(error).toMatchObject({ status: 409, code: "browser_session_limit_exceeded", retryable: false,
      maxBrowserSessions: 8, activeBrowserSessions: 8 });
  }
  resolveTurn[0]!();
  await active[0]!.browserOutcome;
  expect(sessions.getOrCreate("turn_8", start, undefined, undefined, undefined, undefined, undefined, 8)).toBeDefined();
  resolveTurn.forEach(release => release());
  await Promise.all(active.map(session => session.browserOutcome));
  sessions.clear();
});

test("workers reserve globally before async dispatch and free slots on physical settlement", async () => {
  const releases = new Map<string, () => void>();
  const worker = (limit: number) => Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome", maxBrowserSessions: limit },
    activeRuns: new Map(),
    runExclusive: (turn: BrowserTurn) => new Promise<string>(resolve => {
      releases.set(turn.traceId, () => resolve(turn.traceId));
    }),
  }) as ChatGptBrowserWorker;
  const turn = (traceId: string) => ({ traceId } as BrowserTurn);
  const first = worker(8);
  const second = worker(8);
  const legacy = worker(5);
  const running = [...Array.from({ length: 4 }, (_unused, index) => first.run(turn(`a_${index}`))),
    ...Array.from({ length: 4 }, (_unused, index) => second.run(turn(`b_${index}`)))];
  await Promise.resolve();
  expect(releases.size).toBe(8);
  await expect(second.run(turn("ninth"))).rejects.toMatchObject({
    status: 409, code: "browser_session_limit_exceeded", retryable: false,
    maxBrowserSessions: 8, activeBrowserSessions: 8,
  });
  await expect(legacy.run(turn("legacy_denied"))).rejects.toThrow("at most 5 simultaneous browser turns");
  for (const key of ["a_0", "a_1", "a_2", "a_3"]) releases.get(key)!();
  await Promise.all(running.slice(0, 4));
  const fifth = legacy.run(turn("legacy_fifth"));
  await Promise.resolve();
  expect(releases.has("legacy_fifth")).toBeTrue();
  await expect(legacy.run(turn("legacy_sixth"))).rejects.toMatchObject({ code: "browser_session_limit_exceeded" });
  for (const key of ["b_0", "b_1", "b_2", "b_3", "legacy_fifth"]) releases.get(key)!();
  await Promise.all([...running.slice(4), fifth]);
});

test("every configured cap admits exactly N turns, including a pending cap decrease", () => {
  for (const limit of [5, 6, 7, 8]) {
    const releases = Array.from({ length: limit }, () => reserveChatGptBrowserTurn(limit));
    try {
      expect(() => reserveChatGptBrowserTurn(limit)).toThrow(`at most ${limit} simultaneous browser turns`);
      if (limit > 5) {
        expect(() => reserveChatGptBrowserTurn(5)).toThrow("at most 5 simultaneous browser turns");
      }
      while (releases.length > 4) releases.pop()!();
      const newReservation = reserveChatGptBrowserTurn(5);
      newReservation();
    } finally {
      releases.forEach(release => release());
    }
  }
});

test("failed asynchronous browser bootstrap releases its reserved slot", async () => {
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome", maxBrowserSessions: 5 },
    activeRuns: new Map(),
    runExclusive: async () => { throw new Error("bootstrap failed"); },
  }) as ChatGptBrowserWorker;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    await expect(worker.run({ traceId: `failed_${attempt}` } as BrowserTurn)).rejects.toThrow("bootstrap failed");
  }
});
