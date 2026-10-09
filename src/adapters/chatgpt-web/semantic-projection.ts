import {
  resolveChatGptWebPhysicalContextLimits,
} from "../../chatgpt-web-models";
import type { CodexMessage, CodexParsedRequest, CodexToolResultMessage } from "../../types";
import { COMPACT_PROMPT } from "../../responses/compaction";
import {
  extractSemanticArtifactLedger,
  renderSemanticArtifactLedger,
  semanticCoveredHistoryDigest,
  semanticHash,
  semanticHistoryItemHash,
  SEMANTIC_DIGEST_POLICY_VERSION,
  semanticMaskToolResult,
  semanticMessageRefs,
  semanticPinnedMessageRefs,
} from "../../responses/semantic-provenance";
import {
  chatGptTurnUserRevisionHistory,
  extractChatGptTurnIdentity,
} from "./environment";
import {
  estimateCompiledChatGptWebInputTokens,
  estimateCompiledChatGptWebMessageTokens,
  compiledChatGptWebMaxMessageChars,
  compiledChatGptWebMessages,
  estimateChatGptWebImageTokens,
} from "./input-tokens";
import { skillFileTokens } from "./skill-attachments";
import { CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities, type ChatGptWebModelMode } from "./model";
import {
  compileChatGptWebPrompt, formatChatGptWebMultipartCommit,
  type CompiledChatGptWebPrompt,
} from "./prompt";
import { estimateTokens } from "../../lib/token-estimate";
import { resolveBiggerContextMultipartParts } from "./usage";
import {
  SEMANTIC_PROJECTION_POLICY_VERSION,
  validateSemanticEpochRecord,
  type StoredChatGptSemanticEpochV1,
} from "./semantic-epoch-store";
import {
  assertChatGptWebInputWithinLimits,
  assertChatGptWebMultipartInputWithinLimits,
  resolveChatGptWebMultipartStagingMode,
} from "./browser-worker";

const SEMANTIC_ESTIMATE_TURN_TOKEN = "turn_00000000000000000000000000000000";
// Preserve a bounded exact window of recent, small, settled tool results.
// Tool evidence remains lower-trust than developer/skill instructions.
const MAX_EXACT_EVIDENCE_RESULTS = 2;
const MAX_EXACT_EVIDENCE_RESULT_TOKENS = 384;
const MAX_EXACT_EVIDENCE_TOTAL_TOKENS = 640;

type RotationSkipReason =
  | "no_completed_turn"
  | "missing_turn_provenance"
  | "missing_source_revision"
  | "outstanding_tools";

export interface SemanticTier0CandidateResult {
  candidate?: StoredChatGptSemanticEpochV1;
  reason?: RotationSkipReason;
}

export interface SemanticProjectionMetrics {
  maskedResults: number;
  maskedTokensEst: number;
  ledgerFiles: number;
  ledgerCommands: number;
  windowSize: number;
  firstMessageTokens: number;
  firstMessageChars: number;
  estimatedInputTokens: number;
  physicalLimit: number;
  multipartParts?: 2 | 6;
  stagingEffort?: ChatGptWebModelMode["effort"];
  maxStageMessageTokens?: number;
  finalMessageTokens?: number;
}

export interface SemanticProjectedRequest {
  parsed: CodexParsedRequest;
  metrics: Omit<SemanticProjectionMetrics, "firstMessageTokens" | "firstMessageChars" | "estimatedInputTokens" | "physicalLimit">;
}

export interface SemanticPreflightResult {
  compiled: CompiledChatGptWebPrompt;
  metrics: Pick<SemanticProjectionMetrics, "firstMessageTokens" | "firstMessageChars" | "estimatedInputTokens" | "physicalLimit" | "multipartParts" | "stagingEffort" | "maxStageMessageTokens" | "finalMessageTokens">;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function canonicalItemValue(canonicalJson: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(canonicalJson));
  } catch {
    return undefined;
  }
}

