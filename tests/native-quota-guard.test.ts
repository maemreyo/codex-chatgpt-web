import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeQuotaGuard, NATIVE_QUOTA_POLL_INTERVAL_MS, NATIVE_QUOTA_FAILURE_COOLDOWN_MS, NATIVE_QUOTA_DENIED_COOLDOWN_MS, readNativeQuotaUsage } from "../src/native-quota-guard";
import { defaultConfig, DEFAULT_NATIVE_QUOTA_RESERVE_SETTINGS, parseNativeQuotaReserveSettings } from "../src/config";
import { startServer } from "../src/server";
import type { NativeFetch } from "../src/native-passthrough";

const conservative = { ...DEFAULT_NATIVE_QUOTA_RESERVE_SETTINGS, mode: "conservative" as const };
function conservativeGuard(fetchUsage: NativeFetch, options: { stateFile?: string; now?: () => number } = {}) {
  return new NativeQuotaGuard(fetchUsage, { ...options, policy: conservative });
}

function usage(fiveHourUsed: number, weeklyUsed: number): unknown {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: fiveHourUsed, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: weeklyUsed, limit_window_seconds: 604_800 },
    },
  };
}

const request = (endpoint = "responses") => new Request(`http://localhost/v1/${endpoint}`, {
  method: "POST",
  headers: { authorization: "Bearer TEST_TOKEN", "chatgpt-account-id": "TEST_ACCOUNT" },
  body: "{}",
});

test("strict mode refuses native requests without sending even an account quota probe", async () => {
  let reads = 0;
  let forwarded = 0;
  const guard = new NativeQuotaGuard(async () => {
    reads++;
    return Response.json(usage(1, 1));
  });
  for (let i = 0; i < 20; i++) {
    const result = await guard.run(request(), async () => {
      forwarded++;
      return Response.json({ ok: true });
    });
    expect(result.status).toBe(403);
    expect((await result.json() as { error: { code: string } }).error.code).toBe("quota_guard_strict");
  }
  expect(reads).toBe(0);
  expect(forwarded).toBe(0);
});

test("native reserve settings validate admission above target and default to strict", () => {
  expect(parseNativeQuotaReserveSettings(undefined)).toEqual(DEFAULT_NATIVE_QUOTA_RESERVE_SETTINGS);
  expect(parseNativeQuotaReserveSettings({ mode: "conservative", fiveHourAdmissionPercent: 30 })).toMatchObject({
    mode: "conservative", fiveHourReservePercent: 5, weeklyReservePercent: 3,
    fiveHourAdmissionPercent: 30, weeklyAdmissionPercent: 10,
  });
  for (const settings of [
    { mode: "unknown" },
    { fiveHourAdmissionPercent: 5 },
    { weeklyAdmissionPercent: 3 },
    { weeklyReservePercent: 200 },
    { fiveHourAdmissionPercent: "20" },
  ]) expect(() => parseNativeQuotaReserveSettings(settings)).toThrow();
});

test("conservative admission levels are configurable; 10 percent remaining is already blocked", async () => {
  const policy = { ...conservative, fiveHourAdmissionPercent: 25, weeklyAdmissionPercent: 15 };
  const blocked = new NativeQuotaGuard(async () => Response.json(usage(90, 30)), { policy });
  let forwarded = false;
  const denied = await blocked.run(request(), async () => { forwarded = true; return Response.json({ ok: true }); });
  expect(denied.status).toBe(403);
  expect((await denied.json() as { error: { code: string } }).error.code).toBe("quota_reserve_reached");
  expect(forwarded).toBeFalse();

  const weeklyBlocked = new NativeQuotaGuard(async () => Response.json(usage(10, 90)), { policy });
  expect((await weeklyBlocked.run(request(), async () => Response.json({ bad: true }))).status).toBe(403);
  const enough = new NativeQuotaGuard(async () => Response.json(usage(60, 60)), { policy });
  const accepted = await enough.run(request(), async () => Response.json({ ok: true }));
  expect(await accepted.json()).toEqual({ ok: true });
});

