import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createReadStream } from "node:fs";

const MODEL = "synthetic-sem";
const PROVIDER = "sem_fixture";
const PROMPT = "Offline synthetic fixture check. Reply SEM_NATIVE_FIXTURE_OK only. Do not use tools, commands, files, accounts, or external network services.";
const REAP_GRACE_MS = 750;

export type NativeCaseRequest = {
  binary: string;
  profile: string;
  enforcementVerified: boolean;
  fixtureUrl: string;
  requestCap: number;
  deadlineMs: number;
  /** Provided by the fixture owner. No raw requests or response bodies. */
  fixtureCounts?: () => { requestCount: number; compactCount?: number };
};

export type NativeCaseResult = {
  status: "PASS" | "NOT_RUN" | "TIMEOUT" | "ERROR";
  exitCode?: number | null;
  durationMs: number;
  fixtureRequests?: number;
  fixtureCompactions?: number;
};

type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type RunnerDependencies = {
  spawn?: SpawnLike;
  /** Receives negative process-group ID; injectable to avoid test process signaling. */
  killGroup?: (negativePid: number, signal: "SIGKILL") => void;
};

function absolutePath(path: string, label: string): void {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error(`${label}_must_be_absolute`);
  }
}

function validateFixtureUrl(value: string): string {
  // Whole-string match rejects schemes other than HTTP, credentials, paths,
  // queries, fragments, and alternate loopback spellings before TOML writing.
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(value);
  if (!match || Number(match[1]) > 65535) throw new Error("invalid_loopback_fixture_url");
  return `http://127.0.0.1:${Number(match[1])}`;
}

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home"), TMPDIR: join(root, "tmp") };
}

async function makeIsolatedDirectories(root: string): Promise<NodeJS.ProcessEnv> {
  const env = isolatedEnv(root);
  await Promise.all([mkdir(env.HOME!), mkdir(env.CODEX_HOME!), mkdir(env.TMPDIR!), mkdir(join(root, "cwd"))]);
  return env;
}

function terminateGroup(child: ChildProcess, killGroup: NonNullable<RunnerDependencies["killGroup"]>): void {
  if (typeof child.pid === "number" && child.pid > 0) {
    try { killGroup(-child.pid, "SIGKILL"); return; } catch { /* fall back to direct child */ }
  }
  try { child.kill("SIGKILL"); } catch { /* already reaped */ }
}

async function waitForClose(closed: Promise<void>, graceMs = REAP_GRACE_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), graceMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function isolatedSpawn(
  command: string,
  args: string[],
  options: SpawnOptions,
  deadlineMs: number,
  deps: RunnerDependencies,
  onStdout?: (chunk: Buffer) => void,
): Promise<{ status: "PASS" | "ERROR" | "TIMEOUT"; exitCode?: number | null }> {
  const spawn = deps.spawn ?? nodeSpawn;
  const killGroup = deps.killGroup ?? process.kill.bind(process);
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let groupKilled = false;
  let closePromise: Promise<void> | undefined;
  const stop = () => {
    if (child && !groupKilled) {
      groupKilled = true;
      terminateGroup(child, killGroup);
    }
  };

  try {
    child = spawn(command, args, options);
    let exitCode: number | null = null;
    closePromise = new Promise<void>((resolve) => {
      child!.once("close", (code: number | null) => { closed = true; exitCode = code; resolve(); });
    });
    const spawnError = new Promise<"error">((resolve) => child!.once("error", () => resolve("error")));
    const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), deadlineMs); });
    if (onStdout) child.stdout?.on("data", onStdout);
    child.stdout?.resume();
    child.stderr?.resume();

    const first = await Promise.race([closePromise.then(() => "close" as const), spawnError, deadline]);
    if (first === "close") return { status: exitCode === 0 ? "PASS" : "ERROR", exitCode };
    stop();
    if (!(await waitForClose(closePromise))) {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      await waitForClose(closePromise);
    }
    return { status: first === "timeout" ? "TIMEOUT" : "ERROR" };
  } finally {
    if (timer) clearTimeout(timer);
    if (child && !closed) {
      // The process group is only targeted while the child is still live. After
      // close/reap, its pid may be reused and a later group kill could hit an
      // unrelated process group. Descendant cleanup is bounded by the live
      // child timeout/error path above.
      stop();
      if (closePromise) await waitForClose(closePromise);
    }
  }
}