function sourceRevisionHash(parsed: CodexParsedRequest, sourceTurnId: string): string | undefined {
  const verified = new Map(parsed._semanticProvenance?.items
    .filter(item => item.type === "message" && item.role === "user" && item.itemId && item.turnId)
    .map(item => [item.itemId!, item.turnId!] as const) ?? []);
  const revisions = chatGptTurnUserRevisionHistory(parsed)
    .filter(revision => (revision.turnId ?? (revision.itemId ? verified.get(revision.itemId) : undefined)) === sourceTurnId)
    .map(revision => revision.content);
  return revisions.length > 0 ? semanticHash(revisions) : undefined;
}

function callIdentity(item: Record<string, unknown>): string | undefined {
  if (typeof item.call_id === "string" && item.call_id) return item.call_id;
  if (item.type === "local_shell_call" && typeof item.id === "string" && item.id) return item.id;
  return undefined;
}

function coveredCallsAreSettled(parsed: CodexParsedRequest, cut: number): boolean {
  const items = parsed._semanticProvenance?.items;
  if (!items) return false;
  // A set-membership check can accept duplicate, orphaned, reordered or
  // cross-kind tool results. Retained epochs must bind exactly one result to
  // each covered call before considering that history settled.
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  const resultsByCall: Record<string, string> = {
    function_call: "function_call_output",
    custom_tool_call: "custom_tool_call_output",
    local_shell_call: "function_call_output",
    tool_search_call: "tool_search_output",
  };
  const outputKinds = new Set(Object.values(resultsByCall));
  for (const item of items.slice(0, cut + 1)) {
    const raw = canonicalItemValue(item.canonicalJson);
    if (!raw) return false;
    const kind = String(raw.type);
    if (!Object.hasOwn(resultsByCall, kind) && !outputKinds.has(kind)) continue;
    const identity = callIdentity(raw);
    if (!identity) return false;
    if (Object.hasOwn(resultsByCall, kind)) {
      if (seen.has(identity)) return false;
      seen.add(identity);
      pending.set(identity, resultsByCall[kind]!);
    } else {
      if (pending.get(identity) !== kind) return false;
      pending.delete(identity);
    }
  }
  return pending.size === 0;
}

function priorSourceTurnId(parsed: CodexParsedRequest, cut: number, currentTurnId: string): string | undefined {
  const provenance = parsed._semanticProvenance;
  if (!provenance) return undefined;
  const verified = new Map(provenance.items
    .filter(item => item.type === "message" && item.role === "user" && item.itemId && item.turnId)
    .map(item => [item.itemId!, item.turnId!] as const));
  const revisionTurnIds = new Set(
    chatGptTurnUserRevisionHistory(parsed)
      .map(revision => revision.turnId ?? (revision.itemId ? verified.get(revision.itemId) : undefined))
      .filter((turnId): turnId is string => typeof turnId === "string" && turnId !== currentTurnId),
  );
  for (let index = cut; index >= 0; index -= 1) {
    const turnId = provenance.items[index]?.turnId;
    if (turnId && revisionTurnIds.has(turnId)) return turnId;
  }
  return undefined;
}

