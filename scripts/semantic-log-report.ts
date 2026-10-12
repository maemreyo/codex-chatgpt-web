import { readFileSync } from "node:fs";

type RecordLike = Record<string, unknown>;

export interface SemanticLogReport {
  events: number;
  threads: number;
  turns: number;
  rotations: number;
  rotationsPerThread: Array<{ threadHash: string; rotations: number }>;
  rotationRatioPerThread: number;
  maskedTokensSaved: number;
  loggedCost: {
    samples: number;
    legacyEquivalentSubmissions: number;
    checkpointTailRequests: number;
    checkpointTailTokensEst: number;
    epochRotations: number;
    reseedInputTokensEst: number;
    webCompactionSubmissions: number;
    extraStageSubmissions: number;
    discardedTails: number;
    additionalSubmissionsPer100Legacy: number | null;
  };
  skipsByReason: Record<string, number>;
  validationFailuresByReason: Record<string, number>;
  rejectionsByClass: Record<string, number>;
  rejectionsAfterRotation: number;
  fallbacksByTarget: Record<string, number>;
  fallbacksByReason: Record<string, number>;
  retainedRejectionSignals: {
    total: number;
    repeatedByThread: Array<{ threadHash: string; rejections: number }>;
    rotationPreflightNoFit: number;
  };
  epochReuseByThread: Array<{
    threadHash: string;
    observedEpochs: number;
    semanticTurns: number;
    averageTurnsPerEpoch: number;
    maxTurnsPerEpoch: number;
  }>;
}

const KNOWN_EVENTS = new Set([
  "semantic_turn", "semantic_rotation", "semantic_skip", "semantic_validation_failed",
  "semantic_reject", "semantic_fallback", "semantic_cost",
]);
const SKIP_REASONS = new Set([
  "ineligible", "no_fit", "cooldown", "cap_hit", "outstanding_tools", "unknown_occupancy", "low_pressure",
]);
const VALIDATION_REASONS = new Set(["digest_mismatch", "anchor_missing", "schema", "corrupt_store"]);
const REJECTION_CLASSES = new Set(["A", "B", "C", "D", "unknown"]);
const FALLBACK_TARGETS = new Set(["legacy", "compaction_required", "recovery_error"]);
// Only report reasons produced by this bridge. Never reflect an untrusted log
// string, which could contain a prompt or private model output.
const FALLBACK_REASONS = new Set([
  "web_compaction_cap_hit", "compaction_view_unavailable",
  "active_epoch_validation_failed", "retained_epoch_preflight_failed",
  "rotation_cap_hit_epoch_no_fit", "rotation_cap_hit",
  "rotation_first_message_no_fit", "rotation_cap_changed_before_commit",
  "unknown_occupancy", "physical_pressure",
]);
const THREAD_HASH = /^[a-f0-9]{16}$/;
const COST_KEYS = [
  "legacyEquivalentSubmissions", "checkpointTailRequests", "checkpointTailTokensEst",
  "epochRotations", "reseedInputTokensEst", "webCompactionSubmissions",
  "extraStageSubmissions", "discardedTails",
] as const;

function record(value: unknown): RecordLike | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike
    : undefined;
}

function parseJson(value: string): RecordLike | undefined {
  try { return record(JSON.parse(value)); }
  catch { return undefined; }
}

