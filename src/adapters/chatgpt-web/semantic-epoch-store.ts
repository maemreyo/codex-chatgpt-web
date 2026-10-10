import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { atomicWriteFile } from "../../config";
import { decodeCompactionSummary } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import {
  SEMANTIC_DIGEST_POLICY_VERSION,
  SEMANTIC_MASKING_POLICY_VERSION,
  semanticCoveredHistoryDigest,
  semanticCoveredToolCallsExist,
  semanticHash,
  type ChatGptArtifactLedgerV1,
} from "../../responses/semantic-provenance";
import { extractChatGptTurnIdentity } from "./environment";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { SemanticValidationReason } from "./semantic-log";

export const SEMANTIC_PROJECTION_POLICY_VERSION = 1 as const;
const MAX_SEMANTIC_EPOCHS = 256;
const SEMANTIC_EPOCH_TTL_MS = 30 * 24 * 60 * 60_000;

export interface ChatGptSemanticCheckpointPayloadV1 {
  version: 1;
  objective: string;
  decisions: Array<{ text: string; status: "active" | "superseded" }>;
  ruledOut: string[];
  unresolved: string[];
  nextActions: string[];
  notes: string;
  pinRefs: string[];
}

export interface StoredChatGptSemanticEpochV1 {
  version: 1;
  projectionPolicyVersion: 1;
  digestPolicyVersion: 1 | 2 | 3;
  threadId: string;
  semanticEpoch: number;
  sourceTurnId: string;
  sourceAnswerHash: string;
  sourceUserRevisionHash: string;
  coveredThroughRef: string;
  coveredHistoryDigest: string;
  modelFamily: string;
  tier: 0 | 1;
  maskingPolicyVersion: 1;
  artifactLedger: ChatGptArtifactLedgerV1;
  checkpoint?: ChatGptSemanticCheckpointPayloadV1;
  updatedAt: number;
}

interface StoredChatGptSemanticEpochFileV1 {
  version: 1;
  epochs: Record<string, StoredChatGptSemanticEpochV1>;
  quarantines?: Record<string, StoredSemanticEpochQuarantineV1>;
}

interface StoredSemanticEpochQuarantineV1 {
  semanticEpoch: number;
  identityDigest: string;
  reason: SemanticValidationReason;
  updatedAt: number;
  /** Completed native v2 compact response; must be replayed by Codex before reopening SEM. */
  pendingCompactionDigest?: string;
  /** Fence captured by the last successful completion, for exact retry idempotency. */
  pendingCompactionCaptureFence?: string;
}

function quarantineDigestFence(entry: StoredSemanticEpochQuarantineV1, includePending = true): string {
  return semanticHash([
    entry.semanticEpoch, entry.identityDigest, entry.reason, entry.updatedAt,
    ...(includePending && entry.pendingCompactionDigest ? [entry.pendingCompactionDigest] : []),
  ]);
}

const QUARANTINE_REASONS: ReadonlySet<string> = new Set([
  "anchor_missing", "digest_mismatch", "cross_boundary", "schema", "corrupt_store",
]);

export interface SemanticEpochCommitFence {
  expectedSemanticEpoch?: number;
  verifiedAuthority?: boolean;
}

export interface SemanticEpochCommitResult {
  record: StoredChatGptSemanticEpochV1;
  committed: boolean;
  idempotent: boolean;
}

