import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { isAbsolute } from "node:path";
import { fingerprintNativeExecutable, runIsolatedNativeCase } from "./sem-native-recovery-runner";

export type Transport = "sse_http_200" | "json_http_409" | "json_http_400";
export type SyntheticCase = {
  name: string;
  transport: Transport;
  category: string;
};

const CODES = [
  "chatgpt_active_turn_compaction_required",
  "semantic_atomic_result_too_large",
  "semantic_epoch_recovery_required",
] as const;

export const FINITE_CASES: SyntheticCase[] = [
  ...CODES.flatMap((category) => [
    { name: `${category}_sse`, transport: "sse_http_200" as const, category },
    { name: `${category}_json`, transport: "json_http_409" as const, category },
  ]),
  { name: "active_turn_pressure_http_400", transport: "json_http_400", category: "chatgpt_active_turn_compaction_required" },
  { name: "context_length_exceeded_http_400", transport: "json_http_400", category: "context_length_exceeded" },
];

export function hashCase(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function responsePayload(type: string, category: string, id: string) {
  const failed = type === "response.failed";
  return {
    type,
    sequence_number: 1,
    response: {
      id,
      object: "response",
      status: failed ? "failed" : "in_progress",
        retryable: failed ? false : undefined,
      error: failed
        ? {
            type: "invalid_request_error",
            code: category,
            message: "synthetic recovery fixture failure",
            retryable: false,
          }
        : null,
    },
  };
}

export function createLoopbackFixture(requestCap = 12, timeoutMs = 2000, fixedCase?: SyntheticCase) {
  let requests = 0;
  let compactRequests = 0;
  const counts = new Map<string, number>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/models") {
        return Response.json({ data: [{ id: "synthetic-sem" }] });
      }
      if (url.pathname === "/responses/compact") {
        compactRequests += 1;
        return Response.json({ ok: true });
      }
      requests += 1;
      if (requests > requestCap) {
        return new Response("request cap", { status: 429 });
      }
      const item = fixedCase ?? FINITE_CASES[0];
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
      const id = `resp_${hashCase(item.category)}`;
      if (item.transport === "json_http_409" || item.transport === "json_http_400") {
        return Response.json({
          error: {
            type: "invalid_request_error",
            code: item.category,
            retryable: false,
          },
        }, { status: item.transport === "json_http_400" ? 400 : 409 });
      }
      const events = ["response.created", "response.in_progress", "response.failed"];
      const body = events.map((type, index) => {
        const data = responsePayload(type, item.category, id);
        data.sequence_number = index + 1;
        return `event: ${type}\ndata: ${JSON.stringify(data)}\n`;
      }).join("\n");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) timer = setTimeout(() => server.stop(), timeoutMs);
  return {
    url: `http://127.0.0.1:${server.port}`,
    counts,
    get requestCount() { return requests; },
    get compactCount() { return compactRequests; },
    cleanup() { if (timer) clearTimeout(timer); server.stop(); },
  };
}

export function validatePort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid_fixture_port");
  }
  return port;
}

function requirePortNumber(port: number | undefined): number {
  if (typeof port !== "number") throw new Error("invalid_fixture_port");
  validatePort(port);
  return port;
}

export function buildIsolationProfile(port: number) {
  validatePort(requirePortNumber(port));
  return `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote ip "localhost:${port}"))\n`;
}

export function sandboxAvailability() {
  return process.platform === "darwin";
}

