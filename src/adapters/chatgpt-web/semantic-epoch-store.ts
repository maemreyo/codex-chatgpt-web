import { existsSync, readFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { atomicWriteFile } from "../../config";
import type { CodexParsedRequest } from "../../types";
import {
  SEMANTIC_DIGEST_POLICY_VERSION,
  SEMANTIC_MASKING_POLICY_VERSION,
  semanticCoveredHistoryDigest,
  semanticHash,
  type ChatGptArtifactLedgerV1,
} from "../../responses/semantic-provenance";
import { extractChatGptTurnIdentity } from "./environment";
import { ChatGptWebAdapterError } from "./adapter-error";

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
  digestPolicyVersion: 1;
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
}

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
        && typeof item.ref === "string";
    })
    && Array.isArray(ledger.testOutcomes)
    && ledger.testOutcomes.every(entry => {
      const item = record(entry);
      return typeof item?.ref === "string"
        && typeof item.failed === "boolean"
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
    || epoch.digestPolicyVersion !== SEMANTIC_DIGEST_POLICY_VERSION
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
  if (semanticCoveredHistoryDigest(provenance, epoch.coveredThroughRef) !== epoch.coveredHistoryDigest) {
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
  private loaded = false;
  private readonly epochs = new Map<string, StoredChatGptSemanticEpochV1>();

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
  ) {}

  get(threadId: string, verifiedAuthority = false): StoredChatGptSemanticEpochV1 | undefined {
    this.load(verifiedAuthority);
    const epoch = this.epochs.get(threadId);
    if (!epoch) return undefined;
    if (this.now() - epoch.updatedAt > SEMANTIC_EPOCH_TTL_MS) {
      this.epochs.delete(threadId);
      this.persist();
      return undefined;
    }
    return structuredClone(epoch);
  }

  commit(candidate: StoredChatGptSemanticEpochV1, fence: SemanticEpochCommitFence = {}): SemanticEpochCommitResult {
    const validated = validateStoredEpoch(candidate);
    this.load(fence.verifiedAuthority === true);
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
    this.epochs.delete(validated.threadId);
    this.epochs.set(validated.threadId, structuredClone(validated));
    while (this.epochs.size > MAX_SEMANTIC_EPOCHS) {
      const oldest = this.epochs.keys().next().value as string | undefined;
      if (!oldest) break;
      this.epochs.delete(oldest);
    }
    this.persist();
    return { record: structuredClone(validated), committed: true, idempotent: false };
  }

  private load(verifiedAuthority = false): void {
    if (this.loaded) return;
    if (!this.path || !existsSync(this.path)) {
      this.loaded = true;
      return;
    }
    const source = readFileSync(this.path, "utf8");
    let decoded: unknown;
    try {
      decoded = JSON.parse(source);
    } catch {
      if (!verifiedAuthority) throw invalidState("contains invalid JSON");
      if (readFileSync(this.path, "utf8") !== source) throw invalidState("changed during recovery");
      const backup = `${this.path}.corrupt-${randomUUID()}`;
      renameSync(this.path, backup);
      console.warn("[chatgpt-web] preserved corrupt semantic-epochs.json beside the original; rebuilding from verified canonical authority");
      this.loaded = true;
      return;
    }
    const file = record(decoded);
    const rawEpochs = record(file?.epochs);
    if (file?.version !== 1 || !rawEpochs) throw invalidState("has an unsupported or invalid format");
    let entries: Array<readonly [string, StoredChatGptSemanticEpochV1]>;
    try {
      const cutoff = this.now() - SEMANTIC_EPOCH_TTL_MS;
      const decodedEntries = Object.entries(rawEpochs)
        .map(([threadId, value]) => [threadId, validateStoredEpoch(value)] as const);
      if (decodedEntries.some(([threadId, epoch]) => threadId !== epoch.threadId)) throw new Error("thread mismatch");
      entries = decodedEntries
        .filter(([, epoch]) => epoch.updatedAt >= cutoff)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        .slice(-MAX_SEMANTIC_EPOCHS);
    } catch {
      throw invalidState("contains invalid epoch records");
    }
    for (const [threadId, epoch] of entries) this.epochs.set(threadId, epoch);
    this.loaded = true;
  }

  private persist(): void {
    if (!this.path) return;
    const payload: StoredChatGptSemanticEpochFileV1 = {
      version: 1,
      epochs: Object.fromEntries(this.epochs),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`, { durable: true });
  }
}

/** Stable hash helper for source answer/revision records without parser timestamps. */
export function semanticSourceHash(value: unknown): string {
  return semanticHash(value);
}
