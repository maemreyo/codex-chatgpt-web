import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  buildIsolationProfile,
  classifySyntheticOutcome,
  createLoopbackFixture,
  enforceSandbox,
  FINITE_CASES,
  validatePort,
} from "../scripts/smoke-codex-sem-recovery";

describe("native SEM recovery harness", () => {
  test("emits response.failed SSE and terminal JSON contracts for every recovery scenario", async () => {
    expect(FINITE_CASES.filter((item) => item.transport === "json_http_400").map((item) => item.category)).toEqual([
      "chatgpt_active_turn_compaction_required",
      "context_length_exceeded",
    ]);
    expect(new Set(FINITE_CASES.map((item) => item.name)).size).toBe(FINITE_CASES.length);
    for (const item of FINITE_CASES) {
      const fixture = createLoopbackFixture(2, 2000, item);
      try {
        const response = await fetch(`${fixture.url}/responses`);
        const body = await response.text();

        if (item.transport !== "sse_http_200") {
          expect(response.status).toBe(item.transport === "json_http_400" ? 400 : 409);
          const parsed = JSON.parse(body);
          expect(parsed.error.type).toBe("invalid_request_error");
          expect(parsed.error.code).toBe(item.category);
          expect(parsed.error.retryable).toBe(false);
        } else {
          expect(response.status).toBe(200);
          const failed = body
            .split("data: ")
            .map((part) => part.split("\n")[0])
            .filter((part) => part.startsWith("{"))
            .map((text) => JSON.parse(text))
            .find((event) => event.type === "response.failed");
          expect(failed.response.error.code).toBe(item.category);
          expect(failed.response.error.retryable).toBe(false);
        }
      } finally {
        fixture.cleanup();
      }
    }
  });

  test("HTTP 400 terminal cases distinguish no retry, client retry, and capped requests", async () => {
    const requestCap = 3;
    for (const item of FINITE_CASES.filter((entry) => entry.transport === "json_http_400")) {
      const fixture = createLoopbackFixture(requestCap, 2000, item);
      try {
        const terminal = await fetch(`${fixture.url}/responses`);
        expect(terminal.status).toBe(400);
        expect(fixture.requestCount).toBe(1);
        expect(classifySyntheticOutcome({ requestCount: fixture.requestCount, requestCap, sandboxAvailable: true }))
          .toBe("native_terminal_no_retry");

        const retried = await fetch(`${fixture.url}/responses`);
        expect(retried.status).toBe(400);
        expect(classifySyntheticOutcome({ requestCount: fixture.requestCount, requestCap, sandboxAvailable: true, clientRetried: true }))
          .toBe("client_retry_observed");

        expect((await fetch(`${fixture.url}/responses`)).status).toBe(400);
        expect(classifySyntheticOutcome({ requestCount: fixture.requestCount, requestCap, sandboxAvailable: true, clientRetried: true }))
          .toBe("harness_limit_reached");
        expect((await fetch(`${fixture.url}/responses`)).status).toBe(429);
        expect(fixture.requestCount).toBe(requestCap + 1);
        expect(fixture.counts.get(item.category)).toBe(requestCap);
        expect(fixture.compactCount).toBe(0);
      } finally {
        fixture.cleanup();
      }
    }
  });

  test("keeps repeated fixed-code requests and route counters deterministic", async () => {
    const fixture = createLoopbackFixture(5, 2000, FINITE_CASES[0]);
    try {
      await fetch(`${fixture.url}/responses`);
      await fetch(`${fixture.url}/responses`);
      await fetch(`${fixture.url}/models`);
      await fetch(`${fixture.url}/responses/compact`);
      expect(fixture.requestCount).toBe(2);
      expect(fixture.compactCount).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  test("classifies setup, timeout, cap, compact, and retry outcomes", () => {
    const cases = [
      [{ requestCount: 0, requestCap: 4, sandboxAvailable: true }, "SETUP_ERROR"],
      [{ requestCount: 1, requestCap: 1, sandboxAvailable: true }, "harness_limit_reached"],
      [{ requestCount: 1, requestCap: 4, sandboxAvailable: true, timedOut: true }, "harness_limit_reached"],
      [{ requestCount: 1, requestCap: 4, sandboxAvailable: true, compactRequested: true }, "native_requested_compact"],
      [{ requestCount: 2, requestCap: 4, sandboxAvailable: true, clientRetried: true }, "client_retry_observed"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(classifySyntheticOutcome(input)).toBe(expected);
    }
  });

  test("keeps sandbox profile host and port validation explicit", () => {
    expect(buildIsolationProfile(43210)).toContain("remote ip \"localhost:43210\"");
    expect(() => validatePort(0)).toThrow();
  });

  test("reaps fake child cleanup paths and fails closed on bad helper output", async () => {
    const events: string[] = [];
    const fakeRunner = () => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => events.push("killed");
      setTimeout(() => child.emit("close", 0), 0);
      return child;
    };
    const result = await enforceSandbox("profile", "http://127.0.0.1:1", "http://127.0.0.1:2", fakeRunner as any, { timeoutMs: 10, killGroup: () => events.push("group-killed") });
    expect(result.reason).toBe("invalid_helper_result");
    expect(events).toEqual([]);
  });
});