test("quota windows are matched by actual duration, not primary/secondary slot", () => {
  const raw = usage(12, 44) as { rate_limit: Record<string, unknown> };
  [raw.rate_limit.primary_window, raw.rate_limit.secondary_window] =
    [raw.rate_limit.secondary_window, raw.rate_limit.primary_window];
  expect(readNativeQuotaUsage(raw)).toEqual({
    fiveHour: { usedPercent: 12, durationSeconds: 18_000 },
    weekly: { usedPercent: 44, durationSeconds: 604_800 },
  });
  delete raw.rate_limit.secondary_window;
  expect(readNativeQuotaUsage(raw)).toBeUndefined();
  expect(readNativeQuotaUsage({ rate_limit: { primary_window: { used_percent: 4 } } })).toBeUndefined();
});

test("reserve guard admits safe quota and forwards the same bearer/account only to wham", async () => {
  const urls: string[] = [];
  const guard = conservativeGuard(async req => {
    urls.push(req.url);
    expect(req.method).toBe("GET");
    expect(req.headers.get("authorization")).toBe("Bearer TEST_TOKEN");
    expect(req.headers.get("chatgpt-account-id")).toBe("TEST_ACCOUNT");
    return Response.json(usage(20, 40));
  });
  let forwarded = 0;
  const result = await guard.run(request(), async () => { forwarded++; return Response.json({ ok: true }); });
  expect((await result.json())).toEqual({ ok: true });
  expect(urls).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
  expect(forwarded).toBe(1);
});

test("native reserve pauses before 5h and weekly buffer while preserving reserve", async () => {
  for (const [fiveHourUsed, weeklyUsed] of [[93, 0], [0, 96], [95, 97]]) {
    const guard = conservativeGuard(async () => Response.json(usage(fiveHourUsed, weeklyUsed)));
    let forwarded = false;
    const result = await guard.run(request(), async () => { forwarded = true; return Response.json({}); });
    expect(result.status).toBe(403);
    expect((await result.json() as { error: { code: string } }).error.code).toBe("quota_reserve_reached");
    expect(forwarded).toBeFalse();
  }
});

test("reserve reached does not trigger a quota-read storm from repeated native requests", async () => {
  for (const [fiveHourUsed, weeklyUsed, waitMs] of [
    [93, 20, 18_000_000], [20, 96, NATIVE_QUOTA_DENIED_COOLDOWN_MS],
  ]) {
    let now = 1_000_000;
    let reads = 0;
    const guard = conservativeGuard(async () => { reads++; return Response.json(usage(fiveHourUsed!, weeklyUsed!)); }, {
      now: () => now,
    });
    for (let i = 0; i < 20; i++) {
      const result = await guard.run(request(), async () => Response.json({ bad: true }));
      expect(result.status).toBe(403);
    }
    expect(reads).toBe(1);
    now += waitMs!;
    expect((await guard.run(request(), async () => Response.json({ bad: true }))).status).toBe(403);
    expect(reads).toBe(2);
  }
});

test("missing/invalid quota, HTTP errors and transport errors fail closed", async () => {
  for (const fetchUsage of [
    async () => Response.json({}),
    async () => Response.json({ rate_limit: { allowed: false } }),
    async () => new Response("unavailable", { status: 503 }),
    async () => { throw new Error("PRIVATE_TOKEN network failure"); },
  ]) {
    const guard = conservativeGuard(fetchUsage);
    let forwarded = false;
    const result = await guard.run(request(), async () => { forwarded = true; return Response.json({}); });
    expect(result.status).toBe(403);
    expect((await result.text())).not.toContain("PRIVATE_TOKEN");
    expect(forwarded).toBeFalse();
  }
});