export interface SemanticEpochValidationOptions {
  modelFamily: string;
  sourceAnswerHash?: string;
  sourceUserRevisionHash?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function validLedgerOutcome(item: Record<string, unknown>): boolean {
  // V1 ledgers without `status` remain readable, but a contradictory explicit
  // status must never turn a recorded failure into a claimed success.
  return item.status === undefined || (
    (item.status === "success" || item.status === "failure" || item.status === "unknown")
    && item.failed === (item.status === "failure")
  );
}

function validLedger(value: unknown): value is ChatGptArtifactLedgerV1 {
  const ledger = record(value);
  return Boolean(ledger
    && Array.isArray(ledger.filesTouched)
    && ledger.filesTouched.every(entry => {
      const item = record(entry);
      return typeof item?.path === "string"
        && ["read", "write", "delete", "unknown"].includes(String(item.op))
        && typeof item.ref === "string";
    })
    && Array.isArray(ledger.commands)
    && ledger.commands.every(entry => {
      const item = record(entry);
      return typeof item?.commandDigest === "string"
        && (item.exit === undefined || typeof item.exit === "number")
        && typeof item.failed === "boolean"
        && validLedgerOutcome(item)
        && typeof item.ref === "string";
    })
    && Array.isArray(ledger.testOutcomes)
    && ledger.testOutcomes.every(entry => {
      const item = record(entry);
      return typeof item?.ref === "string"
        && typeof item.failed === "boolean"
        && validLedgerOutcome(item)
        && (item.excerptRef === undefined || typeof item.excerptRef === "string");
    }));
}

function validCheckpoint(value: unknown): value is ChatGptSemanticCheckpointPayloadV1 {
  const checkpoint = record(value);
  return Boolean(checkpoint
    && checkpoint.version === 1
    && typeof checkpoint.objective === "string"
    && Array.isArray(checkpoint.decisions)
    && checkpoint.decisions.every(decision => {
      const item = record(decision);
      return typeof item?.text === "string" && (item.status === "active" || item.status === "superseded");
    })
    && strings(checkpoint.ruledOut)
    && strings(checkpoint.unresolved)
    && strings(checkpoint.nextActions)
    && typeof checkpoint.notes === "string"
    && strings(checkpoint.pinRefs));
}

function validateStoredEpoch(value: unknown): StoredChatGptSemanticEpochV1 {
  const epoch = record(value);
  if (!epoch
    || epoch.version !== 1
    || epoch.projectionPolicyVersion !== SEMANTIC_PROJECTION_POLICY_VERSION
    || ![1, 2, SEMANTIC_DIGEST_POLICY_VERSION].includes(Number(epoch.digestPolicyVersion))
    || epoch.maskingPolicyVersion !== SEMANTIC_MASKING_POLICY_VERSION
    || typeof epoch.threadId !== "string" || !epoch.threadId
    || typeof epoch.semanticEpoch !== "number" || !Number.isInteger(epoch.semanticEpoch) || epoch.semanticEpoch < 1
    || typeof epoch.sourceTurnId !== "string" || !epoch.sourceTurnId
    || typeof epoch.sourceAnswerHash !== "string" || !epoch.sourceAnswerHash
    || typeof epoch.sourceUserRevisionHash !== "string" || !epoch.sourceUserRevisionHash
    || typeof epoch.coveredThroughRef !== "string" || !epoch.coveredThroughRef
    || typeof epoch.coveredHistoryDigest !== "string" || !epoch.coveredHistoryDigest
    || typeof epoch.modelFamily !== "string" || !epoch.modelFamily
    || (epoch.tier !== 0 && epoch.tier !== 1)
    || !validLedger(epoch.artifactLedger)
    || (epoch.checkpoint !== undefined && !validCheckpoint(epoch.checkpoint))
    || (epoch.tier === 0 && epoch.checkpoint !== undefined)
    || typeof epoch.updatedAt !== "number" || !Number.isFinite(epoch.updatedAt)) {
    throw new Error("Invalid persisted ChatGPT semantic epoch record");
  }
  return epoch as unknown as StoredChatGptSemanticEpochV1;
}

function validateQuarantine(value: unknown): StoredSemanticEpochQuarantineV1 {
  const quarantine = record(value);
  if (!quarantine
    || !Number.isSafeInteger(quarantine.semanticEpoch) || Number(quarantine.semanticEpoch) < 1
    || typeof quarantine.identityDigest !== "string" || !/^[a-f0-9]{64}$/.test(quarantine.identityDigest)
    || typeof quarantine.reason !== "string" || !QUARANTINE_REASONS.has(quarantine.reason)
    || typeof quarantine.updatedAt !== "number" || !Number.isFinite(quarantine.updatedAt)
    || (quarantine.pendingCompactionDigest !== undefined
      && (typeof quarantine.pendingCompactionDigest !== "string"
        || !/^[a-f0-9]{64}$/.test(quarantine.pendingCompactionDigest)))
    || (quarantine.pendingCompactionCaptureFence !== undefined
      && (typeof quarantine.pendingCompactionCaptureFence !== "string"
        || !/^[a-f0-9]{64}$/.test(quarantine.pendingCompactionCaptureFence)
        || quarantine.pendingCompactionDigest === undefined))) {
    throw new Error("Invalid persisted ChatGPT semantic epoch quarantine");
  }
  return quarantine as unknown as StoredSemanticEpochQuarantineV1;
}

function invalidState(reason: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `The saved ChatGPT semantic epoch file (semantic-epochs.json) ${reason}. Its contents have not been overwritten. `
    + "Disable experimentalSemanticMemory or start a fresh verified task before recovery.",
    { status: 409, errorType: "invalid_request_error", code: "semantic_epoch_state_invalid", retryable: false },
  );
}

