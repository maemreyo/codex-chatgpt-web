import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { fingerprintNativeExecutable, runIsolatedNativeCase, type RunnerDependencies } from "../scripts/sem-native-recovery-runner";

const base = {
  binary: "/tmp/codex",
  profile: "/tmp/profile.sb",
  enforcementVerified: true,
  fixtureUrl: "http://127.0.0.1:4567",
  requestCap: 1,
  deadlineMs: 100,
  fixtureCounts: () => ({ requestCount: 1, compactCount: 0 }),
};

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kills: string[] = [];
  kill(signal?: NodeJS.Signals) { this.kills.push(signal ?? "SIGTERM"); return true; }
}

function mockChild(child: FakeChild, onSpawn?: (cmd: string, args: string[], options: SpawnOptions) => void): RunnerDependencies {
  return {
    spawn(command, args, options) {
      onSpawn?.(command, args, options);
      return child as unknown as ChildProcess;
    },
    killGroup() {},
  };
}

test("fails closed before native launch without enforcement", async () => {
  let launched = false;
  const result = await runIsolatedNativeCase({ ...base, enforcementVerified: false }, {
    spawn: () => { launched = true; throw new Error("must never spawn"); },
  });
  expect(result.status).toBe("NOT_RUN");
  expect(launched).toBe(false);
});

test("rejects fixture schemes, credentials, query, fragment, paths, and bad ports before launching", async () => {
  const invalid = [
    "https://127.0.0.1:4567", "http://localhost:4567", "http://127.0.0.2:4567",
    "http://user:pass@127.0.0.1:4567", "http://127.0.0.1:4567/#frag",
    "http://127.0.0.1:4567/?query=1", "http://127.0.0.1:4567/v1",
    "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:abc",
    "http://127.0.0.1", "http://127.0.0.1:4567\nprovider='openai'",
  ];
  let launched = false;
  for (const fixtureUrl of invalid) {
    await expect(runIsolatedNativeCase({ ...base, fixtureUrl }, {
      spawn() { launched = true; throw new Error("unexpected spawn"); },
    })).rejects.toThrow("invalid_loopback_fixture_url");
  }
  for (const path of ["relative/binary", "./codex"]) {
    await expect(runIsolatedNativeCase({ ...base, binary: path })).rejects.toThrow("binary_must_be_absolute");
    await expect(runIsolatedNativeCase({ ...base, profile: path })).rejects.toThrow("profile_must_be_absolute");
  }
  expect(launched).toBe(false);
});

test("launches only synthetic prompt/provider with scrubbed env, isolated config and cleanup", async () => {
  const child = new FakeChild();
  let tempRoot = "";
  let observedConfig = "";
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedArgs: string[] = [];
  let observedCommand = "";
  const deps = mockChild(child, (cmd, args, options) => {
    observedCommand = cmd;
    observedArgs = args;
    observedEnv = options.env;
    tempRoot = join(options.cwd as string, "..");
    observedConfig = readFileSync(join(options.env!.CODEX_HOME!, "config.toml"), "utf8");
    queueMicrotask(() => child.emit("close", 0, null));
  });
  const result = await runIsolatedNativeCase(base, deps);
  expect(result.status).toBe("PASS");
  expect(result.fixtureRequests).toBe(1);
  expect(observedCommand).toBe("/usr/bin/sandbox-exec");
  expect(observedArgs.slice(0, 4)).toEqual(["-f", base.profile, base.binary, "exec"]);
  expect(observedArgs).toContain("--skip-git-repo-check");
  expect(observedArgs).toContain("synthetic-sem");
  expect(observedArgs).toContain('model_provider="sem_fixture"');
  expect(observedArgs.at(-1)).toContain("synthetic fixture check");
  expect(Object.keys(observedEnv!).sort()).toEqual(["CODEX_HOME", "HOME", "PATH", "TMPDIR"]);
  expect(observedEnv!.PATH).toBe("/usr/bin:/bin");
  expect(observedConfig).toContain('base_url = "http://127.0.0.1:4567"');
  expect(observedConfig).toContain('wire_api = "responses"');
  expect(observedConfig).toContain("requires_openai_auth = false");
  expect(observedConfig).toContain("mcp_servers = {}");
  expect(observedConfig).toContain("check_for_update_on_startup = false");
  expect(observedConfig).not.toContain("OPENAI_API_KEY");
  expect(existsSync(tempRoot)).toBe(false);
});

test("normal close does not signal an already reaped child group", async () => {
  const child = new FakeChild();
  const kills: Array<[number, string]> = [];
  const result = await runIsolatedNativeCase(base, {
    ...mockChild(child, () => queueMicrotask(() => child.emit("close", 0, null))),
    killGroup(pid, signal) { kills.push([pid, signal]); },
  });
  expect(result.status).toBe("PASS");
  expect(kills).toEqual([]);
});