test("native guard serializes inflight streaming until EOF, then rechecks quota", async () => {
  let checks = 0;
  let time = 1_000_000;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const guard = conservativeGuard(async () => { checks++; return Response.json(usage(30, 20)); }, { now: () => time });
  const first = await guard.run(request(), async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { stream = controller; },
  })));
  let forwarded = false;
  const second = await guard.run(request(), async () => { forwarded = true; return Response.json({}); });
  expect(second.status).toBe(403);
  expect((await second.json() as { error: { code: string } }).error.code).toBe("quota_guard_busy");
  expect(forwarded).toBeFalse();
  const reader = first.body!.getReader();
  stream.close();
  expect((await reader.read()).done).toBeTrue();
  const premature = await guard.run(request(), async () => Response.json({ bad: true }));
  expect(premature.status).toBe(403);
  expect((await premature.json() as { error: { code: string } }).error.code).toBe("quota_guard_cooldown");
  expect(checks).toBe(1);
  time += NATIVE_QUOTA_POLL_INTERVAL_MS;
  const third = await guard.run(request(), async () => Response.json({ ok: true }));
  expect(third.status).toBe(200);
  expect(await third.json()).toEqual({ ok: true });
  expect(checks).toBe(2);
});

test("failed quota reads use one-hour cooldown with no retry or background polling", async () => {
  let reads = 0;
  let time = 2_000_000;
  const guard = conservativeGuard(async () => { reads++; return new Response("no", { status: 503 }); }, { now: () => time });
  const first = await guard.run(request(), async () => Response.json({ bad: true }));
  expect(first.status).toBe(403);
  for (let i = 0; i < 20; i++) {
    const result = await guard.run(request(), async () => Response.json({ bad: true }));
    expect((await result.json() as { error: { code: string } }).error.code).toBe("quota_guard_cooldown");
  }
  expect(reads).toBe(1);
  time += NATIVE_QUOTA_FAILURE_COOLDOWN_MS;
  const next = await guard.run(request(), async () => Response.json({ bad: true }));
  expect(next.status).toBe(403);
  expect(reads).toBe(2);
});

test("429 and incompatible quota data open a 24-hour circuit breaker", async () => {
  for (const response of [new Response("denied", { status: 429 }), Response.json({ unexpected: true })]) {
    let reads = 0;
    let time = 2_000_000;
    const guard = conservativeGuard(async () => { reads++; return response.clone(); }, { now: () => time });
    expect((await guard.run(request(), async () => Response.json({ bad: true }))).status).toBe(403);
    time += NATIVE_QUOTA_FAILURE_COOLDOWN_MS;
    const retry = await guard.run(request(), async () => Response.json({ bad: true }));
    expect((await retry.json() as { error: { code: string } }).error.code).toBe("quota_guard_cooldown");
    expect(reads).toBe(1);
    time += NATIVE_QUOTA_DENIED_COOLDOWN_MS - NATIVE_QUOTA_FAILURE_COOLDOWN_MS;
    expect((await guard.run(request(), async () => Response.json({ bad: true }))).status).toBe(403);
    expect(reads).toBe(2);
  }
});

