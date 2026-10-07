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
  skipsByReason: Record<string, number>;
  rejectionsByClass: Record<string, number>;
  rejectionsAfterRotation: number;
  fallbacksByTarget: Record<string, number>;
  slowestStepsPerTurnThreads: Array<{
    threadHash: string;
    turns: number;
    averageStepsPerTurn: number;
    maxStepsPerTurn: number;
  }>;
}

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

export function semanticLogReport(path: string): SemanticLogReport {
  const events = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap(line => {
      const decoded = parseJson(line);
      const semantic = decoded ? semanticEventFromRecord(decoded) : undefined;
      return semantic ? [semantic] : [];
    });

  const threadSet = new Set<string>();
  const rotationsByThread = new Map<string, number>();
  const stepCounts = new Map<string, Map<number, number>>();
  const skipsByReason: Record<string, number> = {};
  const rejectionsByClass: Record<string, number> = {};
  const fallbacksByTarget: Record<string, number> = {};
  const rotatedThreads = new Set<string>();
  let turns = 0;
  let rotations = 0;
  let maskedTokensSaved = 0;
  let rejectionsAfterRotation = 0;

  for (const event of events) {
    const type = typeof event.event === "string" ? event.event : "";
    const threadHash = typeof event.threadHash === "string" ? event.threadHash : undefined;
    if (threadHash) threadSet.add(threadHash);
    if (type === "semantic_turn" && threadHash && typeof event.epoch === "number") {
      turns += 1;
      let epochs = stepCounts.get(threadHash);
      if (!epochs) {
        epochs = new Map();
        stepCounts.set(threadHash, epochs);
      }
      epochs.set(event.epoch, (epochs.get(event.epoch) ?? 0) + 1);
    } else if (type === "semantic_rotation" && threadHash) {
      rotations += 1;
      rotatedThreads.add(threadHash);
      rotationsByThread.set(threadHash, (rotationsByThread.get(threadHash) ?? 0) + 1);
      if (typeof event.maskedTokensEst === "number" && Number.isFinite(event.maskedTokensEst)) {
        maskedTokensSaved += Math.max(0, event.maskedTokensEst);
      }
    } else if (type === "semantic_skip") {
      increment(skipsByReason, typeof event.reason === "string" ? event.reason : "unknown");
    } else if (type === "semantic_reject") {
      increment(rejectionsByClass, typeof event.class === "string" ? event.class : "unknown");
      if (threadHash && rotatedThreads.has(threadHash)) rejectionsAfterRotation += 1;
    } else if (type === "semantic_fallback") {
      increment(fallbacksByTarget, typeof event.to === "string" ? event.to : "unknown");
    }
  }

  const rotationsPerThread = [...threadSet]
    .map(threadHash => ({ threadHash, rotations: rotationsByThread.get(threadHash) ?? 0 }))
    .sort((left, right) => right.rotations - left.rotations || left.threadHash.localeCompare(right.threadHash));
  const slowestStepsPerTurnThreads = [...stepCounts].map(([threadHash, epochs]) => {
    const steps = [...epochs.values()];
    const total = steps.reduce((sum, value) => sum + value, 0);
    return {
      threadHash,
      turns: steps.length,
      averageStepsPerTurn: steps.length > 0 ? total / steps.length : 0,
      maxStepsPerTurn: steps.length > 0 ? Math.max(...steps) : 0,
    };
  }).sort((left, right) => right.averageStepsPerTurn - left.averageStepsPerTurn
    || right.maxStepsPerTurn - left.maxStepsPerTurn
    || left.threadHash.localeCompare(right.threadHash)).slice(0, 10);

  return {
    events: events.length,
    threads: threadSet.size,
    turns,
    rotations,
    rotationsPerThread,
    rotationRatioPerThread: threadSet.size > 0 ? rotations / threadSet.size : 0,
    maskedTokensSaved,
    skipsByReason,
    rejectionsByClass,
    rejectionsAfterRotation,
    fallbacksByTarget,
    slowestStepsPerTurnThreads,
  };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: bun run scripts/semantic-log-report.ts <launcher.jsonl>");
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(semanticLogReport(path), null, 2));
  }
}
