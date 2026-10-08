import { fetchNativeCodex } from "./native-network";
import type { NativeFetch } from "./native-passthrough";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, rmdirSync } from "node:fs";
import { atomicWriteFile, parseNativeQuotaReserveSettings, type NativeQuotaReserveSettings } from "./config";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FIVE_HOUR_SECONDS = 18_000;
const WEEK_SECONDS = 604_800;
// No background polling. At most one snapshot and one quota-consuming native request
// per account within this interval, even if callers keep trying.
export const NATIVE_QUOTA_POLL_INTERVAL_MS = 15 * 60_000;
export const NATIVE_QUOTA_FAILURE_COOLDOWN_MS = 60 * 60_000;
export const NATIVE_QUOTA_DENIED_COOLDOWN_MS = 24 * 60 * 60_000;

type Window = { usedPercent: number; durationSeconds: number };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function quotaWindow(value: unknown): Window | undefined {
  const item = record(value);
  if (!item) return undefined;
  const usedPercent = item.used_percent ?? item.usedPercent;
  const durationSeconds = item.limit_window_seconds
    ?? (typeof item.windowDurationMins === "number" ? item.windowDurationMins * 60 : undefined);
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)
    || usedPercent < 0 || usedPercent > 100 || !Number.isInteger(durationSeconds)
    || (durationSeconds !== FIVE_HOUR_SECONDS && durationSeconds !== WEEK_SECONDS)) return undefined;
  return { usedPercent, durationSeconds: durationSeconds as number };
}

export function readNativeQuotaUsage(payload: unknown): { fiveHour: Window; weekly: Window } | undefined {
  const root = record(payload);
  if (!root) return undefined;
  let limits: Record<string, unknown> | undefined;
  const snapshot = root.rate_limit ?? root.rate_limits ?? root.rateLimits;
  if (Array.isArray(snapshot)) {
    limits = record(snapshot.find(item => record(item)?.limit_id === "codex"))
      ?? record(snapshot.length === 1 ? snapshot[0] : undefined);
  } else {
    limits = record(snapshot) ?? (record(root.rateLimitsByLimitId)?.codex as Record<string, unknown> | undefined);
  }
  if (!limits || limits.allowed === false || limits.limit_reached === true) return undefined;
  const fiveHour = new Set<number>();
  const weekly = new Set<number>();
  for (const candidate of [limits.five_hour, limits.weekly, limits.primary_window,
    limits.secondary_window, limits.primary, limits.secondary]) {
    const parsed = quotaWindow(candidate);
    if (parsed?.durationSeconds === FIVE_HOUR_SECONDS) fiveHour.add(parsed.usedPercent);
    if (parsed?.durationSeconds === WEEK_SECONDS) weekly.add(parsed.usedPercent);
  }
  // If the backend changes schema, omits a window, or provides conflicting values, fail closed.
  if (fiveHour.size !== 1 || weekly.size !== 1) return undefined;
  return {
    fiveHour: { usedPercent: [...fiveHour][0]!, durationSeconds: FIVE_HOUR_SECONDS },
    weekly: { usedPercent: [...weekly][0]!, durationSeconds: WEEK_SECONDS },
  };
}

function declined(code: string, message: string): Response {
  // Avoid 429: clients may automatically replay it and exhaust quota in a loop.
  return Response.json({ error: { type: "quota_reserve_guard", code, message } }, { status: 403 });
}

/**
 * Protects native requests forwarded through this bridge only. It does not see other Codex
 * clients, and OpenAI does not publish an upper bound on the quota cost of one native turn.
 */
export class NativeQuotaGuard {
  private busy = false;
  private readonly policy: NativeQuotaReserveSettings;
  private readonly accountPolls = new Map<string, { lastPollAt: number; blockedUntil: number }>();

  constructor(
    private readonly fetchUsage: NativeFetch = fetchNativeCodex,
    private readonly options: { stateFile?: string; now?: () => number; policy?: NativeQuotaReserveSettings } = {},
  ) {
    this.policy = parseNativeQuotaReserveSettings(options.policy);
    if (this.policy.mode === "conservative") this.readState();
  }