export function prepareIsolationProfile(port: number) {
  if (!sandboxAvailability()) throw new Error("sandbox_unavailable");
  const root = mkdtempSync(join(tmpdir(), "sem-sandbox-"));
  const profile = join(root, "profile.sb");
  writeFileSync(profile, buildIsolationProfile(port));
  return { root, profile, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function nativeFingerprint(binary = "codex") {
  return { binary, platform: process.platform, arch: process.arch };
}

export async function probeTwoListeners() : Promise<SandboxProbeResult> {
  if (process.platform !== "darwin") {
    return { enforced: false, reason: "sandbox_unavailable", permittedRequestCount: 0, deniedRequestCount: 0 };
  }
  let allowedCount = 0;
  let deniedCount = 0;
  const allowed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      allowedCount += 1;
      return Response.json({ ok: true });
    },
  });
  const denied = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      deniedCount += 1;
      return Response.json({ ok: true });
    },
  });
  let isolation: ReturnType<typeof prepareIsolationProfile> | undefined;
  try {
    isolation = prepareIsolationProfile(requirePortNumber(allowed.port));
    const result = await enforceSandbox(
      isolation.profile,
      `http://127.0.0.1:${allowed.port}/probe`,
      `http://127.0.0.1:${denied.port}/probe`,
    );
    return {
      ...result,
      permittedRequestCount: allowedCount,
      deniedRequestCount: deniedCount,
      enforced: result.enforced && allowedCount > 0 && deniedCount === 0,
    };
  } finally {
    isolation?.cleanup();
    allowed.stop();
    denied.stop();
  }
}

export type SandboxProbeResult = {
  enforced: boolean;
  reason: string;
  permittedRequestCount: number;
  deniedRequestCount: number;
};

type SandboxDependencies = {
  timeoutMs?: number;
  killGroup?: (negativePid: number, signal: "SIGKILL") => void;
};

const SANDBOX_DEFAULT_TIMEOUT_MS = 2000;
const SANDBOX_REAP_GRACE_MS = 750;

export async function enforceSandbox(
  profile: string,
  permittedUrl: string,
  deniedUrl: string,
  runner = spawn,
  deps: SandboxDependencies = {},
): Promise<SandboxProbeResult> {
  if (process.platform !== "darwin") {
    return { enforced: false, reason: "sandbox_unavailable", permittedRequestCount: 0, deniedRequestCount: 0 };
  }

  const helper = Bun.file(new URL("./sandbox-probe-helper.ts", import.meta.url).pathname);
  if (!(await helper.exists())) {
    return { enforced: false, reason: "helper_missing", permittedRequestCount: 0, deniedRequestCount: 0 };
  }

  return new Promise((resolve) => {
    const cleanupRoot = mkdtempSync(join(tmpdir(), "sem-sandbox-run-"));
    let settled = false;
    const finish = (result: SandboxProbeResult) => {
      if (settled) return;
      settled = true;
      rmSync(cleanupRoot, { recursive: true, force: true });
      resolve(result);
    };
    let child: ChildProcess;
    try {
      child = runner(
        "/usr/bin/sandbox-exec",
        ["-f", profile, process.execPath, "run", new URL("./sandbox-probe-helper.ts", import.meta.url).pathname, permittedUrl, deniedUrl],
        { stdio: ["ignore", "pipe", "pipe"], detached: true, env: {
          HOME: join(cleanupRoot, "home"),
          CODEX_HOME: join(cleanupRoot, "codex-home"),
          PATH: "/usr/bin:/bin",
        } },
      );
    } catch {
      finish({ enforced: false, reason: "sandbox_exec_failed", permittedRequestCount: 0, deniedRequestCount: 0 });
      return;
    }
    let output = "";
    let outputBytes = 0;
    const append = (chunk: unknown) => {
      if (outputBytes >= 4096) return;
      const text = String(chunk);
      output += text.slice(0, 4096 - outputBytes);
      outputBytes = output.length;
    };
    let closed = false;
    let killed = false;
    let closeResolve: (() => void) | undefined;
    const closePromise = new Promise<void>((resolveClose) => { closeResolve = resolveClose; });
    const cleanupKill = () => {
      if (killed || closed) return;
      killed = true;
      if (typeof child.pid === "number" && child.pid > 0) {
        try {
          (deps.killGroup ?? process.kill.bind(process))(-child.pid, "SIGKILL");
          return;
        } catch { }
      }
      try { child.kill("SIGKILL"); } catch { }
    };
    const waitClose = async () => {
      await Promise.race([
        closePromise,
        new Promise<void>((resolveClose) => setTimeout(resolveClose, SANDBOX_REAP_GRACE_MS)),
      ]);
    };
    const timer = setTimeout(() => {
      if (closed) return;
      cleanupKill();
      void waitClose().then(() => finish({ enforced: false, reason: "probe_timeout", permittedRequestCount: 0, deniedRequestCount: 0 }));
    }, deps.timeoutMs ?? SANDBOX_DEFAULT_TIMEOUT_MS);
    child.stdout?.on("data", append);
    child.stderr?.resume?.();
    child.on("error", () => {
      clearTimeout(timer);
      closed = true;
      closeResolve?.();
      finish({ enforced: false, reason: "sandbox_exec_failed", permittedRequestCount: 0, deniedRequestCount: 0 });
    });
    child.on("close", (code) => {
      closed = true;
      closeResolve?.();
      clearTimeout(timer);
      if (code !== 0) {
        finish({ enforced: false, reason: "helper_rejected", permittedRequestCount: 0, deniedRequestCount: 0 });
        return;
      }
      try {
        const result = JSON.parse(output);
        finish({
          permittedRequestCount: result.permittedRequestCount ?? 0,
          deniedRequestCount: result.deniedRequestCount ?? 0,
          reason: result.reason ?? "probe_complete",
          enforced: (result.permittedRequestCount ?? 0) > 0 && (result.deniedRequestCount ?? 0) === 0 && result.helperDenial === true,
        });
      } catch {
        finish({ enforced: false, reason: "invalid_helper_result", permittedRequestCount: 0, deniedRequestCount: 0 });
      }
    });
  });
}