function sameSource(left: StoredChatGptSemanticEpochV1, right: StoredChatGptSemanticEpochV1): boolean {
  return left.threadId === right.threadId
    && left.sourceTurnId === right.sourceTurnId
    && left.sourceAnswerHash === right.sourceAnswerHash
    && left.sourceUserRevisionHash === right.sourceUserRevisionHash
    && left.coveredHistoryDigest === right.coveredHistoryDigest
    && left.modelFamily === right.modelFamily
    && left.tier === right.tier
    && left.projectionPolicyVersion === right.projectionPolicyVersion
    && left.digestPolicyVersion === right.digestPolicyVersion
    && left.maskingPolicyVersion === right.maskingPolicyVersion;
}

export function validateSemanticEpochRecord(
  parsed: CodexParsedRequest,
  epoch: StoredChatGptSemanticEpochV1,
  options: SemanticEpochValidationOptions,
): void {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId || identity.threadId !== epoch.threadId) throw new Error("Semantic epoch thread mismatch");
  if (epoch.modelFamily !== options.modelFamily) throw new Error("Semantic epoch model-family mismatch");
  const provenance = parsed._semanticProvenance;
  if (!provenance) throw new Error("Semantic provenance is unavailable");
  const anchor = provenance.items.find(item => item.ref === epoch.coveredThroughRef);
  if (!anchor) throw new Error("Semantic epoch anchor is missing");
  // V2 ignored the entire live tool registry. An older tool-using epoch
  // cannot retroactively prove that its executed tool schema was stable.
  if (epoch.digestPolicyVersion === 2 && semanticCoveredToolCallsExist(provenance, epoch.coveredThroughRef)) {
    throw new Error("Semantic epoch v2 tool registry is not bound; canonical fallback required");
  }
  if (semanticCoveredHistoryDigest(provenance, epoch.coveredThroughRef, epoch.digestPolicyVersion) !== epoch.coveredHistoryDigest) {
    throw new Error("Semantic epoch covered-history digest mismatch");
  }
  if (options.sourceAnswerHash !== undefined && options.sourceAnswerHash !== epoch.sourceAnswerHash) {
    throw new Error("Semantic epoch source answer mismatch");
  }
  if (options.sourceUserRevisionHash !== undefined && options.sourceUserRevisionHash !== epoch.sourceUserRevisionHash) {
    throw new Error("Semantic epoch source user revision mismatch");
  }
  for (const ref of epoch.checkpoint?.pinRefs ?? []) {
    if (!provenance.items.some(item => item.ref === ref)) throw new Error("Semantic epoch checkpoint pin is missing");
  }
}