test("guard stores only hashed identity and survives restart without polling again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-guard-test-"));
  const stateFile = join(dir, "state.json");
  let time = 3_000_000;
  let reads = 0;
  const fetchUsage = async () => { reads++; return Response.json(usage(10, 20)); };
  try {
    const first = conservativeGuard(fetchUsage, { stateFile, now: () => time });
    const firstResponse = await first.run(request(), async () => Response.json({ ok: true }));
    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({ ok: true });
    const state = readFileSync(stateFile, "utf8");
    expect(state).not.toContain("TEST_TOKEN");
    expect(state).not.toContain("TEST_ACCOUNT");
    const restarted = conservativeGuard(fetchUsage, { stateFile, now: () => time });
    const blocked = await restarted.run(request(), async () => Response.json({ bad: true }));
    expect((await blocked.json() as { error: { code: string } }).error.code).toBe("quota_guard_cooldown");
    expect(reads).toBe(1);
    time += NATIVE_QUOTA_POLL_INTERVAL_MS;
    expect((await restarted.run(request(), async () => Response.json({ ok: true }))).status).toBe(200);
    expect(reads).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two bridge instances sharing a profile cannot poll concurrently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-guard-test-"));
  const stateFile = join(dir, "state.json");
  let reads = 0;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const fetchUsage = async () => { reads++; return Response.json(usage(10, 20)); };
  try {
    const guardA = conservativeGuard(fetchUsage, { stateFile });
    const guardB = conservativeGuard(fetchUsage, { stateFile });
    const first = await guardA.run(request(), async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { stream = controller; },
    })));
    const blocked = await guardB.run(request(), async () => Response.json({ bad: true }));
    expect((await blocked.json() as { error: { code: string } }).error.code).toBe("quota_guard_process_lock");
    expect(reads).toBe(1);
    stream.close();
    expect((await first.body!.getReader().read()).done).toBeTrue();
    const after = await guardB.run(request(), async () => Response.json({ bad: true }));
    expect((await after.json() as { error: { code: string } }).error.code).toBe("quota_guard_cooldown");
    expect(reads).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted persisted cooldown state fails closed without issuing quota requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-guard-test-"));
  const stateFile = join(dir, "state.json");
  try {
    await Bun.write(stateFile, "bad-state");
    let reads = 0;
    const guard = conservativeGuard(async () => { reads++; return Response.json(usage(10, 20)); }, { stateFile });
    const result = await guard.run(request(), async () => Response.json({ bad: true }));
    expect(result.status).toBe(403);
    expect(reads).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server guards native Responses while Web-model turns do not query the Plus quota", async () => {
  let usageReads = 0;
  let nativeSends = 0;
  const fetchUpstream = async (req: Request) => {
      if (req.url.endsWith("/wham/usage")) { usageReads++; return Response.json(usage(96, 10)); }
      nativeSends++;
      return Response.json({ ok: true });
  };
  const server = startServer({ ...defaultConfig("browser-only"), port: 0, nativeQuotaReserveEnabled: true }, {
    fetchUpstream,
    nativeQuotaGuard: conservativeGuard(fetchUpstream),
  });
  try {
    const result = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer TEST_TOKEN" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "hello" }] }),
    });
    expect(result.status).toBe(403);
    expect(usageReads).toBe(1);
    expect(nativeSends).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("enabled bridge defaults to strict without usage polling or forwarding native requests", async () => {
  let calls = 0;
  const server = startServer({ ...defaultConfig("browser-only"), port: 0, nativeQuotaReserveEnabled: true }, {
    fetchUpstream: async () => { calls++; return Response.json({}); },
  });
  try {
    const result = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer TEST_TOKEN" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "hello" }] }),
    });
    expect(result.status).toBe(403);
    expect((await result.json() as { error: { code: string } }).error.code).toBe("quota_guard_strict");
    expect(calls).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("strict bridge also blocks native compact, search and image work without quota probes", async () => {
  let calls = 0;
  const server = startServer({ ...defaultConfig("browser-only"), port: 0, nativeQuotaReserveEnabled: true }, {
    fetchUpstream: async () => { calls++; return Response.json({}); },
  });
  try {
    for (const [endpoint, body] of [
      ["responses/compact", { model: "gpt-5.6-sol", input: [] }],
      ["alpha/search", { query: "check" }],
      ["images/generations", { model: "gpt-image-1", prompt: "tiny image" }],
      ["images/edits", { model: "gpt-image-1", prompt: "edit" }],
    ] as const) {
      const result = await fetch(`http://127.0.0.1:${server.port}/v1/${endpoint}`, {
        method: "POST",
        headers: { authorization: "Bearer TEST_TOKEN", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(result.status).toBe(403);
      expect((await result.json() as { error: { code: string } }).error.code).toBe("quota_guard_strict");
    }
    expect(calls).toBe(0);
  } finally {
    await server.stop(true);
  }
});
