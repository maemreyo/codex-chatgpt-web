import {
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebPhysicalContextLimits,
  resolveChatGptWebStagingTokenBudget,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import { CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET } from "./input-tokens";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities,
  type ChatGptWebModelMode } from "./model";

export interface ChatGptSubmissionDiagnosticInput {
  modelId: string;
  effort: ChatGptWebModelMode["effort"];
  capabilities: ChatGptWebCapabilities;
  estimatedMessageTokens: number;
  messageChars: number;
  imageTokens: number;
  submissionKind: "ordinary" | "stage" | "final_part";
  part: number;
  totalParts: number;
  reuseConversation: boolean;
  acknowledgedStages: number;
}

/** Only numeric estimates and fixed identifiers reach the existing failure log. */
export function chatGptSubmissionDiagnostics(input: ChatGptSubmissionDiagnosticInput) {
  const { modelId, effort, capabilities } = input;
  if (modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error("Submission diagnostics require an automatic ChatGPT model");
  }
  const { contextWindow } = resolveChatGptWebPhysicalContextLimits(modelId, effort,
    input.submissionKind === "ordinary" ? capabilities : { ...capabilities, experimentalBiggerContext: false });
  const { browserMessageTokenLimit, browserComposerCharLimit } = resolveChatGptWebTransportLimits(
    modelId, effort, capabilities,
  );
  // Ordinary preflight counts the hidden reserve and images against its input ceiling.
  // Multipart preflight also applies separate staging/final visible-message budgets.
  const inputCeiling = modelId === CHATGPT_WEB_LUNA_MODEL_ID
    ? Math.min(contextWindow - 1, CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET)
    : contextWindow - 1;
  const staticMessageTokenBudget = modelId === CHATGPT_WEB_MODEL_ID && input.submissionKind !== "ordinary"
    ? input.submissionKind === "stage"
      ? resolveChatGptWebStagingTokenBudget(modelId, effort, capabilities)
      : resolveChatGptWebMessageTokenBudget(modelId, effort, capabilities, input.imageTokens)
    : Math.max(0, Math.min(inputCeiling - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS - input.imageTokens,
      browserMessageTokenLimit ?? Infinity));
  return {
    mode: modelId === CHATGPT_WEB_LUNA_MODEL_ID ? "luna" : "sol",
    effort,
    accountTier: !capabilities.solAvailable ? "luna" : capabilities.proAvailable ? "pro" : "plus",
    estimatedMessageTokens: input.estimatedMessageTokens,
    messageChars: input.messageChars,
    staticMessageTokenBudget,
    browserMessageTokenLimit: browserMessageTokenLimit ?? null,
    browserComposerCharLimit: browserComposerCharLimit ?? null,
    physicalContextWindow: contextWindow,
    submissionKind: input.submissionKind,
    part: input.part,
    totalParts: input.totalParts,
    reuseConversation: input.reuseConversation,
    acknowledgedStages: input.acknowledgedStages,
    // Legacy retained occupancy is not measured; never imply it is zero.
    ledgerValue: null,
  };
}