/** Durable, bounded active-epoch cache. Authority recovery is opt-in from a separately verified path. */
export class ChatGptSemanticEpochStore {
  private epochs = new Map<string, StoredChatGptSemanticEpochV1>();
  private quarantines = new Map<string, StoredSemanticEpochQuarantineV1>();

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
  ) {}

  get(threadId: string, verifiedAuthority = false): StoredChatGptSemanticEpochV1 | undefined {
    this.load(verifiedAuthority);
    const epoch = this.epochs.get(threadId);
    if (!epoch) return undefined;
    if (this.now() - epoch.updatedAt > SEMANTIC_EPOCH_TTL_MS) {
      // Expiry is a read-only result. A cleanup write from a stale reader
      // could otherwise erase another process's recent commit/quarantine.
      return undefined;
    }
    return structuredClone(epoch);
  }

  /** Read-only guard for canonical fallback before building an epoch candidate. */
  isQuarantined(threadId: string): boolean {
    this.load();
    const quarantine = this.quarantines.get(threadId);
    return quarantine !== undefined && this.now() - quarantine.updatedAt <= SEMANTIC_EPOCH_TTL_MS;
  }

  /** A stable snapshot fence: a concurrent invalidation must not accept an old compaction. */
  quarantineFence(threadId: string): string | undefined {
    this.load();
    const entry = this.quarantines.get(threadId);
    return entry && this.now() - entry.updatedAt <= SEMANTIC_EPOCH_TTL_MS
      ? quarantineDigestFence(entry)
      : undefined;
  }

  /** Remember an actually completed browser compact. It is not yet native acceptance. */
  rememberCompletedCompaction(threadId: string, expectedFence: string | undefined, summary: string): boolean {
    if (!expectedFence || !summary.trim()) return false;
    return this.withWriteLock(() => {
      this.load(false, true);
      const entry = this.quarantines.get(threadId);
      if (!entry || this.now() - entry.updatedAt > SEMANTIC_EPOCH_TTL_MS) {
        return false;
      }
      const digest = semanticHash(summary);
      const currentFence = quarantineDigestFence(entry);
      if (entry.pendingCompactionDigest === digest
        && (expectedFence === currentFence
          || expectedFence === (entry.pendingCompactionCaptureFence ?? quarantineDigestFence(entry, false)))) {
        return true;
      }
      if (currentFence !== expectedFence) return false;
      const next = new Map(this.quarantines);
      next.set(threadId, { ...entry, pendingCompactionDigest: digest, pendingCompactionCaptureFence: expectedFence });
      this.persist(this.epochs, next);
      this.quarantines = next;
      return true;
    });
  }

  /**
   * Reopen only after native Codex sends back the exact v2 compaction item
   * that this bridge completed while the same quarantine was active.
   * A user-text summary, unrelated compact, or failed compact cannot suffice.
   */
  acceptCompletedCompaction(threadId: string, input: unknown): boolean {
    if (!Array.isArray(input)) return false;
    const hasExpectedSummary = (expected: string): boolean => {
      // Only the latest native compaction boundary can authorize recovery.
      // An older matching item may remain in an otherwise unrelated history.
      const last = [...input].reverse().map(record).find(item => item?.type === "compaction");
      if (typeof last?.encrypted_content !== "string") return false;
      const summary = decodeCompactionSummary(last.encrypted_content);
      return summary !== null && semanticHash(summary) === expected;
    };
    // Check before taking a write lock so ordinary quarantined requests make
    // no needless disk mutation. Recheck under the lock against other processes.
    this.load();
    const observed = this.quarantines.get(threadId);
    if (!observed?.pendingCompactionDigest || !hasExpectedSummary(observed.pendingCompactionDigest)) return false;
    return this.withWriteLock(() => {
      this.load(false, true);
      const current = this.quarantines.get(threadId);
      if (!current?.pendingCompactionDigest || !hasExpectedSummary(current.pendingCompactionDigest)) return false;
      const next = new Map(this.quarantines);
      next.delete(threadId);
      this.persist(this.epochs, next);
      this.quarantines = next;
      return true;
    });
  }

  commit(candidate: StoredChatGptSemanticEpochV1, fence: SemanticEpochCommitFence = {}): SemanticEpochCommitResult {
    const validated = validateStoredEpoch(candidate);
    return this.withWriteLock(() => {
      this.load(fence.verifiedAuthority === true, true);
      // A quarantined thread cannot silently create epoch 1 again, including
      // through a delayed callback or a process-restarted replay. A fresh
      // sourceTurnId alone is not independent recovery authority.
      const quarantine = this.quarantines.get(validated.threadId);
      if (quarantine && this.now() - quarantine.updatedAt <= SEMANTIC_EPOCH_TTL_MS) {
        throw new ChatGptWebAdapterError(
          "Semantic epoch thread is quarantined; use canonical fallback until quarantine expires",
          { status: 409, errorType: "invalid_request_error", code: "semantic_epoch_quarantined", retryable: false },
        );
      }
      const current = this.epochs.get(validated.threadId);
      if (current && sameSource(current, validated)) {
        return { record: structuredClone(current), committed: false, idempotent: true };
      }
      const actualEpoch = current?.semanticEpoch;
      if (actualEpoch !== fence.expectedSemanticEpoch) {
        throw new ChatGptWebAdapterError(
          `Semantic epoch commit fence changed (expected ${fence.expectedSemanticEpoch ?? "empty"}, found ${actualEpoch ?? "empty"})`,
          { status: 409, errorType: "invalid_request_error", code: "semantic_epoch_fence_conflict", retryable: false },
        );
      }
      const expectedNext = (actualEpoch ?? 0) + 1;
      if (validated.semanticEpoch !== expectedNext) {
        throw new Error(`Semantic epoch sequence must advance to ${expectedNext}`);
      }
      const nextEpochs = new Map(this.epochs);
      const nextQuarantines = new Map(this.quarantines);
      nextQuarantines.delete(validated.threadId); // May be present but expired.
      nextEpochs.delete(validated.threadId);
      nextEpochs.set(validated.threadId, structuredClone(validated));
      while (nextEpochs.size > MAX_SEMANTIC_EPOCHS) {
        const oldest = nextEpochs.keys().next().value as string | undefined;
        if (!oldest) break;
        nextEpochs.delete(oldest);
      }
      this.persist(nextEpochs, nextQuarantines);
      this.epochs = nextEpochs;
      this.quarantines = nextQuarantines;
      return { record: structuredClone(validated), committed: true, idempotent: false };
    });
  }

  /**
   * Invalidate only the exact epoch observed by the failing validation path.
   * Quarantine blocks even a newly completed canonical source turn; until the
   * bounded TTL elapses, callers must use canonical fallback (or fail closed
   * when canonical history will not fit). No implicit verified-authority reset.
   */
  quarantineIfCurrent(
    threadId: string,
    activeRecord: StoredChatGptSemanticEpochV1,
    reason: SemanticValidationReason,
  ): boolean {
    if (!QUARANTINE_REASONS.has(reason)) throw new Error("Invalid semantic epoch quarantine reason");
    return this.withWriteLock(() => {
      this.load(false, true);
      const current = this.epochs.get(threadId);
      // Hash the entire stored record, including the epoch sequence, timestamps,
      // anchor, policy versions and source digests. Checking only the numeric
      // epoch or sameSource would allow a stale validator to retire its successor.
      if (!current || activeRecord.threadId !== threadId
        || semanticHash(current) !== semanticHash(activeRecord)) return false;
      if (this.quarantines.size >= MAX_SEMANTIC_EPOCHS) {
        throw new Error("Semantic epoch quarantine capacity reached");
      }
      const nextQuarantines = new Map(this.quarantines);
      nextQuarantines.set(threadId, {
        semanticEpoch: current.semanticEpoch,
        identityDigest: semanticHash(current),
        reason,
        updatedAt: this.now(),
      });
      const nextEpochs = new Map(this.epochs);
      nextEpochs.delete(threadId);
      this.persist(nextEpochs, nextQuarantines);
      this.epochs = nextEpochs;
      this.quarantines = nextQuarantines;
      return true;
    });
  }

  /** A crash-held lock deliberately fails closed; no unsafe stale-lock takeover. */
  private withWriteLock<T>(action: () => T): T {
    if (!this.path) return action();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch {
      throw new ChatGptWebAdapterError(
        "Semantic epoch state is locked or unavailable; canonical fallback required",
        { status: 409, errorType: "invalid_request_error", code: "semantic_epoch_store_locked", retryable: false },
      );
    }
    try { return action(); }
    finally { rmdirSync(lock); }
  }

  private load(verifiedAuthority = false, lockHeld = false): void {
    // In-memory stores keep their map. Disk stores must re-read every time:
    // another daemon can replace the entire JSON file after the first load.
    if (!this.path) return;
    if (!existsSync(this.path)) {
      this.epochs = new Map();
      this.quarantines = new Map();
      return;
    }
    const source = readFileSync(this.path, "utf8");
    let decoded: unknown;
    try {
      decoded = JSON.parse(source);
    } catch {
      if (!verifiedAuthority) throw invalidState("contains invalid JSON");
      // Recovery renames the file, so the checked read/rename must be under
      // the same cross-process exclusion as commits and quarantines.
      if (!lockHeld) return this.withWriteLock(() => this.load(true, true));
      if (readFileSync(this.path, "utf8") !== source) throw invalidState("changed during recovery");
      const backup = `${this.path}.corrupt-${randomUUID()}`;
      renameSync(this.path, backup);
      console.warn("[chatgpt-web] preserved corrupt semantic-epochs.json beside the original; rebuilding from verified canonical authority");
      this.epochs = new Map();
      this.quarantines = new Map();
      return;
    }
    const file = record(decoded);
    const rawEpochs = record(file?.epochs);
    const rawQuarantines = file?.quarantines === undefined ? {} : record(file.quarantines);
    if (file?.version !== 1 || !rawEpochs || !rawQuarantines) throw invalidState("has an unsupported or invalid format");
    let entries: Array<readonly [string, StoredChatGptSemanticEpochV1]>;
    let quarantines: Array<readonly [string, StoredSemanticEpochQuarantineV1]>;
    try {
      const cutoff = this.now() - SEMANTIC_EPOCH_TTL_MS;
      const decodedEntries = Object.entries(rawEpochs)
        .map(([threadId, value]) => [threadId, validateStoredEpoch(value)] as const);
      if (decodedEntries.some(([threadId, epoch]) => threadId !== epoch.threadId)) throw new Error("thread mismatch");
      entries = decodedEntries
        .filter(([, epoch]) => epoch.updatedAt >= cutoff)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        .slice(-MAX_SEMANTIC_EPOCHS);
      const decodedQuarantines = Object.entries(rawQuarantines)
        .map(([threadId, value]) => [threadId, validateQuarantine(value)] as const);
      if (decodedQuarantines.some(([threadId]) => !threadId || rawEpochs[threadId] !== undefined)
        || decodedQuarantines.length > MAX_SEMANTIC_EPOCHS) throw new Error("invalid quarantine state");
      quarantines = decodedQuarantines.filter(([, quarantine]) => quarantine.updatedAt >= cutoff);
    } catch {
      throw invalidState("contains invalid epoch records");
    }
    this.epochs = new Map(entries);
    this.quarantines = new Map(quarantines);
  }

  private persist(
    epochs: Map<string, StoredChatGptSemanticEpochV1>,
    quarantines: Map<string, StoredSemanticEpochQuarantineV1>,
  ): void {
    if (!this.path) return;
    const payload: StoredChatGptSemanticEpochFileV1 = {
      version: 1,
      epochs: Object.fromEntries(epochs),
      ...(quarantines.size ? { quarantines: Object.fromEntries(quarantines) } : {}),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`, { durable: true });
  }
}

/** Stable hash helper for source answer/revision records without parser timestamps. */
export function semanticSourceHash(value: unknown): string {
  return semanticHash(value);
}