export function buildSemanticTier0Candidate(
  parsed: CodexParsedRequest,
  modelFamily: string,
  active: StoredChatGptSemanticEpochV1 | undefined,
  updatedAt = Date.now(),
): SemanticTier0CandidateResult {
  const identity = extractChatGptTurnIdentity(parsed);
  const provenance = parsed._semanticProvenance;
  if (!identity.threadId || !identity.turnId || !provenance) return { reason: "missing_turn_provenance" };
  const currentStart = provenance.items.findIndex(item => item.turnId === identity.turnId);
  if (currentStart <= 0) return { reason: currentStart < 0 ? "missing_turn_provenance" : "no_completed_turn" };

  let cut = -1;
  for (let index = currentStart - 1; index >= 0; index -= 1) {
    const item = provenance.items[index]!;
    if (item.type === "message" && item.role === "assistant") {
      cut = index;
      break;
    }
  }
  if (cut < 0) return { reason: "no_completed_turn" };
  if (!coveredCallsAreSettled(parsed, cut)) return { reason: "outstanding_tools" };

  const sourceTurnId = priorSourceTurnId(parsed, cut, identity.turnId);
  if (!sourceTurnId) return { reason: "missing_source_revision" };
  const sourceUserRevisionHash = sourceRevisionHash(parsed, sourceTurnId);
  if (!sourceUserRevisionHash) return { reason: "missing_source_revision" };
  const anchor = provenance.items[cut]!;
  const artifactLedger = extractSemanticArtifactLedger(parsed, anchor.ref);
  return {
    candidate: {
      version: 1,
      projectionPolicyVersion: SEMANTIC_PROJECTION_POLICY_VERSION,
      digestPolicyVersion: SEMANTIC_DIGEST_POLICY_VERSION,
      threadId: identity.threadId,
      semanticEpoch: (active?.semanticEpoch ?? 0) + 1,
      sourceTurnId,
      sourceAnswerHash: semanticHistoryItemHash(anchor.canonicalJson),
      sourceUserRevisionHash,
      coveredThroughRef: anchor.ref,
      coveredHistoryDigest: semanticCoveredHistoryDigest(provenance, anchor.ref),
      modelFamily,
      tier: 0,
      maskingPolicyVersion: 1,
      artifactLedger,
      updatedAt,
    },
  };
}

function semanticEpochSourceHashes(
  parsed: CodexParsedRequest,
  epoch: StoredChatGptSemanticEpochV1,
): { sourceAnswerHash: string; sourceUserRevisionHash: string } {
  const provenance = parsed._semanticProvenance;
  if (!provenance) throw new Error("Semantic provenance is unavailable");
  const anchor = provenance.items.find(item => item.ref === epoch.coveredThroughRef);
  if (!anchor) throw new Error("Semantic epoch anchor is missing");
  const revisionHash = sourceRevisionHash(parsed, epoch.sourceTurnId);
  if (!revisionHash) throw new Error("Semantic epoch source user revision is missing");
  return {
    sourceAnswerHash: semanticHistoryItemHash(anchor.canonicalJson, epoch.digestPolicyVersion),
    sourceUserRevisionHash: revisionHash,
  };
}

