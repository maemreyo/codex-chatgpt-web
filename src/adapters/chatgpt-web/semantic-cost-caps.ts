import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile } from "../../config";
import { ChatGptWebAdapterError } from "./adapter-error";

/** Conservative submission guardrails, not estimates of account charges. */
export const SEMANTIC_COST_WINDOW_MS = 60 * 60_000;
export const SEMANTIC_ROTATIONS_PER_HOUR = 4;
export const SEMANTIC_WEB_COMPACTIONS_PER_HOUR = 4;

type Kind = "rotations" | "compactions";
type Charge = { at: number; operationId: string };
type ThreadCharges = { rotations: Charge[]; compactions: Charge[] };
type CostFile = { version: 1; threads: Record<string, ThreadCharges> };

function unavailable(reason: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(`Semantic cost budget state is unavailable (${reason}); no additional Web work was authorized.`, {
    status: 409, errorType: "invalid_request_error", code: "semantic_cost_budget_unavailable", retryable: false,
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validCharges(value: unknown): value is Charge[] {
  return Array.isArray(value) && value.every(entry => entry && typeof entry === "object"
    && Object.keys(entry).length === 2
    && typeof entry.operationId === "string" && /^[a-f0-9]{64}$/.test(entry.operationId)
    && Number.isSafeInteger(entry.at) && entry.at >= 0);
}

/** A durable, cross-daemon per-thread budget. A stale crash lock fails closed until repaired. */
export class SemanticCostCaps {
  private threads = new Map<string, ThreadCharges>();
  private failed = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxRotations = SEMANTIC_ROTATIONS_PER_HOUR,
    private readonly maxCompactions = SEMANTIC_WEB_COMPACTIONS_PER_HOUR,
    private readonly stateFile?: string,
  ) {}

  canRotate(threadId: string, operationId: string): boolean {
    return this.allowed("rotations", threadId, operationId);
  }

  /** Reserve *before* the epoch commit: a crash can underuse budget, never erase a committed charge. */
  recordRotation(threadId: string, operationId: string): boolean {
    return this.charge("rotations", threadId, operationId);
  }

  /** Reserve before a Web compaction submission, including retained handoff and fresh fallback. */
  recordCompaction(threadId: string, operationId: string): boolean {
    return this.charge("compactions", threadId, operationId);
  }

  count(threadId: string, kind: Kind = "rotations"): number {
    this.refresh();
    return this.active(threadId)[kind].length;
  }

  private ensureAvailable(): void {
    if (this.failed) throw unavailable("previous read/write or lock failure");
  }

  private refresh(): void {
    this.ensureAvailable();
    if (!this.stateFile) return;
    try {
      if (!existsSync(this.stateFile)) {
        this.threads = new Map();
        return;
      }
      const file: unknown = JSON.parse(readFileSync(this.stateFile, "utf8"));
      if (!file || typeof file !== "object" || Array.isArray(file)) throw Error("invalid budget file");
      const state = file as Partial<CostFile>;
      if (state.version !== 1 || !state.threads || typeof state.threads !== "object"
        || Array.isArray(state.threads)) throw Error("invalid budget schema");
      const next = new Map<string, ThreadCharges>();
      for (const [key, entry] of Object.entries(state.threads)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !entry || typeof entry !== "object"
          || !validCharges(entry.rotations) || !validCharges(entry.compactions)) {
          throw Error("invalid budget charges");
        }
        next.set(key, entry);
      }
      this.threads = next;
    } catch {
      this.failed = true;
      throw unavailable("corrupt or unreadable state");
    }
  }

  private active(threadId: string): ThreadCharges {
    if (!threadId.trim()) throw unavailable("missing native thread identity");
    const key = digest(threadId);
    const now = this.now();
    const entry = this.threads.get(key) ?? { rotations: [], compactions: [] };
    for (const kind of ["rotations", "compactions"] as const) {
      entry[kind] = entry[kind].filter(charge => now >= charge.at && now - charge.at < SEMANTIC_COST_WINDOW_MS);
    }
    this.threads.set(key, entry);
    return entry;
  }

  private allowed(kind: Kind, threadId: string, operationId: string): boolean {
    this.refresh();
    if (!operationId.trim()) throw unavailable("missing operation identity");
    const charges = this.active(threadId)[kind];
    return charges.some(charge => charge.operationId === digest(operationId))
      || charges.length < (kind === "rotations" ? this.maxRotations : this.maxCompactions);
  }

  private charge(kind: Kind, threadId: string, operationId: string): boolean {
    this.ensureAvailable();
    if (!this.stateFile) return this.chargeLoaded(kind, threadId, operationId) !== "denied";
    let locked = false;
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
      // Cross-process exclusion also fences a separate daemon reading and writing this file.
      mkdirSync(`${this.stateFile}.lock`, { mode: 0o700 });
      locked = true;
      this.refresh();
      const result = this.chargeLoaded(kind, threadId, operationId);
      if (result === "new") {
        atomicWriteFile(this.stateFile, `${JSON.stringify({ version: 1, threads: Object.fromEntries(this.threads) })}\n`,
          { durable: true });
        // Persist the rename as well as file content on filesystems supporting directory fsync.
        if (process.platform !== "win32") {
          const fd = openSync(dirname(this.stateFile), "r");
          try { fsyncSync(fd); } finally { closeSync(fd); }
        }
      }
      return result !== "denied";
    } catch {
      this.failed = true;
      throw unavailable("lock, state or durable write failure");
    } finally {
      if (locked) {
        try { rmdirSync(`${this.stateFile}.lock`); }
        catch { this.failed = true; }
      }
    }
  }

  private chargeLoaded(kind: Kind, threadId: string, operationId: string): "new" | "existing" | "denied" {
    if (!operationId.trim()) throw unavailable("missing operation identity");
    const charges = this.active(threadId)[kind];
    const key = digest(operationId);
    if (charges.some(charge => charge.operationId === key)) return "existing";
    if (charges.length >= (kind === "rotations" ? this.maxRotations : this.maxCompactions)) return "denied";
    charges.push({ at: this.now(), operationId: key });
    return "new";
  }
}
