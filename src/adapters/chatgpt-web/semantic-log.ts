import { createHash } from "node:crypto";

export type SemanticSkipReason =
  | "ineligible"
  | "no_fit"
  | "cooldown"
  | "cap_hit"
  | "outstanding_tools"
  | "cross_boundary"
  | "unknown_occupancy"
  | "low_pressure";

/** Bounded diagnostics; no user text, environment data, or tool payloads. */
export type SemanticIneligibleDetail =
  | "manual_interaction" | "compaction" | "model_mismatch" | "model_family_missing"
  | "local_tools_disabled" | "trusted_environment_missing" | "launcher_missing"
  | "fresh_conversation" | "thread_missing" | "missing_turn_provenance"
  | "no_completed_turn" | "missing_source_revision";

export type SemanticValidationReason = "digest_mismatch" | "anchor_missing" | "cross_boundary" | "schema" | "corrupt_store";
export type SemanticRotationReason = "initial" | "unknown_occupancy" | "model_family_change"
  | "physical_pressure" | "token_savings";

export type SemanticLogEvent =
  | {
      event: "semantic_turn";
      threadHash: string;
      epoch: number;
      tier: 0;
      canonicalTokens: number;
      nextWireTokens: number;
      estimatedEpochOccupancy: number | null;
      occupancyConfidence: "known" | "reconstructed" | "unknown";
      physicalLimit: number;
    }
  | {
      event: "semantic_rotation";
      threadHash: string;
      fromEpoch: number;
      toEpoch: number;
      reason: SemanticRotationReason;
      firstMessageTokens: number;
      firstMessageChars: number;
      fitsSingleMessage: boolean;
      maskedResults: number;
      maskedTokensEst: number;
      ledgerFiles: number;
      ledgerCommands: number;
      windowSize: number;
    }
  | { event: "semantic_skip"; threadHash: string; reason: SemanticSkipReason;
      detail?: SemanticIneligibleDetail }
  | {
      event: "semantic_validation_failed";
      threadHash: string;
      reason: SemanticValidationReason;
      fellBackTo: "legacy" | "recovery_error";
    }
  | {
      event: "semantic_reject";
      threadHash: string;
      kind: "http_413" | "sse_input_too_large";
      mode: string;
      effort: string;
      estimatedMessageTokens: number;
      messageChars: number;
      ledgerValue: number | null;
      class: "A" | "B" | "C" | "D" | "unknown";
    }
  | {
      event: "semantic_fallback";
      threadHash: string;
      to: "legacy" | "compaction_required" | "recovery_error";
      reason: string;
    }
  | {
      event: "semantic_cost";
      threadHash: string;
      epoch: number;
      checkpointTailRequests: 0;
      checkpointTailTokensEst: 0;
      epochRotations: 0 | 1;
      reseedInputTokensEst: number;
      webCompactionSubmissions: 0;
      extraStageSubmissions: number;
      maskedResults: number;
      maskedTokensEst: number;
      discardedTails: 0;
      legacyEquivalentSubmissions: 1;
    };

export function semanticThreadHash(threadId: string): string {
  return createHash("sha256").update(threadId).digest("hex").slice(0, 16);
}

/** Experimental events contain counters, enums and hashed identifiers only. */
export function emitSemanticLog(event: SemanticLogEvent): void {
  console.info(JSON.stringify(event));
}

export function semanticValidationReason(error: unknown): SemanticValidationReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/crosses the covered-history cut/i.test(message)) return "cross_boundary";
  if (/digest mismatch/i.test(message)) return "digest_mismatch";
  if (/anchor is missing/i.test(message)) return "anchor_missing";
  if (/unsupported|invalid format|invalid epoch records|invalid persisted/i.test(message)) return "schema";
  if (/invalid JSON|changed during recovery/i.test(message)) return "corrupt_store";
  return "schema";
}