export async function fingerprintNativeExecutable(
  binary: string,
  deps: RunnerDependencies = {},
): Promise<{ sha256: string; version: string }> {
  absolutePath(binary, "binary");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(binary);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  let root: string | undefined;
  try {
    root = await mkdtemp(join(tmpdir(), "sem-native-fingerprint-"));
    const env = await makeIsolatedDirectories(root);
    let version = "";
    const result = await isolatedSpawn(binary, ["--version"], {
      cwd: join(root, "cwd"), env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    }, 2_000, deps, (chunk) => { version = (version + chunk.toString("utf8")).slice(0, 128); });
    if (result.status !== "PASS" || !/^codex(?:-cli)?\s+[0-9][\w.+-]*$/i.test(version.trim())) {
      throw new Error("offline_native_version_unavailable");
    }
    return { sha256: hash.digest("hex"), version: version.trim() };
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
}

export async function runIsolatedNativeCase(
  request: NativeCaseRequest,
  deps: RunnerDependencies = {},
): Promise<NativeCaseResult> {
  const started = Date.now();
  if (!request.enforcementVerified) return { status: "NOT_RUN", durationMs: 0 };

  absolutePath(request.binary, "binary");
  absolutePath(request.profile, "profile");
  const baseUrl = validateFixtureUrl(request.fixtureUrl);
  if (!Number.isSafeInteger(request.requestCap) || request.requestCap < 1 ||
      !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs < 1 || request.deadlineMs > 300_000) {
    throw new Error("invalid_native_runner_bounds");
  }

  let root: string | undefined;
  try {
    root = await mkdtemp(join(tmpdir(), "sem-native-runner-"));
    const env = await makeIsolatedDirectories(root);
    await writeFile(join(env.CODEX_HOME!, "config.toml"), [
      `model = "${MODEL}"`,
      `model_provider = "${PROVIDER}"`,
      "check_for_update_on_startup = false",
      'web_search = "disabled"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      "mcp_servers = {}",
      "",
      `[model_providers.${PROVIDER}]`,
      'name = "Local synthetic fixture"',
      `base_url = "${baseUrl}"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "",
      "[features]",
      "multi_agent = false",
      "multi_agent_v2 = false",
      "apps = false",
      "plugins = false",
      "web_search_request = false",
      "web_search_cached = false",
      "",
    ].join("\n"), { mode: 0o600 });

    const childResult = await isolatedSpawn("/usr/bin/sandbox-exec", [
      "-f", request.profile, request.binary, "exec", "--skip-git-repo-check",
      "--sandbox", "read-only", "--model", MODEL, "-c", `model_provider="${PROVIDER}"`, PROMPT,
    ], { cwd: join(root, "cwd"), detached: true, env, stdio: ["ignore", "pipe", "pipe"] },
    request.deadlineMs, deps);

    const counts = request.fixtureCounts?.();
    const validCounts = counts === undefined || (
      Number.isSafeInteger(counts.requestCount) && counts.requestCount >= 0 && counts.requestCount <= request.requestCap &&
      (counts.compactCount === undefined || (Number.isSafeInteger(counts.compactCount) && counts.compactCount >= 0))
    );
    return {
      status: childResult.status === "PASS" && (!validCounts || counts === undefined || counts.requestCount === 0)
        ? "ERROR" : childResult.status,
      exitCode: childResult.exitCode,
      durationMs: Date.now() - started,
      ...(validCounts && counts !== undefined ? { fixtureRequests: counts.requestCount, fixtureCompactions: counts.compactCount } : {}),
    };
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
}