  private readState(): void {
    if (!this.options.stateFile || !existsSync(this.options.stateFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.options.stateFile, "utf8")) as {
        version?: unknown;
        entries?: unknown;
      };
      const entries = record(parsed.entries);
      if (parsed.version !== 1 || !entries) throw new Error("Invalid quota guard state");
      this.accountPolls.clear();
      for (const [key, entry] of Object.entries(entries)) {
        const value = record(entry);
        if (!/^[a-f0-9]{64}$/.test(key) || !value
          || typeof value.lastPollAt !== "number" || !Number.isSafeInteger(value.lastPollAt)
          || value.lastPollAt < 0 || typeof value.blockedUntil !== "number"
          || !Number.isSafeInteger(value.blockedUntil) || value.blockedUntil < 0) continue;
        this.accountPolls.set(key, { lastPollAt: value.lastPollAt, blockedUntil: value.blockedUntil });
      }
    } catch {
      // Corrupt/unreadable persisted state must never turn into repeated usage polling.
      this.stateUnavailable = true;
    }
  }

  private stateUnavailable = false;

  private persist(): void {
    if (!this.options.stateFile) return;
    try {
      atomicWriteFile(this.options.stateFile, JSON.stringify({
        version: 1,
        entries: Object.fromEntries(this.accountPolls),
      }));
    } catch {
      this.stateUnavailable = true;
      throw new Error("Native quota guard state could not be persisted");
    }
  }

  private readonly now = () => (this.options.now ?? Date.now)();

  private identity(request: Request): string {
    const accountId = request.headers.get("chatgpt-account-id");
    const authorization = request.headers.get("authorization") ?? "";
    // Retain a hash only; neither Bearer token nor account id is stored or logged.
    return createHash("sha256").update(accountId ? `account:${accountId}` : `auth:${authorization}`).digest("hex");
  }

  private waitResponse(until: number): Response {
    const seconds = Math.max(1, Math.ceil((until - this.now()) / 1000));
    return declined("quota_guard_cooldown", `Native Codex quota protection is cooling down. Retry after at least ${seconds} seconds; no quota check was sent.`);
  }

  async run(request: Request, forward: () => Promise<Response>): Promise<Response> {
    if (this.policy.mode === "strict") {
      // No native quota-consuming request, and no account usage probe, is permitted.
      // This is the only bridge-local mode that does not depend on unbounded turn cost.
      return declined("quota_guard_strict", "Strict quota protection is enabled: native Codex requests are disabled. Select a ChatGPT Web model instead.");
    }
    if (this.stateUnavailable) return declined("quota_guard_state_unavailable", "Native quota guard state is unreadable; native requests withheld.");
    if (this.busy) {
      return declined("quota_guard_busy", "Another native Codex request is in progress. No quota check was sent.");
    }
    this.busy = true;
    let released = false;
    let heldByStream = false;
    let forwarding = false;
    let heldProcessLock = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const onAbort = () => { if (reader) void reader.cancel(request.signal.reason).finally(release); };
    const release = () => {
      if (released) return;
      released = true;
      request.signal.removeEventListener("abort", onAbort);
      if (heldProcessLock && this.options.stateFile) {
        try { rmdirSync(`${this.options.stateFile}.lock`); }
        catch { this.stateUnavailable = true; }
      }
      this.busy = false;
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (this.options.stateFile) {
        try {
          // Atomic directory creation excludes other bridge processes for this profile.
          // A stale crash lock fails closed rather than restarting quota polling.
          mkdirSync(`${this.options.stateFile}.lock`, { mode: 0o700 });
          heldProcessLock = true;
          this.readState();
          if (this.stateUnavailable) {
            return declined("quota_guard_state_unavailable", "Quota guard state could not be read; native requests withheld.");
          }
        } catch {
          return declined("quota_guard_process_lock", "Quota guard is owned by another process or its crash lock needs recovery. No quota check was sent.");
        }
      }
      const authorization = request.headers.get("authorization");
      if (!authorization?.startsWith("Bearer ")) {
        return declined("quota_guard_auth_missing", "Native Codex account authorization is unavailable.");
      }
      const accountKey = this.identity(request);
      const prior = this.accountPolls.get(accountKey);
      const now = this.now();
      if (prior) {
        const nextPoll = Math.max(prior.lastPollAt + NATIVE_QUOTA_POLL_INTERVAL_MS, prior.blockedUntil);
        if (now < nextPoll) return this.waitResponse(nextPoll);
      }
      // Record BEFORE contacting the quota endpoint. Failed/crashed checks cannot be retried
      // in a tight loop, and durable state survives launcher restarts.
      const poll = { lastPollAt: now, blockedUntil: now + NATIVE_QUOTA_FAILURE_COOLDOWN_MS };
      if (this.accountPolls.size >= 32 && !this.accountPolls.has(accountKey)) {
        const oldest = this.accountPolls.keys().next().value;
        if (oldest) this.accountPolls.delete(oldest);
      }
      this.accountPolls.set(accountKey, poll);
      this.persist();
      const headers = new Headers({ authorization, accept: "application/json" });
      const accountId = request.headers.get("chatgpt-account-id");
      if (accountId) headers.set("chatgpt-account-id", accountId);
      const usageRequest = new Request(USAGE_URL, {
        method: "GET", headers,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]),
        redirect: "error",
      });
      const result = await this.fetchUsage(usageRequest);
      if (!result.ok) {
        if ([401, 403, 429].includes(result.status)) {
          poll.blockedUntil = now + NATIVE_QUOTA_DENIED_COOLDOWN_MS;
          this.persist();
        }
        return declined("quota_guard_usage_unavailable", `Could not read Codex plan quota (HTTP ${result.status}).`);
      }
      const usage = readNativeQuotaUsage(await result.json());
      if (!usage) {
        // Unsupported schema or unrecognized account allowance: treat as a durable
        // incompatibility instead of repeatedly probing an undocumented endpoint.
        poll.blockedUntil = now + NATIVE_QUOTA_DENIED_COOLDOWN_MS;
        this.persist();
        return declined("quota_guard_usage_unavailable", "Codex plan quota did not include both verified 5-hour and weekly windows.");
      }
      const remaining5h = 100 - usage.fiveHour.usedPercent;
      const remainingWeek = 100 - usage.weekly.usedPercent;
      const fiveHourReserved = remaining5h <= this.policy.fiveHourAdmissionPercent;
      const weeklyReserved = remainingWeek <= this.policy.weeklyAdmissionPercent;
      if (fiveHourReserved || weeklyReserved) {
        // A depleted weekly allowance is unlikely to become usable during a 15-minute
        // interval. Recheck after at least a day; a depleted 5h window after 5h.
        poll.blockedUntil = now + (weeklyReserved ? NATIVE_QUOTA_DENIED_COOLDOWN_MS : FIVE_HOUR_SECONDS * 1000);
        this.persist();
        return declined("quota_reserve_reached", `Native Codex preflight: 5h ${remaining5h.toFixed(1)}% remaining (admission >${this.policy.fiveHourAdmissionPercent}%), weekly ${remainingWeek.toFixed(1)}% remaining (admission >${this.policy.weeklyAdmissionPercent}%). Conservative mode does not guarantee ${this.policy.fiveHourReservePercent}% / ${this.policy.weeklyReservePercent}% minimum after a single task.`);
      }
      if (request.signal.aborted) return declined("quota_guard_cancelled", "Native Codex request was cancelled.");
      // Successful checks use the shorter normal cooldown; only one native request is
      // admitted per quota snapshot, so cached usage cannot authorize an unlimited burst.
      poll.blockedUntil = now + NATIVE_QUOTA_POLL_INTERVAL_MS;
      this.persist();
      forwarding = true;
      const response = await forward();
      if ([401, 403, 429].includes(response.status)) {
        poll.blockedUntil = now + NATIVE_QUOTA_DENIED_COOLDOWN_MS;
        this.persist();
      }
      if (!response.body) return response;
      reader = response.body.getReader();
      const sourceReader = reader;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await sourceReader.read();
            if (chunk.done) {
              controller.close();
              release();
            } else controller.enqueue(chunk.value);
          } catch (error) {
            controller.error(error);
            release();
          }
        },
        async cancel(reason) {
          try { await sourceReader.cancel(reason); } finally { release(); }
        },
      });
      heldByStream = true;
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (forwarding) throw error;
      return declined("quota_guard_usage_unavailable", "Unable to verify native Codex quota. Native request withheld.");
    } finally {
      // The stream retains ownership until EOF, cancellation or abort. Every other path exits now.
      if (!heldByStream) release();
    }
  }
}