function isMaskableCoveredResult(
  parsed: CodexParsedRequest,
  messageIndex: number,
  cut: number,
): string | undefined {
  const provenance = parsed._semanticProvenance;
  if (!provenance) return undefined;
  for (const ref of semanticMessageRefs(parsed, messageIndex)) {
    const sourceIndex = provenance.items.findIndex(item => item.ref === ref);
    if (sourceIndex < 0 || sourceIndex > cut) continue;
    const source = provenance.items[sourceIndex]!;
    if (!["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(source.type ?? "")) continue;
    const raw = canonicalItemValue(source.canonicalJson);
    if (!raw || typeof raw.call_id !== "string" || !raw.call_id) continue;
    return ref;
  }
  return undefined;
}

export function projectSemanticEpoch(
  parsed: CodexParsedRequest,
  epoch: StoredChatGptSemanticEpochV1,
): SemanticProjectedRequest {
  const provenance = parsed._semanticProvenance;
  if (!provenance) throw new Error("Semantic provenance is unavailable");
  const modelFamily = parsed._chatgptModelFamily;
  if (!modelFamily) throw new Error("Semantic projection requires the current ChatGPT model family");
  const hashes = semanticEpochSourceHashes(parsed, epoch);
  validateSemanticEpochRecord(parsed, epoch, {
    // A dedicated Web compactor may use a different visible model family from
    // the original task. The canonical thread/digest remains the authority.
    modelFamily: parsed._compactionRequest ? epoch.modelFamily : modelFamily,
    ...hashes,
  });
  const cut = provenance.items.findIndex(item => item.ref === epoch.coveredThroughRef);
  if (cut < 0) throw new Error("Semantic epoch anchor is missing");
  // A persisted v1/v2 epoch may have been written by an older rotation policy
  // which only checked that every call ID appeared somewhere in the results.
  // Verify settled pairing again before masking any historical tool evidence.
  if (!coveredCallsAreSettled(parsed, cut)) {
    throw new Error("Semantic epoch covered tool calls are not safely paired");
  }

  const pinRefs = new Set(semanticPinnedMessageRefs(parsed));
  // Re-derive from the verified canonical prefix so that existing persisted
  // epochs and restart/replay use the same exact evidence window.
  const exactEvidenceIndices = new Set<number>();
  let evidenceTokens = 0;
  for (let index = parsed.context.messages.length - 1; index >= 0; index -= 1) {
    if (exactEvidenceIndices.size >= MAX_EXACT_EVIDENCE_RESULTS) break;
    const message = parsed.context.messages[index]!;
    if (message.role !== "toolResult") continue;
    const refs = semanticMessageRefs(parsed, index);
    if (refs.length !== 1) continue;
    const resultRef = isMaskableCoveredResult(parsed, index, cut);
    if (!resultRef) continue;
    const tokens = semanticMaskToolResult(message, resultRef).originalTokens;
    if (tokens > MAX_EXACT_EVIDENCE_RESULT_TOKENS
      || evidenceTokens + tokens > MAX_EXACT_EVIDENCE_TOTAL_TOKENS) continue;
    exactEvidenceIndices.add(index);
    evidenceTokens += tokens;
  }
  const seenPinnedRefs = new Set<string>();
  const coveredMessages: CodexMessage[] = [];
  const suffixMessages: CodexMessage[] = [];
  let maskedResults = 0;
  let maskedTokensEst = 0;

  parsed.context.messages.forEach((message, messageIndex) => {
    const refs = [...semanticMessageRefs(parsed, messageIndex)];
    if (refs.length === 0 && parsed._compactionRequest
      && message.role === "user" && message.content === COMPACT_PROMPT) {
      suffixMessages.push(message);
      return;
    }
    if (refs.length === 0) throw new Error("Semantic projection message is missing canonical provenance");
    const positions = refs.map(ref => provenance.items.findIndex(item => item.ref === ref));
    if (positions.some(position => position < 0)) throw new Error("Semantic projection message ref is missing");
    const beforeOrAtCut = positions.every(position => position <= cut);
    const afterCut = positions.every(position => position > cut);
    if (!beforeOrAtCut && !afterCut) throw new Error("Semantic projection message crosses the covered-history cut");
    if (afterCut) {
      suffixMessages.push(message);
      return;
    }

    for (const ref of refs) {
      if (pinRefs.has(ref)) seenPinnedRefs.add(ref);
    }
    if (message.role === "toolResult") {
      const resultRef = isMaskableCoveredResult(parsed, messageIndex, cut);
      if (resultRef && !exactEvidenceIndices.has(messageIndex)) {
        const masked = semanticMaskToolResult(message as CodexToolResultMessage, resultRef);
        coveredMessages.push(masked.message);
        maskedResults += 1;
        maskedTokensEst += Math.max(0, masked.originalTokens - masked.maskedTokens);
        return;
      }
    }
    coveredMessages.push(message);
  });

  for (const ref of pinRefs) {
    const position = provenance.items.findIndex(item => item.ref === ref);
    if (position <= cut && !seenPinnedRefs.has(ref)) throw new Error("Semantic projection policy pin is missing");
  }
  if (suffixMessages.length === 0) throw new Error("Semantic projection has no exact suffix after its covered cut");

  const ledgerMessage: CodexMessage = {
    role: "user",
    content: renderSemanticArtifactLedger(epoch.artifactLedger),
    timestamp: 0,
  };
  return {
    parsed: {
      ...parsed,
      context: {
        ...parsed.context,
        messages: [...coveredMessages, ledgerMessage, ...suffixMessages],
      },
    },
    metrics: {
      maskedResults,
      maskedTokensEst,
      ledgerFiles: epoch.artifactLedger.filesTouched.length,
      ledgerCommands: epoch.artifactLedger.commands.length,
      windowSize: exactEvidenceIndices.size,
    },
  };
}

export function preflightSemanticProjection(
  projected: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  mode: ChatGptWebModelMode,
  experimentalSkillAttachments: boolean,
  experimentalBiggerContext = false,
): SemanticPreflightResult {
  if (projected.modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error("Semantic epoch preflight supports Sol only");
  }
  // SEM projects the browser-facing clone first. Bigger Context then stages that
  // projection using exactly the same part selection as normal Web submissions.
  const parts = experimentalBiggerContext
    ? resolveBiggerContextMultipartParts(projected, capabilities, experimentalSkillAttachments)
    : undefined;
  const compiled = compileChatGptWebPrompt(
    projected,
    capabilities,
    mode.localTools ? SEMANTIC_ESTIMATE_TURN_TOKEN : undefined,
    { experimentalSkillAttachments, experimentalMultipartParts: parts },
  );
  if (projected._compactionRequest && compiled.trimmedCompactionMessages) {
    // A missing or unverified checkpoint cannot turn an oversized canonical
    // history into a superficially fitting compaction prompt by dropping old
    // source messages. Recovery must keep the exact canonical evidence.
    throw new Error("Semantic compaction preflight cannot discard canonical history");
  }
  const estimatedInputTokens = estimateCompiledChatGptWebInputTokens(compiled, projected.modelId);
  const firstMessageTokens = estimateCompiledChatGptWebMessageTokens(compiled, projected.modelId);
  const firstMessageChars = compiledChatGptWebMaxMessageChars(compiled);
  let multipartMessageMetrics: Pick<SemanticProjectionMetrics, "stagingEffort" | "maxStageMessageTokens" | "finalMessageTokens"> = {};
  if (compiled.multipart) {
    const messages = compiledChatGptWebMessages(compiled);
    const stages = messages.slice(0, -1);
    const maxStageTokens = Math.max(...stages.map(text => estimateTokens(text, projected.modelId)));
    const maxStageChars = Math.max(...stages.map(text => text.length));
    const stagingMode = resolveChatGptWebMultipartStagingMode(
      projected.modelId, capabilities, maxStageTokens, maxStageChars,
    );
    const final = formatChatGptWebMultipartCommit(compiled.multipart, `ctx_${"0".repeat(32)}`);
    const finalMessageTokens = estimateTokens(final, projected.modelId)
      + skillFileTokens(compiled.skillFiles, projected.modelId);
    multipartMessageMetrics = {
      stagingEffort: stagingMode.effort,
      maxStageMessageTokens: maxStageTokens,
      finalMessageTokens,
    };
    assertChatGptWebMultipartInputWithinLimits(
      estimatedInputTokens, firstMessageTokens, projected.modelId, mode.effort,
      capabilities, firstMessageChars, compiled.multipart.parts.length,
      {
        stagingEffort: stagingMode.effort,
        maxStageMessageTokens: maxStageTokens,
        maxStageChars,
        finalMessageTokens,
        finalMessageChars: final.length,
        finalImageTokens: estimateChatGptWebImageTokens(compiled),
      },
      projected._chatgptModelFamily,
    );
  } else {
    // An inline submission must still fit the unchanged one-message boundary.
    assertChatGptWebInputWithinLimits(
      estimatedInputTokens, firstMessageTokens, projected.modelId, mode.effort,
      capabilities, firstMessageChars,
    );
  }
  const { contextWindow } = resolveChatGptWebPhysicalContextLimits(
    projected.modelId,
    mode.effort,
    { ...capabilities, experimentalBiggerContext },
    projected._chatgptModelFamily,
  );
  return {
    compiled,
    metrics: {
      firstMessageTokens,
      firstMessageChars,
      estimatedInputTokens,
      physicalLimit: contextWindow,
      ...multipartMessageMetrics,
      ...(compiled.multipart ? { multipartParts: compiled.multipart.parts.length as 2 | 6 } : {}),
    },
  };
}
