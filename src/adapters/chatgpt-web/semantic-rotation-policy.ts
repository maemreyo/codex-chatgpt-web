// Rotate an existing healthy epoch only when the browser approaches its
// physical working set or the newly covered history offers material savings.
// Unknown occupancy never authorizes a cheap reuse of a retained browser tab.
const PHYSICAL_PRESSURE_FRACTION = 0.70;
const ROTATION_MIN_INCREMENTAL_SAVINGS = 8_192;
const PHYSICAL_RESERVE_TOKENS = 12_288;

export type SemanticRotationDecision = "reuse" | "physical_pressure" | "token_savings" | "unknown_occupancy";

export function decideSemanticEpochRotation(input: {
  occupancyConfidence: "known" | "unknown";
  occupancyTokens: number | null;
  nextMessageTokens: number;
  physicalLimit: number;
  incrementalSavingsTokens: number;
}): SemanticRotationDecision {
  if (input.occupancyConfidence !== "known" || input.occupancyTokens === null) return "unknown_occupancy";
  if (input.physicalLimit <= PHYSICAL_RESERVE_TOKENS ||
    input.occupancyTokens + input.nextMessageTokens + PHYSICAL_RESERVE_TOKENS
      >= input.physicalLimit * PHYSICAL_PRESSURE_FRACTION) return "physical_pressure";
  if (input.incrementalSavingsTokens >= ROTATION_MIN_INCREMENTAL_SAVINGS) return "token_savings";
  return "reuse";
}