test("timeout SIGKILLs negative process group and waits for close before cleaning temp", async () => {
  const child = new FakeChild();
  const kills: Array<[number, string]> = [];
  let tempRoot = "";
  let finished = false;
  const promise = runIsolatedNativeCase({ ...base, deadlineMs: 15 }, {
    ...mockChild(child, (_cmd, _args, options) => { tempRoot = join(options.cwd as string, ".."); }),
    killGroup(pid, signal) { kills.push([pid, signal]); },
  }).then((result) => { finished = true; return result; });
  await Bun.sleep(50);
  expect(kills).toContainEqual([-4242, "SIGKILL"]);
  expect(finished).toBe(false);
  expect(existsSync(tempRoot)).toBe(true);
  child.emit("close", null, "SIGKILL");
  expect((await promise).status).toBe("TIMEOUT");
  expect(existsSync(tempRoot)).toBe(false);
});

test("group kill failure falls back to child.kill and waits for reap", async () => {
  const child = new FakeChild();
  const promise = runIsolatedNativeCase({ ...base, deadlineMs: 15 }, {
    ...mockChild(child),
    killGroup() { throw new Error("ESRCH"); },
  });
  await Bun.sleep(45);
  expect(child.kills).toContain("SIGKILL");
  child.emit("close", null, "SIGKILL");
  expect((await promise).status).toBe("TIMEOUT");
});

test("spawn error, spawn throw, and nonzero close all clean isolated roots", async () => {
  for (const kind of ["error", "throw", "nonzero"] as const) {
    const child = new FakeChild();
    let root = "";
    const deps = mockChild(child, (_cmd, _args, options) => {
      root = join(options.cwd as string, "..");
      if (kind === "throw") throw new Error("spawn refused");
      queueMicrotask(() => {
        if (kind === "error") child.emit("error", new Error("synthetic spawn failure"));
        child.emit("close", kind === "nonzero" ? 2 : null, null);
      });
    });
    if (kind === "throw") await expect(runIsolatedNativeCase(base, deps)).rejects.toThrow("spawn refused");
    else expect((await runIsolatedNativeCase(base, deps)).status).toBe("ERROR");
    expect(existsSync(root)).toBe(false);
  }
});

test("zero fixture requests or cap violation cannot claim PASS", async () => {
  for (const requestCount of [undefined, 0, 2]) {
    const child = new FakeChild();
    const deps = mockChild(child, () => queueMicrotask(() => child.emit("close", 0, null)));
    const fixtureCounts = requestCount === undefined ? undefined : () => ({ requestCount });
    expect((await runIsolatedNativeCase({ ...base, fixtureCounts }, deps)).status).toBe("ERROR");
  }
});

test("spawn error waits for close before cleaning temp", async () => {
  const child = new FakeChild();
  const kills: number[] = [];
  let root = "";
  let completed = false;
  const promise = runIsolatedNativeCase(base, {
    ...mockChild(child, (_cmd, _args, options) => {
      root = join(options.cwd as string, "..");
      queueMicrotask(() => child.emit("error", new Error("synthetic ENOENT")));
    }),
    killGroup(pid) { kills.push(pid); },
  }).then((result) => { completed = true; return result; });
  await Bun.sleep(25);
  expect(kills).toContain(-4242);
  expect(completed).toBe(false);
  expect(existsSync(root)).toBe(true);
  child.emit("close", null, "SIGKILL");
  expect((await promise).status).toBe("ERROR");
  expect(existsSync(root)).toBe(false);
});

test("fingerprints actual bytes and offline version in isolated environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "sem-native-fingerprint-test-"));
  try {
    const executable = join(root, "fake-codex");
    await writeFile(executable, "synthetic-version-binary", { mode: 0o755 });
    const child = new FakeChild();
    let fpRoot = "";
    const deps = mockChild(child, (_cmd, args, opts) => {
      expect(args).toEqual(["--version"]);
      expect(Object.keys(opts.env!).sort()).toEqual(["CODEX_HOME", "HOME", "PATH", "TMPDIR"]);
      fpRoot = join(opts.cwd as string, "..");
      queueMicrotask(() => { child.stdout.write("codex-cli 1.2.3\n"); child.emit("close", 0, null); });
    });
    const fingerprint = await fingerprintNativeExecutable(executable, deps);
    expect(fingerprint).toEqual({ sha256: createHash("sha256").update("synthetic-version-binary").digest("hex"), version: "codex-cli 1.2.3" });
    expect(existsSync(fpRoot)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