export function classifySyntheticOutcome(input: { requestCount: number; requestCap: number; sandboxAvailable: boolean; compactRequested?: boolean; clientRetried?: boolean; timedOut?: boolean; }) {
  if (input.requestCount === 0) return "SETUP_ERROR";
  if (!input.sandboxAvailable) return "sandbox_unavailable";
  if (input.timedOut || input.requestCount >= input.requestCap) return "harness_limit_reached";
  if (input.compactRequested) return "native_requested_compact";
  if (input.clientRetried) return "client_retry_observed";
  return "native_terminal_no_retry";
}

export async function main() {
  const probe = await probeTwoListeners();
  const override = Bun.argv.find((arg) => arg.startsWith("--binary="))?.slice("--binary=".length);
  const candidate = override ?? Bun.which("codex");
  const found = candidate && isAbsolute(candidate) ? candidate : undefined;
  if (!found || !isAbsolute(found) || !probe.enforced) {
    console.log(JSON.stringify({
      cases: FINITE_CASES.length,
      sandbox: probe.reason,
      native: { status: "SETUP_ERROR", reason: !found ? "binary_missing" : "sandbox_not_verified" },
    }));
    return;
  }

  const fingerprint = await fingerprintNativeExecutable(found);
  const results = [];
  for (const item of FINITE_CASES) {
    const fixture = createLoopbackFixture(4, 15000, item);
    const port = Number(new URL(fixture.url).port);
    if (!Number.isInteger(port)) throw new Error("invalid_fixture_port");
    const isolation = prepareIsolationProfile(port);
    try {
      const nativeResult = await runIsolatedNativeCase({
        binary: found,
        profile: isolation.profile,
        enforcementVerified: true,
        fixtureUrl: fixture.url,
        requestCap: 4,
        deadlineMs: 5000,
        fixtureCounts: () => ({ requestCount: fixture.requestCount, compactCount: fixture.compactCount }),
      });
      const counts = { requestCount: fixture.requestCount, compactCount: fixture.compactCount };
      results.push({
        nativeResult,
        counts,
        classification: classifySyntheticOutcome({
          requestCount: counts.requestCount,
          requestCap: 4,
          sandboxAvailable: true,
          compactRequested: counts.compactCount > 0,
          clientRetried: counts.requestCount > 1,
          timedOut: nativeResult.status === "TIMEOUT",
        }),
      });
    } finally {
      isolation.cleanup();
      fixture.cleanup();
    }
  }
  console.log(JSON.stringify({
    fingerprint,
    cases: results.map((result, index) => ({
      id: hashCase(FINITE_CASES[index].name),
      code: FINITE_CASES[index].category,
      transport: FINITE_CASES[index].transport,
      counts: result.counts,
      result: result.nativeResult,
      classification: result.classification,
    })),
  }));
}

if (import.meta.main) await main();