function semanticEventFromRecord(value: RecordLike): RecordLike | undefined {
  const event = typeof value.event === "string" ? value.event : undefined;
  if (event?.startsWith("semantic_")) {
    const detail = record(value.detail);
    return detail ? { event, ...detail } : value;
  }
  const detail = record(value.detail);
  const nestedLine = typeof detail?.line === "string"
    ? detail.line
    : typeof value.line === "string" ? value.line : undefined;
  if (!nestedLine) return undefined;
  const nested = parseJson(nestedLine.trim());
  return nested ? semanticEventFromRecord(nested) : undefined;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function enumValue(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === "string" && allowed.has(value) ? value : "unknown";
}

export function semanticLogReport(path: string | readonly string[]): SemanticLogReport {
  // Treat rotated, non-overlapping log segments as one ordered event stream.
  // Aggregating separate reports loses per-thread continuity and misstates ratios.
  const paths = typeof path === "string" ? [path] : [...new Set(path)];
  const events = paths.flatMap(file => readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap(line => {
      const decoded = parseJson(line);
      const semantic = decoded ? semanticEventFromRecord(decoded) : undefined;
      return semantic && KNOWN_EVENTS.has(String(semantic.event)) ? [semantic] : [];
    }));

  const threadSet = new Set<string>();
  const rotationsByThread = new Map<string, number>();
  const epochTurnCounts = new Map<string, Map<number, number>>();
  const skipsByReason: Record<string, number> = {};
  const validationFailuresByReason: Record<string, number> = {};
  const rejectionsByClass: Record<string, number> = {};
  const fallbacksByTarget: Record<string, number> = {};
  const fallbacksByReason: Record<string, number> = {};
  const rotatedThreads = new Set<string>();
  const retainedRejectionsByThread = new Map<string, number>();
  let turns = 0;
  let rotations = 0;
  let maskedTokensSaved = 0;
  let rejectionsAfterRotation = 0;
  let retainedRejections = 0;
  let rotationPreflightNoFit = 0;
  let costSamples = 0;
  const costTotals: Record<(typeof COST_KEYS)[number], number> = {
    legacyEquivalentSubmissions: 0, checkpointTailRequests: 0, checkpointTailTokensEst: 0,
    epochRotations: 0, reseedInputTokensEst: 0, webCompactionSubmissions: 0,
    extraStageSubmissions: 0, discardedTails: 0,
  };

  for (const event of events) {
    const type = typeof event.event === "string" ? event.event : "";
    // The input is an exported log, not trusted source code. Never echo arbitrary
    // string values from it as report keys or identifiers.
    const threadHash = typeof event.threadHash === "string" && THREAD_HASH.test(event.threadHash)
      ? event.threadHash : undefined;
    if (threadHash) threadSet.add(threadHash);
    if (type === "semantic_turn" && threadHash && typeof event.epoch === "number"
      && Number.isSafeInteger(event.epoch) && event.epoch >= 1) {
      turns += 1;
      let epochs = epochTurnCounts.get(threadHash);
      if (!epochs) {
        epochs = new Map();
        epochTurnCounts.set(threadHash, epochs);
      }
      epochs.set(event.epoch, (epochs.get(event.epoch) ?? 0) + 1);
    } else if (type === "semantic_rotation" && threadHash) {
      rotations += 1;
      rotatedThreads.add(threadHash);
      rotationsByThread.set(threadHash, (rotationsByThread.get(threadHash) ?? 0) + 1);
      if (Number.isSafeInteger(event.maskedTokensEst) && (event.maskedTokensEst as number) >= 0) {
        maskedTokensSaved += event.maskedTokensEst as number;
      }
    } else if (type === "semantic_skip") {
      const reason = enumValue(event.reason, SKIP_REASONS);
      increment(skipsByReason, reason);
      if (reason === "no_fit") rotationPreflightNoFit += 1;
    } else if (type === "semantic_validation_failed") {
      increment(validationFailuresByReason, enumValue(event.reason, VALIDATION_REASONS));
    } else if (type === "semantic_reject") {
      const rejectionClass = enumValue(event.class, REJECTION_CLASSES);
      increment(rejectionsByClass, rejectionClass);
      if (rejectionClass === "D") {
        retainedRejections += 1;
        if (threadHash) retainedRejectionsByThread.set(
          threadHash, (retainedRejectionsByThread.get(threadHash) ?? 0) + 1,
        );
      }
      if (threadHash && rotatedThreads.has(threadHash)) rejectionsAfterRotation += 1;
    } else if (type === "semantic_fallback") {
      increment(fallbacksByTarget, enumValue(event.to, FALLBACK_TARGETS));
      increment(fallbacksByReason, enumValue(event.reason, FALLBACK_REASONS));
    } else if (type === "semantic_cost" && threadHash) {
      // An invalid or partial cost row must not pollute derived ratios. Logs
      // can be truncated or externally supplied, and content is never echoed.
      if (!COST_KEYS.every(key => Number.isSafeInteger(event[key])
        && (event[key] as number) >= 0)) continue;
      costSamples += 1;
      for (const key of COST_KEYS) costTotals[key] += event[key] as number;
    }
  }

  const rotationsPerThread = [...threadSet]
    .map(threadHash => ({ threadHash, rotations: rotationsByThread.get(threadHash) ?? 0 }))
    .sort((left, right) => right.rotations - left.rotations || left.threadHash.localeCompare(right.threadHash));
  const epochReuseByThread = [...epochTurnCounts].map(([threadHash, epochs]) => {
    const turnCounts = [...epochs.values()];
    const total = turnCounts.reduce((sum, value) => sum + value, 0);
    return {
      threadHash,
      observedEpochs: turnCounts.length,
      semanticTurns: total,
      averageTurnsPerEpoch: turnCounts.length > 0 ? total / turnCounts.length : 0,
      maxTurnsPerEpoch: turnCounts.length > 0 ? Math.max(...turnCounts) : 0,
    };
  }).sort((left, right) => right.averageTurnsPerEpoch - left.averageTurnsPerEpoch
    || right.maxTurnsPerEpoch - left.maxTurnsPerEpoch
    || left.threadHash.localeCompare(right.threadHash)).slice(0, 10);

  const repeatedByThread = [...retainedRejectionsByThread]
    .filter(([, rejections]) => rejections >= 2)
    .map(([threadHash, rejections]) => ({ threadHash, rejections }))
    .sort((left, right) => right.rejections - left.rejections || left.threadHash.localeCompare(right.threadHash));

  return {
    events: events.length,
    threads: threadSet.size,
    turns,
    rotations,
    rotationsPerThread,
    rotationRatioPerThread: threadSet.size > 0 ? rotations / threadSet.size : 0,
    maskedTokensSaved,
    loggedCost: {
      samples: costSamples,
      ...costTotals,
      // This counts declared added calls, not model billing or native steps.
      // Comparing total browser tokens with legacy requires a separate replay.
      additionalSubmissionsPer100Legacy: costTotals.legacyEquivalentSubmissions > 0
        ? 100 * (costTotals.checkpointTailRequests + costTotals.webCompactionSubmissions
          + costTotals.extraStageSubmissions) / costTotals.legacyEquivalentSubmissions
        : null,
    },
    skipsByReason,
    validationFailuresByReason,
    rejectionsByClass,
    rejectionsAfterRotation,
    fallbacksByTarget,
    fallbacksByReason,
    retainedRejectionSignals: {
      total: retainedRejections,
      repeatedByThread,
      rotationPreflightNoFit,
    },
    epochReuseByThread,
  };
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("Usage: bun run scripts/semantic-log-report.ts <older-launcher.jsonl> [newer-launcher.jsonl ...]");
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(semanticLogReport(paths), null, 2));
  }
}
