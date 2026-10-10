import { createHash, randomBytes } from "node:crypto";
import { getCodexHome } from "../../codex-integration-shared";
import { dirname, join, resolve } from "node:path";
import { isChatGptWebZeroRiskBackendModel, resolveChatGptWebPhysicalContextLimits } from "../../chatgpt-web-models";
import { defaultBrokerEndpoint, expandUserPath, getConfigDir, resolveBrokerEndpoint } from "../../config";
import {
  cancelLauncherManualTurn,
  endLauncherManualTurn,
  LauncherBrowserTurnCancelledError,
  LauncherManualTurnFailedError,
  LauncherManualTurnTimedOutError,
  markLauncherManualTurnStarted,
  releaseLauncherRetainedConversation,
  startLauncherManualTurn,
  waitForLauncherManualSent,
  waitForLauncherManualTerminal,
  type LauncherManualTurnEnd,
  type LauncherManualTurnOwner,
  type LauncherManualTurnStart,
} from "../../launcher-browser-host";
import { namespacedToolName, type AdapterEvent, type CodexContentPart, type CodexParsedRequest, type CodexProviderConfig, type CodexToolResultMessage, type CodexUsage } from "../../types";
import type { ProviderAdapter } from "../base";
import { parseDataUrl } from "../image";
import { ChatGptWebAdapterError, chatGptToolTimeoutError } from "./adapter-error";
import { ChatGptBrowserWorker, resolveChatGptWebMultipartStagingMode, type ChatGptSubmissionRejectionObservation } from "./browser-worker";
import { chatGptTurnUserRevisionHistory, extractChatGptTurnEnvironment, extractChatGptTurnIdentity, extractChatGptRootThreadMetadata, extractChatGptThreadSpawnLineage, priorChatGptAbortedTurnIds } from "./environment";
import { verifiedCodexSemanticUserTurns } from "./codex-rollout-environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities, type ChatGptWebModelMode } from "./model";
import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt } from "./prompt";
import { compiledChatGptWebMessages } from "./input-tokens";
import { skillFileTokens } from "./skill-attachments";
import { createChatGptStructuredOutputValidator } from "./output-validation";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { MAX_OVERSIZED_RESULT_CHARS, MAX_OVERSIZED_TURN_CHARS, TurnBroker, type BrokerToolRequest, type BrokerToolResult, type TurnBrokerOwner } from "./turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptInstructionLineage, chatGptThreadOwnershipKey, chatGptTurnExecutionKey, chatGptTurnRetryKey, chatGptTurnRoundKey, chatGptTurnSessions, type ChatGptBrowserOutcome, type ChatGptTraceEvent, type ChatGptTurnRuntime, type ChatGptTurnSession } from "./turn-execution";
import { estimateChatGptWebInputTokens, estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import {
  ChatGptLunaCheckpointStore,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import { ChatGptExternalTurnProgress } from "./turn-progress";
import {
  canonicalizeCompactionHandoff,
  existingStructuredCompactionRun,
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
  settleActiveZeroRiskCompactionSource,
} from "./compaction-handoff";
import {
  chatGptConversationKey,
  retainedConversationResumeRequest,
} from "./conversation-key";
import { ChatGptSemanticEpochStore, type StoredChatGptSemanticEpochV1 } from "./semantic-epoch-store";
import { SemanticCostCaps, SEMANTIC_ROTATIONS_PER_HOUR, SEMANTIC_WEB_COMPACTIONS_PER_HOUR } from "./semantic-cost-caps";
import { semanticEpochOccupancies } from "./semantic-occupancy";
import { decideSemanticEpochRotation } from "./semantic-rotation-policy";
import { SemanticMessageCeilings } from "./semantic-message-ceiling";
import { estimateTokens } from "../../lib/token-estimate";
import {
  buildSemanticTier0Candidate,
  preflightSemanticProjection,
  projectSemanticEpoch,
  type SemanticProjectionMetrics,
} from "./semantic-projection";
import {
  emitSemanticLog,
  semanticThreadHash,
  semanticValidationReason,
  type SemanticIneligibleDetail,
  type SemanticRotationReason,
} from "./semantic-log";
import { classifyCanonicalCompaction } from "../../responses/compaction-route";

// The occupancy ledger is process-local. After a restart, the old retained
// browser chat cannot safely inherit an empty ledger, so each process must use
// a fresh semantic conversation key and resend the verified projection.
const SEMANTIC_BROWSER_PROCESS_NONCE = randomBytes(16).toString("hex");

function bindAdapterCompactionProtocol(parsed: CodexParsedRequest): void {
  if (parsed._canonicalCompactionProtocol !== undefined) return;
  const protocol = classifyCanonicalCompaction(parsed._rawBody, "responses");
  if (protocol !== undefined) parsed._canonicalCompactionProtocol = protocol;
}

function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.chatgptWeb?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof ChatGptWebAdapterError) return signal.reason;
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

class ChatGptObserverDisconnected extends DOMException {
  constructor(readonly cause: unknown) {
    super("The Codex response stream disconnected", "AbortError");
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

function cancellableBrowserTurn(
  run: Promise<string>,
  controller: AbortController,
): { browser: Promise<string>; physicalSettlement: Promise<void>; cancel: (reason?: Error) => void } {
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  let cancellationRejected = false;
  return {
    // Cancellation wins immediately even while the detached Playwright helper is still unwinding.
    // The helper keeps the same abort signal and remains responsible for its normal end/cleanup
    // handshake, but the Codex Responses turn no longer waits on that process cleanup.
    browser: Promise.race([run, cancellation]),
    // `browser` is the fast client-facing result. Replacement ownership must wait for the actual
    // worker promise, whose finally block completes the launcher /turn/end handshake.
    physicalSettlement: run.then(() => undefined, () => undefined),
    cancel(reason?: Error) {
      if (!controller.signal.aborted) controller.abort(reason);
      // Explicit targeted cancellation ends the Codex Responses turn immediately. Generic
      // retirement (client disconnect or compaction replacement) still waits for the helper's
      // cleanup handshake before a replacement browser may start.
      if (reason && !cancellationRejected) {
        cancellationRejected = true;
        rejectCancellation(reason);
      }
    },
  };
}

export interface ChatGptZeroRiskManualControl {
  start(descriptorPath: string, activity: LauncherManualTurnStart): Promise<unknown>;
  waitSent(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
  waitTerminal(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ status: "cancelled" | "failed" }>;
  markStarted(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
  end(descriptorPath: string, activity: LauncherManualTurnEnd): Promise<unknown>;
  cancel(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
}

const launcherZeroRiskManualControl: ChatGptZeroRiskManualControl = {
  start: startLauncherManualTurn,
  waitSent: waitForLauncherManualSent,
  waitTerminal: waitForLauncherManualTerminal,
  markStarted: markLauncherManualTurnStarted,
  end: endLauncherManualTurn,
  cancel: cancelLauncherManualTurn,
};

function safeManualAdapterError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  if (error instanceof ChatGptWebAdapterError) return error;
  if (error instanceof LauncherManualTurnTimedOutError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 408,
      errorType: "invalid_request_error",
      code: "manual_handoff_timeout",
      retryable: false,
    });
  }
  if (error instanceof LauncherBrowserTurnCancelledError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  if (error instanceof LauncherManualTurnFailedError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 502,
      errorType: "server_error",
      code: "manual_launcher_failed",
      retryable: false,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function safeManualTerminalError(status: "cancelled" | "failed"): ChatGptWebAdapterError {
  if (status === "cancelled") {
    return new ChatGptWebAdapterError("The Zero Risk browser turn was cancelled in the Launcher", {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  return new ChatGptWebAdapterError("The Zero Risk browser tab failed before ChatGPT completed the turn", {
    status: 502,
    errorType: "server_error",
    code: "manual_launcher_failed",
    retryable: false,
  });
}

export function chatGptWebExecutionNamespace(provider: CodexProviderConfig): string {
  return createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    chatgptWeb: provider.chatgptWeb ?? {},
  })).digest("hex");
}

export function chatGptWebTraceId(
  provider: CodexProviderConfig,
  parsed: CodexParsedRequest,
  semanticEpoch?: number,
): string {
  const namespace = chatGptWebExecutionNamespace(provider);
  // The logical response key survives compaction so a final answer that won the handoff race
  // can still be replayed. A new physical browser owner must instead belong to the new context
  // epoch; otherwise Zero Risk correctly rejects it against the previous owner's completion.
  const conversation = parsed._compactionRequest ? undefined : chatGptConversationKey(parsed, namespace, {
    ...(semanticEpoch !== undefined ? { semanticEpoch } : {}),
  });
  return createHash("sha256")
    .update(`${namespace}:${chatGptTurnExecutionKey(parsed)}`)
    .update(conversation ? `:${conversation}` : "")
    .digest("hex")
    .slice(0, 12);
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function brokerResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

/** Only the browser-facing result is replaced; Codex's original canonical request is untouched. */
function canReferenceOversizedResults(
  messages: readonly CodexToolResultMessage[],
  occupancy: NonNullable<ChatGptTurnRuntime["semanticOccupancy"]>,
  retainedSizes?: ReadonlyMap<string, number>,
): boolean {
  let referenceChars = retainedSizes ? [...retainedSizes.values()].reduce((a, b) => a + b, 0) : 0;
  for (const message of messages) {
    // Reject an unretainable output before running an expensive token estimate
    // over many megabytes. The broker cannot hold this result in any case.
    if (typeof message.content === "string" && message.content.length > MAX_OVERSIZED_RESULT_CHARS) return false;
    if (occupancy.canFitAtomicResults([{ content: message.content }])) continue;
    const canonical = JSON.stringify(message.content);
    if (canonical === undefined || canonical.length > MAX_OVERSIZED_RESULT_CHARS) return false;
    const reserved = retainedSizes?.get(message.toolCallId);
    if (reserved !== undefined && reserved !== canonical.length) return false;
    if (reserved === undefined) referenceChars += canonical.length;
  }
  return referenceChars <= MAX_OVERSIZED_TURN_CHARS;
}

function oversizedResultReservations(
  messages: readonly CodexToolResultMessage[],
  occupancy: NonNullable<ChatGptTurnRuntime["semanticOccupancy"]> | undefined,
): Array<{ callId: string; canonical: string }> {
  if (!occupancy) return [];
  return messages.filter(message => !occupancy.canFitAtomicResults([{ content: message.content }]))
    .map(message => ({ callId: message.toolCallId, canonical: JSON.stringify(message.content) }));
}

async function browserFacingResult(
  broker: TurnBrokerOwner,
  token: string,
  message: CodexToolResultMessage,
  occupancy: NonNullable<ChatGptTurnRuntime["semanticOccupancy"]> | undefined,
): Promise<{ result: BrokerToolResult; visibleContent: unknown }> {
  if (!occupancy || occupancy.canFitAtomicResults([{ content: message.content }])) {
    return { result: brokerResult(message), visibleContent: message.content };
  }
  const canonical = JSON.stringify(message.content);
  if (canonical === undefined || canonical.length > MAX_OVERSIZED_RESULT_CHARS) {
    throw new Error("oversized canonical result cannot be retained for bounded reading");
  }
  const reference = await broker.storeOversizedResult(token, message.toolCallId, canonical);
  const placeholder = `[Codex result stored in this turn's read-only broker. reference=${reference} chars=${canonical.length}.`
    + " Use codex_result_chunk with the current turn_token, reference, offset=0, length<=8192 to inspect exact JSON-encoded canonical content in order."
    + " Each reply includes nextOffset and sha256. The native Codex history already contains the complete original result."
    + " Do not repeat the original tool to retrieve this result.]";
  return { result: { content: [{ type: "text", text: placeholder }], ...(message.isError ? { isError: true } : {}) },
    visibleContent: placeholder };
}

function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

function emitBrowserCompletion(outcome: ChatGptBrowserOutcome, usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  if (outcome.type === "error") throw outcome.error;
  emit({ type: "done", stopReason: "stop", endTurn: true, usage });
}

function emitTraceEvents(trace: ChatGptTraceEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: event.text });
    }
  }
}

function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

function emitReadOnlyContextWarning(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

function submittedTurnFailure(session: ChatGptTurnSession, error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (normalized instanceof ChatGptWebAdapterError) return normalized;
  const phase = session.runtime.submission?.phase;
  if (!phase || phase === "prepared") return normalized;
  const ambiguous = phase === "send_activated";
  return new ChatGptWebAdapterError(
    ambiguous
      ? "ChatGPT did not confirm that the prompt was sent. Check the ChatGPT tab before continuing."
      : "ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.",
    {
      status: 502,
      errorType: "server_error",
      code: ambiguous ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed",
      retryable: false,
      cause: normalized,
    },
  );
}

function currentToolResults(parsed: CodexParsedRequest, session: ChatGptTurnSession): CodexToolResultMessage[] {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return [...byId.values()];
}

function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}

/** Keep the Responses bridge alive during every awaited phase of a browser turn. */
export const CHATGPT_WEB_ADAPTER_HEARTBEAT_MS = 10_000;

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: {
    broker?: TurnBrokerOwner;
    zeroRiskManualControl?: ChatGptZeroRiskManualControl;
  } = {},
): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = dependencies.broker ?? TurnBroker.forSocket(brokerSocketPath(provider));
  const zeroRiskManualControl = dependencies.zeroRiskManualControl ?? launcherZeroRiskManualControl;
  const structuredBroker = broker instanceof TurnBroker ? broker : undefined;
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs;
  const experimentalSkillAttachments = provider.chatgptWeb?.experimentalSkillAttachments;
  if (experimentalSkillAttachments !== undefined && typeof experimentalSkillAttachments !== "boolean") {
    throw new Error("ChatGPT skill attachments preference must be a boolean");
  }
  if (experimentalSkillAttachments && provider.chatgptWeb?.browserInteractionMode === "manual") {
    throw new Error("Skills as files is unavailable in Zero Risk mode");
  }
  const experimentalBiggerContext = provider.chatgptWeb?.experimentalBiggerContext;
  if (experimentalBiggerContext !== undefined && typeof experimentalBiggerContext !== "boolean") {
    throw new Error("ChatGPT Bigger Context preference must be a boolean");
  }
  const experimentalSemanticMemory = provider.chatgptWeb?.experimentalSemanticMemory;
  if (experimentalSemanticMemory !== undefined && typeof experimentalSemanticMemory !== "boolean") {
    throw new Error("ChatGPT semantic memory preference must be a boolean");
  }
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    extraHighAvailable: provider.chatgptWeb?.extraHighAvailable === true,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const manualInteraction = provider.chatgptWeb?.browserInteractionMode === "manual";
  const freshConversationPerTurn = provider.chatgptWeb?.experimentalFreshConversationPerTurn === true;
  if (provider.chatgptWeb?.experimentalFreshConversationPerTurn !== undefined
    && typeof provider.chatgptWeb.experimentalFreshConversationPerTurn !== "boolean") {
    throw new Error("ChatGPT fresh conversation preference must be a boolean");
  }
  if (freshConversationPerTurn && manualInteraction) {
    throw new Error("Fresh browser conversations per turn is available only in automatic mode");
  }
  const executionNamespace = chatGptWebExecutionNamespace(provider);
  const retainedLauncherDescriptor = provider.chatgptWeb?.browserHost === "launcher"
    && provider.chatgptWeb.browserHostDescriptorPath
      ? resolve(expandUserPath(provider.chatgptWeb.browserHostDescriptorPath))
      : undefined;
  if (manualInteraction) {
    if (!configuredCapabilities.localToolsEnabled) {
      throw new Error("ChatGPT Zero Risk requires the Full Codex harness");
    }
    if (!retainedLauncherDescriptor) {
      throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
    }
  }
  const environmentStore = new ChatGptThreadEnvironmentStore(
    provider.chatgptWeb?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
      : undefined,
  );
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(
    provider.chatgptWeb?.lunaCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))
      : undefined,
  );
  const semanticEpochStore = new ChatGptSemanticEpochStore(
    provider.chatgptWeb?.semanticCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.semanticCheckpointStatePath))
      : undefined,
  );
  const semanticConversationOptions = (epoch: StoredChatGptSemanticEpochV1) => ({
    semanticEpoch: epoch.semanticEpoch,
    semanticEpochIdentity: `${epoch.updatedAt}:${epoch.coveredHistoryDigest}:${SEMANTIC_BROWSER_PROCESS_NONCE}`,
  });
  const semanticStateDirectory = provider.chatgptWeb?.semanticCheckpointStatePath
    ? dirname(resolve(expandUserPath(provider.chatgptWeb.semanticCheckpointStatePath)))
    : join(getConfigDir(), "runtime");
  const semanticCostCaps = experimentalSemanticMemory
    ? new SemanticCostCaps(Date.now, SEMANTIC_ROTATIONS_PER_HOUR, SEMANTIC_WEB_COMPACTIONS_PER_HOUR,
      join(semanticStateDirectory, "semantic-cost-caps.json"))
    : undefined;
  const reserveWebCompaction = (parsed: CodexParsedRequest, physicalOperationId: string): void => {
    if (!semanticCostCaps) return;
    const identity = extractChatGptTurnIdentity(parsed);
    const threadHash = identity.threadId ? semanticThreadHash(identity.threadId) : "missing";
    // The durable cost file already scopes accounts/installations. A mutable
    // browser execution namespace must never replenish one native thread's cap.
    const threadKey = identity.threadId ?? "";
    if (!semanticCostCaps.recordCompaction(threadKey, physicalOperationId)) {
      emitSemanticLog({ event: "semantic_skip", threadHash, reason: "cap_hit" });
      emitSemanticLog({ event: "semantic_fallback", threadHash, to: "compaction_required",
        reason: "web_compaction_cap_hit" });
      // Keep canonical compaction available through an explicitly configured native route.
      // Never silently route to native or submit oversized canonical history to Web.
      throw new ChatGptWebAdapterError(
        "The rolling-hour Web compaction budget is exhausted. Canonical compaction needs an explicitly configured recovery route.",
        { status: 409, errorType: "invalid_request_error", code: "semantic_web_compaction_cap_hit", retryable: false },
      );
    }
  };
  const semanticCeilings = experimentalSemanticMemory
    ? new SemanticMessageCeilings(
      join(semanticStateDirectory, "semantic-message-ceilings.json"), executionNamespace,
    ) : undefined;
  const accountTier = configuredCapabilities.proAvailable ? "pro" : "plus";
  const semanticPreflight = (
    value: CodexParsedRequest, capabilities: ChatGptWebCapabilities, mode: ChatGptWebModelMode,
  ) => {
    const result = preflightSemanticProjection(
      value, capabilities, mode,
      experimentalSkillAttachments === true, experimentalBiggerContext === true,
    );
    semanticCeilings?.assertWithin("sol", mode.effort, accountTier,
      result.metrics.finalMessageTokens ?? result.metrics.firstMessageTokens);
    if (result.metrics.stagingEffort && result.metrics.maxStageMessageTokens !== undefined) {
      semanticCeilings?.assertWithin("sol", result.metrics.stagingEffort, accountTier,
        result.metrics.maxStageMessageTokens);
    }
    return result;
  };
  const preflightCanonicalFallback = (
    value: CodexParsedRequest, capabilities: ChatGptWebCapabilities, mode: ChatGptWebModelMode,
  ): void => {
    if (!experimentalBiggerContext) {
      semanticPreflight(value, capabilities, mode);
      return;
    }
    const parts = resolveBiggerContextMultipartParts(value, capabilities, experimentalSkillAttachments === true);
    if (parts === undefined) {
      semanticPreflight(value, capabilities, mode);
      return;
    }
    // The browser worker validates every physical stage and the final commit
    // before sending. A fallback may use multipart, but must never discard
    // canonical compaction evidence or claim a semantic retained epoch.
    const compiled = compileChatGptWebPrompt(
      value, capabilities, mode.localTools ? "[retired turn handle]" : undefined,
      { experimentalMultipartParts: parts, experimentalSkillAttachments: experimentalSkillAttachments === true },
    );
    if (!compiled.multipart || (value._compactionRequest && compiled.trimmedCompactionMessages)) {
      throw new Error("Canonical Bigger Context fallback cannot discard compaction evidence");
    }
    // The canonical multipart path has no SEM epoch, but a measured rejection
    // ceiling still applies to each physical stage and the final commit.
    const messages = compiledChatGptWebMessages(compiled);
    const stages = messages.slice(0, -1);
    const stageTokens = Math.max(...stages.map(message => estimateTokens(message, value.modelId)));
    const stageChars = Math.max(...stages.map(message => message.length));
    const stageMode = resolveChatGptWebMultipartStagingMode(value.modelId, capabilities, stageTokens, stageChars);
    semanticCeilings?.assertWithin("sol", stageMode.effort, accountTier, stageTokens);
    semanticCeilings?.assertWithin("sol", mode.effort, accountTier,
      estimateTokens(messages.at(-1)!, value.modelId) + skillFileTokens(compiled.skillFiles, value.modelId));
  };
  const currentUsageInput = (parsed: CodexParsedRequest): CodexParsedRequest => (
    parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !parsed._compactionRequest
      ? lunaCheckpointStore.apply(parsed).parsed
      : parsed
  );

  interface SemanticRuntimeInput {
    parsed: CodexParsedRequest;
    /** Exact quarantine created by this same fresh native compaction request. */
    newlyQuarantinedFence?: string;
    epoch?: StoredChatGptSemanticEpochV1;
    metrics?: SemanticProjectionMetrics;
    threadHash?: string;
    rotated?: boolean;
    rotation?: Extract<Parameters<typeof emitSemanticLog>[0], { event: "semantic_rotation" }>;
    forceFresh?: boolean;
  }

  const semanticRotationCooldownSatisfied = (
    parsed: CodexParsedRequest,
    active: StoredChatGptSemanticEpochV1,
    candidate: StoredChatGptSemanticEpochV1,
  ): boolean => {
    const orderedTurnIds: string[] = [];
    const verified = new Map(parsed._semanticProvenance?.items
      .filter(item => item.type === "message" && item.role === "user" && item.itemId && item.turnId)
      .map(item => [item.itemId!, item.turnId!] as const) ?? []);
    for (const revision of chatGptTurnUserRevisionHistory(parsed)) {
      const owner = revision.turnId ?? (revision.itemId ? verified.get(revision.itemId) : undefined);
      if (!owner || orderedTurnIds.at(-1) === owner) continue;
      orderedTurnIds.push(owner);
    }
    const activeIndex = orderedTurnIds.indexOf(active.sourceTurnId);
    const candidateIndex = orderedTurnIds.indexOf(candidate.sourceTurnId);
    // V1 uses the smallest non-zero cooldown: one completed native turn must reuse the
    // current epoch before another Tier 0 reseed. Missing ordering evidence fails closed.
    return activeIndex >= 0 && candidateIndex >= 0 && candidateIndex - activeIndex >= 2;
  };

  const prepareSemanticRuntimeInput = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    turnCapabilities: ChatGptWebCapabilities,
  ): SemanticRuntimeInput => {
    if (experimentalSemanticMemory !== true) return { parsed };
    const identity = extractChatGptTurnIdentity(parsed);
    const threadHash = identity.threadId ? semanticThreadHash(identity.threadId) : "missing";
    if (parsed._compactionRequest && identity.threadId && parsed._chatgptModelFamily
      && !manualInteraction) {
      const active = semanticEpochStore.get(identity.threadId, true);
      let newlyQuarantinedFence: string | undefined;
      if (active) {
        try {
          const projected = projectSemanticEpoch(parsed, active);
          const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
          const preflight = semanticPreflight(projected.parsed, turnCapabilities, mode);
          return { parsed: projected.parsed, epoch: active, threadHash,
            metrics: { ...projected.metrics, ...preflight.metrics } };
        } catch (error) {
          // Canonical compaction needs the original exact history when projection
          // validation fails. Only the small/physical-fit fallback is safe.
          const reason = semanticValidationReason(error);
          if (reason === "anchor_missing" || reason === "digest_mismatch" || reason === "cross_boundary") {
            if (semanticEpochStore.quarantineIfCurrent(identity.threadId, active, reason)) {
              newlyQuarantinedFence = semanticEpochStore.quarantineFence(identity.threadId);
            }
          }
          emitSemanticLog({ event: "semantic_validation_failed", threadHash,
            reason, fellBackTo: "legacy" });
        }
      }
      try {
        const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
        preflightCanonicalFallback(parsed, turnCapabilities, mode);
      } catch {
        emitSemanticLog({ event: "semantic_fallback", threadHash, to: "recovery_error", reason: "compaction_view_unavailable" });
        throw new ChatGptWebAdapterError(
          "Canonical compaction requires a verified semantic epoch because the original history exceeds the browser's physical limit.",
          { status: 409, errorType: "invalid_request_error", code: "semantic_epoch_recovery_required", retryable: false },
        );
      }
      return { parsed, threadHash, newlyQuarantinedFence };
    }
    // Preserve eligibility ordering while logging only a fixed, content-free category.
    const ineligibleDetail: SemanticIneligibleDetail | undefined = manualInteraction ? "manual_interaction"
      : parsed._compactionRequest === true ? "compaction"
      : parsed.modelId !== CHATGPT_WEB_MODEL_ID ? "model_mismatch"
      : !parsed._chatgptModelFamily ? "model_family_missing"
      : !turnCapabilities.localToolsEnabled ? "local_tools_disabled"
      : !environment ? "trusted_environment_missing"
      : !retainedLauncherDescriptor ? "launcher_missing"
      : freshConversationPerTurn ? "fresh_conversation"
      : !identity.threadId ? "thread_missing"
      : undefined;
    if (ineligibleDetail) {
      emitSemanticLog({ event: "semantic_skip", threadHash, reason: "ineligible", detail: ineligibleDetail });
      return { parsed };
    }
    const threadId = identity.threadId;
    const modelFamily = parsed._chatgptModelFamily;
    if (!threadId || !modelFamily) throw new Error("Semantic memory eligibility lost required native identity");
    // Native compact v2 is a durable history transition only once Codex
    // actually replays this daemon's completed compaction item. Until then,
    // a quarantined projection must stay disabled across process restarts.
    if (semanticEpochStore.isQuarantined(threadId)) {
      const input = (parsed._rawBody as { input?: unknown } | undefined)?.input;
      semanticEpochStore.acceptCompletedCompaction(threadId, input);
    }
    // Budget identity follows canonical native thread identity, not mutable
    // launcher/browser settings. Runtime lease ownership stays namespaced.
    const costThreadKey = threadId;

    const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const fallbackToLegacy = (reason: string, validationError?: unknown): SemanticRuntimeInput => {
      try {
        preflightCanonicalFallback(parsed, turnCapabilities, mode);
      } catch {
        emitSemanticLog({ event: "semantic_fallback", threadHash, to: "recovery_error", reason });
        if (validationError !== undefined) {
          emitSemanticLog({
            event: "semantic_validation_failed",
            threadHash,
            reason: semanticValidationReason(validationError),
            fellBackTo: "recovery_error",
          });
        }
        throw new ChatGptWebAdapterError(
          "Semantic memory could not safely validate or reseed this browser epoch, and the full canonical prompt does not fit the unchanged browser limits. Run canonical compaction or disable the experiment after the task is recoverable.",
          { status: 409, errorType: "invalid_request_error", code: "semantic_epoch_recovery_required", retryable: false },
        );
      }
      if (validationError !== undefined) {
        emitSemanticLog({
          event: "semantic_validation_failed",
          threadHash,
          reason: semanticValidationReason(validationError),
          fellBackTo: "legacy",
        });
      }
      emitSemanticLog({ event: "semantic_fallback", threadHash, to: "legacy", reason });
      return { parsed, threadHash, forceFresh: true };
    };

    let active: StoredChatGptSemanticEpochV1 | undefined;
    try {
      active = semanticEpochStore.get(threadId, true);
    } catch (error) {
      emitSemanticLog({
        event: "semantic_validation_failed",
        threadHash,
        reason: semanticValidationReason(error),
        fellBackTo: "recovery_error",
      });
      throw error;
    }
    // A persisted invalid-epoch tombstone must bypass candidate rotation.
    // Reuse the original, untouched canonical input while quarantine is active.
    if (semanticEpochStore.isQuarantined(threadId)) {
      return fallbackToLegacy("quarantined_epoch");
    }

    // Native Responses history may omit item-level turn_id even when Codex's
    // canonical rollout recorded it. Reconstruct only exact verified user items;
    // the raw body and all authority-bearing input remain untouched.
    if (parsed._semanticProvenance?.items.some(item => item.type === "message" && item.role === "user" && !item.turnId)) {
      try {
        const lineage = extractChatGptThreadSpawnLineage(parsed) ?? extractChatGptRootThreadMetadata(parsed);
        if (lineage && identity.turnId) {
          const users = parsed._semanticProvenance.items
            .filter(item => item.type === "message" && item.role === "user" && item.itemId && !item.turnId)
            .map(item => ({ itemId: item.itemId!, canonicalJson: item.canonicalJson }));
          const currentTurnAlreadyAttributed = parsed._semanticProvenance.items.some(item => item.type === "message"
            && item.role === "user" && item.turnId === identity.turnId);
          const owners = verifiedCodexSemanticUserTurns({
            codexHome: getCodexHome(), lineage, turnId: identity.turnId, items: users, currentTurnAlreadyAttributed,
          });
          if (owners) {
            parsed._semanticProvenance = {
              ...parsed._semanticProvenance,
              items: parsed._semanticProvenance.items.map(item => {
                const owner = item.itemId && item.type === "message" && item.role === "user" ? owners.get(item.itemId) : undefined;
                return owner && (!item.turnId || item.turnId === owner) ? { ...item, turnId: owner } : item;
              }),
            };
          }
        }
      } catch {
        // Missing or changing native evidence retains the canonical fallback.
      }
    }
    const candidateResult = buildSemanticTier0Candidate(parsed, modelFamily, active);
    const candidate = candidateResult.candidate;
    let activeProjected: ReturnType<typeof projectSemanticEpoch> | undefined;
    if (active) {
      try {
        activeProjected = projectSemanticEpoch(parsed, active);
      } catch (error) {
        const modelFamilyChange = /model-family mismatch/i.test(error instanceof Error ? error.message : String(error));
        if (!modelFamilyChange || !candidate) {
          const reason = semanticValidationReason(error);
          if (reason === "anchor_missing" || reason === "digest_mismatch" || reason === "cross_boundary") {
            semanticEpochStore.quarantineIfCurrent(threadId, active, reason);
          }
          return fallbackToLegacy("active_epoch_validation_failed", error);
        }
      }
    }

    const sameActiveSource = active && candidate
      && active.sourceTurnId === candidate.sourceTurnId
      && active.coveredHistoryDigest === candidate.coveredHistoryDigest
      && active.sourceAnswerHash === candidate.sourceAnswerHash
      && active.sourceUserRevisionHash === candidate.sourceUserRevisionHash
      && active.modelFamily === candidate.modelFamily;
    const reuseForCooldown = Boolean(active && activeProjected && candidate
      && active.modelFamily === candidate.modelFamily
      && !semanticRotationCooldownSatisfied(parsed, active, candidate));
    if (active && activeProjected && (sameActiveSource || !candidate || reuseForCooldown)) {
      const continuation = retainedConversationResumeRequest(activeProjected.parsed) ?? activeProjected.parsed;
      let preflight: ReturnType<typeof preflightSemanticProjection> | undefined;
      let failedReason: string | undefined;
      try {
        preflight = semanticPreflight(continuation, turnCapabilities, mode);
        // The launcher may replace a retained lease with a fresh tab. Validate
        // the full projection before choosing an epoch-backed runtime.
        semanticPreflight(activeProjected.parsed, turnCapabilities, mode);
        const key = chatGptConversationKey(parsed, executionNamespace, semanticConversationOptions(active));
        const occupancy = key && semanticEpochOccupancies.forConversation(
          key, true, preflight.metrics.physicalLimit, parsed.modelId,
        );
        if (!occupancy || occupancy.confidence !== "known" || occupancy.value === null) {
          failedReason = "retained_occupancy_unavailable";
        } else {
          // A newly issued process-scoped key has no retained browser tab yet:
          // its first send uses the entire projection, not the shorter resume.
          if (occupancy.value === 0) preflight = semanticPreflight(activeProjected.parsed, turnCapabilities, mode);
          if (occupancy.value + preflight.metrics.firstMessageTokens + 12_288
            >= preflight.metrics.physicalLimit) failedReason = "retained_epoch_no_fit";
        }
      } catch {
        failedReason = "retained_epoch_preflight_failed";
      }
      if (!failedReason && preflight) {
        if (reuseForCooldown) emitSemanticLog({ event: "semantic_skip", threadHash, reason: "cooldown" });
        return {
          parsed: activeProjected.parsed,
          epoch: active,
          threadHash,
          metrics: { ...activeProjected.metrics, ...preflight.metrics },
        };
      }
      // Cooldown controls optional rotations, never a safety reseed. If an
      // independently validated newer candidate exists, evaluate its physical
      // fit and the ordinary rotation cap before falling back to canonical.
      // Without that candidate, no new epoch may be claimed.
      if (!reuseForCooldown || !candidate || sameActiveSource) {
        return fallbackToLegacy(failedReason ?? "retained_epoch_preflight_failed");
      }
    }

    if (!candidate) {
      emitSemanticLog({
        event: "semantic_skip",
        threadHash,
        reason: candidateResult.reason === "outstanding_tools" ? "outstanding_tools"
          : candidateResult.reason === "cross_boundary" ? "cross_boundary" : "ineligible",
        ...(candidateResult.reason !== "outstanding_tools" && candidateResult.reason !== "cross_boundary" && candidateResult.reason
          ? { detail: candidateResult.reason } : {}),
      });
      if (candidateResult.reason === "cross_boundary") return fallbackToLegacy("cross_boundary");
      return { parsed, threadHash };
    }

    let candidateProjection: ReturnType<typeof projectSemanticEpoch>;
    try {
      candidateProjection = projectSemanticEpoch(parsed, candidate);
    } catch (error) {
      return fallbackToLegacy("candidate_projection_failed", error);
    }
    let rotationReason: SemanticRotationReason = !active ? "initial"
      : active.modelFamily !== candidate.modelFamily ? "model_family_change" : "unknown_occupancy";
    if (active && activeProjected && active.modelFamily === candidate.modelFamily) {
      // A cooldown alone is insufficient reason to consume another rotation.
      // Use the projected continuation and real process-local retained-chat
      // occupancy. Missing/restarted occupancy conservatively calls for reseed.
      try {
        const continuation = retainedConversationResumeRequest(activeProjected.parsed) ?? activeProjected.parsed;
        const preflight = semanticPreflight(continuation, turnCapabilities, mode);
        semanticPreflight(activeProjected.parsed, turnCapabilities, mode);
        const key = chatGptConversationKey(parsed, executionNamespace, {
          ...semanticConversationOptions(active),
        });
        const occupancy = key && semanticEpochOccupancies.forConversation(
          key, true, preflight.metrics.physicalLimit, parsed.modelId,
        );
        const decision = occupancy && decideSemanticEpochRotation({
          occupancyConfidence: occupancy.confidence,
          occupancyTokens: occupancy.value,
          nextMessageTokens: preflight.metrics.firstMessageTokens,
          physicalLimit: preflight.metrics.physicalLimit,
          incrementalSavingsTokens: Math.max(0, candidateProjection.metrics.maskedTokensEst
            - activeProjected.metrics.maskedTokensEst),
        });
        if (decision === "reuse") {
          emitSemanticLog({ event: "semantic_skip", threadHash, reason: "low_pressure" });
          return { parsed: activeProjected.parsed, epoch: active, threadHash,
            metrics: { ...activeProjected.metrics, ...preflight.metrics } };
        }
        if (decision) rotationReason = decision;
      } catch {
        // Reuse preflight failed: try a new physically bounded epoch.
        rotationReason = "physical_pressure";
      }
    }

    const rotationId = `${candidate.semanticEpoch}:${candidate.coveredHistoryDigest}:${candidate.modelFamily}`;
    if (!semanticCostCaps!.canRotate(costThreadKey, rotationId)) {
      emitSemanticLog({ event: "semantic_skip", threadHash, reason: "cap_hit" });
      // Reuse only a verified, physically preflighted epoch. An oversized
      // canonical fallback must fail closed through the existing recovery path.
      if (active && activeProjected) {
        try {
          const continuation = retainedConversationResumeRequest(activeProjected.parsed) ?? activeProjected.parsed;
          const preflight = semanticPreflight(continuation, turnCapabilities, mode);
          semanticPreflight(activeProjected.parsed, turnCapabilities, mode);
          const conversationKey = chatGptConversationKey(parsed, executionNamespace, {
            ...semanticConversationOptions(active),
          });
          const occupancy = conversationKey && semanticEpochOccupancies.forConversation(
            conversationKey, true, preflight.metrics.physicalLimit, parsed.modelId,
          );
          // A cap-hit reuse still extends a retained browser conversation. A
          // fitting single message alone does not prove remaining physical room.
          if (occupancy && occupancy.confidence === "known" && occupancy.value !== null
            && occupancy.value + preflight.metrics.estimatedInputTokens + 12_288 < preflight.metrics.physicalLimit) {
            return { parsed: activeProjected.parsed, epoch: active, threadHash,
              metrics: { ...activeProjected.metrics, ...preflight.metrics } };
          }
        } catch {
          // Preflight or occupancy discovery failed: try only a bounded full
          // canonical message, otherwise keep the existing recovery error.
        }
        return fallbackToLegacy("rotation_cap_hit_epoch_no_fit");
      }
      return fallbackToLegacy("rotation_cap_hit");
    }

    const projected = candidateProjection;
    let preflight: ReturnType<typeof preflightSemanticProjection>;
    try {
      preflight = semanticPreflight(projected.parsed, turnCapabilities, mode);
    } catch (error) {
      emitSemanticLog({ event: "semantic_skip", threadHash, reason: "no_fit" });
      return fallbackToLegacy("rotation_first_message_no_fit");
    }
    // Persist the reservation first. If epoch commit fails, the conservative
    // overcharge expires within an hour; a committed epoch can never evade its cap.
    if (!semanticCostCaps!.recordRotation(costThreadKey, rotationId)) {
      emitSemanticLog({ event: "semantic_skip", threadHash, reason: "cap_hit" });
      return fallbackToLegacy("rotation_cap_changed_before_commit");
    }
    const committed = semanticEpochStore.commit(candidate, {
      expectedSemanticEpoch: active?.semanticEpoch,
      verifiedAuthority: true,
    });
    const rotation: SemanticRuntimeInput["rotation"] = committed.committed
      ? {
          event: "semantic_rotation",
          threadHash,
          fromEpoch: active?.semanticEpoch ?? 0,
          toEpoch: committed.record.semanticEpoch,
          reason: rotationReason,
          firstMessageTokens: preflight.metrics.firstMessageTokens,
          firstMessageChars: preflight.metrics.firstMessageChars,
          fitsSingleMessage: preflight.metrics.multipartParts === undefined,
          maskedResults: projected.metrics.maskedResults,
          maskedTokensEst: projected.metrics.maskedTokensEst,
          ledgerFiles: projected.metrics.ledgerFiles,
          ledgerCommands: projected.metrics.ledgerCommands,
          windowSize: projected.metrics.windowSize,
        } : undefined;
    if (rotation) {
      // The durable epoch and its conservative budget charge precede browser
      // submission. This stage must never enter accepted-rotation totals.
      console.info(JSON.stringify({ event: "semantic_rotation_committed", threadHash,
        fromEpoch: rotation.fromEpoch, toEpoch: rotation.toEpoch }));
    }
    let finalProjection: ReturnType<typeof projectSemanticEpoch>;
    try {
      finalProjection = committed.record.semanticEpoch === candidate.semanticEpoch
        ? projected
        : projectSemanticEpoch(parsed, committed.record);
    } catch (error) {
      return fallbackToLegacy("committed_epoch_projection_failed", error);
    }
    return {
      parsed: finalProjection.parsed,
      epoch: committed.record,
      threadHash,
      rotated: committed.committed,
      rotation,
      metrics: { ...finalProjection.metrics, ...preflight.metrics },
    };
  };

  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
    hooks: { onCompactionProgress?: () => void } = {},
    semantic: SemanticRuntimeInput = { parsed },
  ): ChatGptTurnRuntime => {
    const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
    if (manualRequest !== manualInteraction) {
      throw new Error(
        manualInteraction
          ? "ChatGPT Zero Risk requires the Zero Risk Web model route"
          : "The Zero Risk Web model route requires ChatGPT Zero Risk interaction mode",
      );
    }
    const mode = manualRequest
      ? { localTools: true }
      : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const identity = extractChatGptTurnIdentity(parsed);
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !parsed._compactionRequest
      && Boolean(identity.threadId && identity.turnId);
    const checkpointInput = captureLunaCheckpoint
      ? lunaCheckpointStore.apply(parsed)
      : { parsed, applied: false };
    const browserInput = semantic.epoch ? semantic.parsed : checkpointInput.parsed;
    const conversationKey = !parsed._compactionRequest
      && !freshConversationPerTurn
      && !semantic.forceFresh
      && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
      && mode.localTools
      && retainedLauncherDescriptor
      ? chatGptConversationKey(checkpointInput.parsed, executionNamespace, {
        ...(semantic.epoch ? semanticConversationOptions(semantic.epoch) : {}),
      })
      : undefined;
    // Guard tool results even on the first native turn and on canonical fallback.
    // A retained epochless browser tab may predate this process; only the lease
    // callback can establish whether its physical occupancy is actually known.
    // Oversized native tool results can break a regular ChatGPT Desktop turn as
    // well. Keep the per-result read reference available without requiring the
    // optional semantic-history projection to be enabled.
    const guardCanonical = !manualRequest && !parsed._compactionRequest
      && parsed.modelId === CHATGPT_WEB_MODEL_ID && mode.localTools;
    const physicalLimit = semantic.metrics?.physicalLimit ?? (
      "effort" in mode ? resolveChatGptWebPhysicalContextLimits(
        CHATGPT_WEB_MODEL_ID, mode.effort,
        { ...turnCapabilities, experimentalBiggerContext: experimentalBiggerContext === true },
        parsed._chatgptModelFamily,
      ).contextWindow : 0
    );
    const semanticOccupancy = (semantic.epoch || guardCanonical) && physicalLimit > 0
      ? !retainedLauncherDescriptor
        // Direct workers start a new browser conversation at every startRuntime.
        // A reconnect reuses the existing runtime and its charged ledger.
        ? semanticEpochOccupancies.resetForVerifiedFreshLease(`fresh:${traceId}`, physicalLimit, parsed.modelId)
        : semanticEpochOccupancies.forConversation(
          conversationKey ?? `fresh:${traceId}`, Boolean(semantic.epoch && conversationKey),
          physicalLimit, parsed.modelId,
        )
      : undefined;
    let selectedSemanticMetrics = semantic.metrics;
    let canonicalPreparedTokens = 0;
    let freshLeasePrepared = false;
    let freshLeaseSubmitted = false;
    const onPreparedSelected = semanticOccupancy && retainedLauncherDescriptor
      ? (reused: boolean): void => {
        if (reused) {
          // A retained browser tab is only safe with a verified live ledger.
          if (semantic.epoch && (semanticOccupancy.confidence !== "known" || !semanticOccupancy.value)) {
            throw new Error("SEM retained browser lease has no verified occupancy");
          }
          return;
        }
        if (!("effort" in mode)) throw new Error("Semantic browser recovery requires automatic mode");
        // The launcher can lose a retained tab and submit the full projection
        // instead of the continuation. Validate and charge the actual payload.
        if (semantic.epoch && semantic.metrics) {
          const full = semanticPreflight(browserInput, turnCapabilities, mode);
          selectedSemanticMetrics = { ...semantic.metrics, ...full.metrics };
          freshLeasePrepared = true;
        }
        semanticOccupancy.resetForVerifiedFreshLease();
      }
      : undefined;
    const resumeInput = conversationKey
      ? retainedConversationResumeRequest(browserInput)
      : undefined;
    const retainConversation = conversationKey !== undefined;
    const releaseRetainedConversation = conversationKey && retainedLauncherDescriptor
      ? async () => {
        await releaseLauncherRetainedConversation(retainedLauncherDescriptor, conversationKey);
      }
      : undefined;
    const compileOptionsFor = (input: CodexParsedRequest) => {
      if (manualRequest) return {};
      // SEM epochs use an inline physical submission: multipart acknowledgements
      // consume additional browser context that the epoch occupancy ledger does
      // not currently observe. Canonical legacy fallback retains Bigger Context.
      const experimentalMultipartParts = experimentalBiggerContext && !semantic.epoch
        ? resolveBiggerContextMultipartParts(input, turnCapabilities, experimentalSkillAttachments)
        : undefined;
      return {
        captureLunaCheckpoint,
        experimentalSkillAttachments,
        ...(experimentalMultipartParts !== undefined
          ? { experimentalMultipartParts }
          : {}),
      };
    };
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] Luna rolling checkpoint applied=${checkpointInput.applied}${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`,
      );
    }
    if (!parsed._compactionRequest && semantic.epoch && semantic.metrics && semantic.threadHash) {
      const canonicalTokens = estimateChatGptWebInputTokens(
        checkpointInput.parsed,
        turnCapabilities,
        { experimentalSkillAttachments: experimentalSkillAttachments === true },
      );
      emitSemanticLog({
        event: "semantic_turn",
        threadHash: semantic.threadHash,
        epoch: semantic.epoch.semanticEpoch,
        tier: 0,
        canonicalTokens,
        nextWireTokens: semantic.metrics.multipartParts
          ? semantic.metrics.estimatedInputTokens : semantic.metrics.firstMessageTokens,
        estimatedEpochOccupancy: semanticOccupancy?.value ?? null,
        occupancyConfidence: semanticOccupancy?.confidence ?? "unknown",
        physicalLimit: semantic.metrics.physicalLimit,
      });
    }
    const emitSemanticCost = (): void => {
      if (parsed._compactionRequest || !semantic.epoch || !semantic.metrics || !semantic.threadHash) return;
      emitSemanticLog({
        event: "semantic_cost",
        threadHash: semantic.threadHash,
        epoch: semantic.epoch.semanticEpoch,
        checkpointTailRequests: 0,
        checkpointTailTokensEst: 0,
        epochRotations: semantic.rotated ? 1 : 0,
        // A lost browser tab or process restart can reseed an existing epoch
        // without a new logical rotation. Count its submitted full projection.
        reseedInputTokensEst: semantic.rotated || freshLeaseSubmitted
          ? selectedSemanticMetrics!.estimatedInputTokens : 0,
        webCompactionSubmissions: 0,
        // SEM is deliberately single-message. Canonical Bigger Context
        // multipart fallback does not claim an active semantic epoch.
        extraStageSubmissions: 0,
        maskedResults: semantic.rotated ? semantic.metrics.maskedResults : 0,
        maskedTokensEst: semantic.rotated ? semantic.metrics.maskedTokensEst : 0,
        discardedTails: 0,
        legacyEquivalentSubmissions: 1,
      });
    };
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint");
        return;
      }
      capturedCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (capturedCheckpoint) lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      return answer;
    });
    const browserAbort = new AbortController();
    let browserOwnerSettled = false;
    const trackBrowserOwner = (browser: Promise<string>): Promise<string> => browser.finally(() => {
      browserOwnerSettled = true;
    });
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    const observedCapabilityTokens = new Set<string>();
    const observeCapabilityRetirement = (
      turnToken: string,
      externalProgress: ChatGptExternalTurnProgress,
    ): void => {
      if (observedCapabilityTokens.has(turnToken)) return;
      observedCapabilityTokens.add(turnToken);
      void broker.waitForRetirement(turnToken).then(
        failure => {
          const retirement = failure
            ? chatGptToolTimeoutError(failure.tool, failure.timeoutMs)
            : new Error("Codex Native retired the turn binding before its tool work completed");
          externalProgress.retire(retirement);
          if (!browserOwnerSettled && !browserAbort.signal.aborted) browserAbort.abort(retirement);
        },
        error => {
          const failure = new Error("ChatGPT could not observe Codex Native turn retirement", {
            cause: error,
          });
          externalProgress.retire(failure);
          if (!browserAbort.signal.aborted) browserAbort.abort(failure);
        },
      );
    };
    const submission: NonNullable<ChatGptTurnRuntime["submission"]> = { phase: "prepared" };
    let rotationAttempted = false;
    let rotationAccepted = false;
    const markRotationAttempted = (): void => {
      if (!semantic.rotation || rotationAttempted) return;
      rotationAttempted = true;
      console.info(JSON.stringify({ event: "semantic_rotation_attempted",
        threadHash: semantic.rotation.threadHash,
        fromEpoch: semantic.rotation.fromEpoch, toEpoch: semantic.rotation.toEpoch }));
    };
    const markRotationAccepted = (): void => {
      if (!semantic.rotation || rotationAccepted) return;
      markRotationAttempted(); // A confirmed submission also proves an attempt.
      rotationAccepted = true;
      emitSemanticLog(semantic.rotation);
    };
    const onSemanticSizeRejection = semantic.threadHash
      ? (observation: ChatGptSubmissionRejectionObservation): void => {
        semanticOccupancy?.markRejected();
        const diagnostics = observation.diagnostics;
        if (!diagnostics) return;
        try {
          semanticCeilings?.observeRejection(
            diagnostics.mode, diagnostics.effort, diagnostics.accountTier, diagnostics.estimatedMessageTokens,
          );
        } catch {
          // The observed rejection still wins; a persistence problem must not
          // turn a terminal size error into an unclassified browser retry.
          console.warn("[chatgpt-web] semantic message-ceiling persistence failed");
        }
        emitSemanticLog({
          event: "semantic_reject",
          threadHash: semantic.threadHash!,
          kind: observation.rejectionKind,
          mode: diagnostics.mode,
          effort: diagnostics.effort,
          estimatedMessageTokens: diagnostics.estimatedMessageTokens,
          messageChars: diagnostics.messageChars,
          ledgerValue: semanticOccupancy?.value ?? diagnostics.ledgerValue,
          class: diagnostics.reuseConversation ? "D" : semantic.rotated ? "C" : "unknown",
        });
      }
      : undefined;
    // A canonical compaction request is side-effect free and remains safe to rebuild after an
    // ambiguous browser send. Normal task prompts must never be replayed after Send activation.
    const submissionLifecycle = {
      ...(!parsed._compactionRequest ? {
        onSendActivated: () => {
          submission.phase = "send_activated" as const;
          markRotationAttempted();
        },
      } : {}),
      onSubmitted: () => {
        if (!parsed._compactionRequest) submission.phase = "accepted";
        markRotationAccepted();
        if (freshLeasePrepared) freshLeaseSubmitted = true;
        if (semanticOccupancy && selectedSemanticMetrics) {
          // Charge the full preflighted semantic submission, including the
          // browser's non-visible reserve, to its physical occupancy ledger.
          semanticOccupancy.record(`submit:${traceId}`, selectedSemanticMetrics.estimatedInputTokens);
        } else if (semanticOccupancy) {
          semanticOccupancy.record(`submit:${traceId}`, canonicalPreparedTokens);
        }
        hooks.onCompactionProgress?.();
      },
    };
    const multipartProgressLifecycle = hooks.onCompactionProgress
      ? {
        onMultipartStageAcknowledged: (_index: number) => {
          hooks.onCompactionProgress?.();
        },
      }
      : {};
    if (manualRequest) {
      if (!environment) throw new Error("ChatGPT Zero Risk requires a trusted Codex environment");
      if (!retainedLauncherDescriptor) throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
      const token = deferred<string>();
      const externalProgress = new ChatGptExternalTurnProgress();
      const surfaceNonce = randomBytes(32).toString("base64url");
      const owner: LauncherManualTurnOwner = { traceId, helperPid: process.pid };
      let tokenSettled = false;
      let activeToken: string | undefined;
      let launcherStarted = false;
      let launcherEnded = false;
      const finishLauncher = async (status: LauncherManualTurnEnd["status"]): Promise<void> => {
        if (!launcherStarted || launcherEnded) return;
        await zeroRiskManualControl.end(retainedLauncherDescriptor, {
          ...owner,
          status,
          ...(status === "completed" && retainConversation ? { retain: true } : {}),
        });
        launcherEnded = true;
      };
      const runManual = async (): Promise<string> => {
        try {
          activeToken = await broker.registerSafe(environment, surfaceNonce, undefined, traceId);
          observeCapabilityRetirement(activeToken, externalProgress);
          const compiled = compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            activeToken,
            { manualControl: true },
          );
          const resumeCompiled = resumeInput
            ? compileChatGptWebPrompt(
              resumeInput,
              turnCapabilities,
              activeToken,
              { manualControl: true },
            )
            : undefined;
          for (const candidate of [compiled, resumeCompiled]) {
            if (!candidate) continue;
            if (candidate.multipart) {
              throw new ChatGptWebAdapterError("ChatGPT Zero Risk does not support multipart browser transport", {
                status: 409,
                errorType: "invalid_request_error",
                code: "manual_multipart_unsupported",
                retryable: false,
              });
            }
          }
          tokenSettled = true;
          token.resolve(activeToken);
          if (!parsed._compactionRequest) {
            trace.push({
              kind: "commentary",
              text: "> **Action required in Zero Risk**\n>\n> Open the launcher, copy and paste the prompt into ChatGPT, add any images yourself because Zero Risk cannot transfer them, select the plugin shown in the launcher and the model you want, send the prompt, then confirm it was sent in the launcher.",
            });
          }
          await zeroRiskManualControl.start(retainedLauncherDescriptor, {
            ...owner,
            prompt: compiled.text,
            ...(resumeCompiled ? { resumePrompt: resumeCompiled.text } : {}),
            ...(conversationKey ? { conversationKey } : {}),
            ...(parsed._compactionRequest ? { compaction: true as const } : {}),
          });
          launcherStarted = true;
          await zeroRiskManualControl.waitSent(retainedLauncherDescriptor, owner, {
            abortSignal: browserAbort.signal,
          });
          await broker.confirmSafeTurnSent(activeToken, surfaceNonce);
          submission.phase = "accepted";
          if (!parsed._compactionRequest) trace.push({
            kind: "commentary",
            text: "> **Waiting for ChatGPT**\n>\n> The prompt is marked `Sent`. Waiting for the selected ChatGPT plugin to connect.",
          });
          const terminalAbort = new AbortController();
          const abortTerminal = () => terminalAbort.abort();
          browserAbort.signal.addEventListener("abort", abortTerminal, { once: true });
          const terminalFailure = zeroRiskManualControl.waitTerminal(
            retainedLauncherDescriptor,
            owner,
            { abortSignal: terminalAbort.signal },
          ).then(observed => Promise.reject(safeManualTerminalError(observed.status)))
            .catch(error => terminalAbort.signal.aborted
              ? new Promise<never>(() => {})
              : Promise.reject(error));
          let answer: string;
          try {
            await Promise.race([
              broker.waitForSafeStart(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
            await zeroRiskManualControl.markStarted(retainedLauncherDescriptor, owner);
            if (!parsed._compactionRequest) trace.push({
              kind: "commentary",
              text: "> **Zero Risk connected**\n>\n> The Zero Risk plugin is connected. ChatGPT is now working through the native Codex harness; progress remains visible in the launcher.",
            });
            answer = await Promise.race([
              broker.waitForSafeCompletion(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
          } finally {
            terminalAbort.abort();
            browserAbort.signal.removeEventListener("abort", abortTerminal);
          }
          text.push(answer);
          try {
            await finishLauncher("completed");
          } catch (controlError) {
            // The broker result is already authoritative. A launcher acknowledgement failure may
            // leave UI cleanup pending, but it must not replace a completed Codex answer with an
            // error or trigger a contradictory failed terminal mutation.
            console.error(
              `[chatgpt-web] completed Zero Risk turn but could not confirm launcher cleanup: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          return answer;
        } catch (error) {
          const normalized = safeManualAdapterError(error);
          // Capture the causal state before our own cleanup revokes the broker capability. The
          // retirement observer also aborts browserAbort, but that self-induced abort must not turn
          // an ordinary launcher/runtime failure into a user cancellation.
          const externallyAborted = browserAbort.signal.aborted;
          if (activeToken) await Promise.resolve(broker.revoke(activeToken, normalized)).catch(() => {});
          try {
            await finishLauncher(externallyAborted ? "aborted" : "failed");
          } catch (controlError) {
            console.error(
              `[chatgpt-web] failed to release Zero Risk launcher turn: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          throw normalized;
        }
      };
      const browserTurn = cancellableBrowserTurn(trackBrowserOwner(runManual()), browserAbort);
      void browserTurn.browser.catch(error => {
        if (tokenSettled) return;
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      });
      return {
        mode: "tools",
        token: token.promise,
        externalProgress,
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: checkpointInput.parsed,
        manualControl: { surfaceNonce },
        ...(conversationKey ? { conversationKey } : {}),
        ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
        retireCapability: async () => {
          if (activeToken) await broker.revoke(activeToken);
        },
        submission,
        cancel: (reason?: Error) => {
          browserTurn.cancel(reason);
          if (activeToken) {
            void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
              console.error(`[chatgpt-web] failed to revoke cancelled Zero Risk request: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        },
      };
    }
    if (!mode.localTools) {
      const browserTurn = cancellableBrowserTurn(finalizeCheckpoint(worker.run({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
        capabilities: turnCapabilities,
        prepare: async () => ({
          ...compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            undefined,
            compileOptionsFor(checkpointInput.parsed),
          ),
          release: () => {},
        }),
        abortSignal: browserAbort.signal,
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        ...submissionLifecycle,
        ...multipartProgressLifecycle,
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
      })), browserAbort);
      return {
        mode: "read-only",
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: checkpointInput.parsed,
        submission,
        cancel: browserTurn.cancel,
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    const token = deferred<string>();
    const externalProgress = new ChatGptExternalTurnProgress();
    let tokenSettled = false;
    let activeToken: string | undefined;
    const prepareWith = async (input: CodexParsedRequest) => {
      const turnToken = activeToken ?? await broker.register(
        environment,
        timeoutMs === undefined ? undefined : timeoutMs + 60_000,
        traceId,
      );
      activeToken = turnToken;
      try {
        const compiled = compileChatGptWebPrompt(
          input,
          turnCapabilities,
          turnToken,
          compileOptionsFor(input),
        );
        if (semanticOccupancy && !semantic.epoch) {
          // Sum every acknowledged Bigger Context stage and the final commit.
          // Charging only the final message understates retained browser pressure.
          canonicalPreparedTokens = compiledChatGptWebMessages(compiled)
            .reduce((total, message) => total + estimateTokens(message, parsed.modelId), 0)
            + skillFileTokens(compiled.skillFiles, parsed.modelId);
        }
        // Publish only after preparation succeeds: otherwise its failure revokes the token
        // before the response observer uses it and masks the cause as an expired capability.
        observeCapabilityRetirement(turnToken, externalProgress);
        if (!tokenSettled) {
          tokenSettled = true;
          token.resolve(turnToken);
        }
        return { ...compiled, release: () => {} };
      } catch (error) {
        await broker.revoke(turnToken);
        activeToken = undefined;
        throw error;
      }
    };
    const browserTurn = cancellableBrowserTurn(trackBrowserOwner(finalizeCheckpoint(worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
      capabilities: turnCapabilities,
      prepare: () => prepareWith(browserInput),
      ...(resumeInput ? { prepareResume: () => prepareWith(resumeInput) } : {}),
      ...(retainConversation ? { retainConversation: true, conversationKey } : {}),
      ...(onPreparedSelected ? { onPreparedSelected } : {}),
      ...(onSemanticSizeRejection ? { onSizeRejection: onSemanticSizeRejection } : {}),
      abortSignal: browserAbort.signal,
      ...(parsed._compactionRequest ? { compaction: true } : {}),
      ...submissionLifecycle,
      ...multipartProgressLifecycle,
      onReasoningSummary: (text, continuation) => {
        semanticOccupancy?.recordOutput(text);
        trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) });
      },
      onCommentary: (text, continuation) => {
        semanticOccupancy?.recordOutput(text);
        trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) });
      },
      onTextDelta: delta => { semanticOccupancy?.recordOutput(delta); text.push(delta); },
      externalProgress,
      completionFence: {
        begin: async () => broker.beginCompletionFence(await token.promise),
        commit: async revision => broker.commitCompletionFence(await token.promise, revision),
      },
      ...(captureLunaCheckpoint ? {
        captureLunaCheckpoint: true,
        onLunaCheckpoint: captureCheckpoint,
      } : {}),
    })).then(answer => {
      // A completed response proves submission even when a local harness omits
      // the browser's onSubmitted callback; failed preflight cannot reach here.
      markRotationAccepted();
      emitSemanticCost();
      return answer;
    }, error => {
      // Preflight/lease failure never reached a confirmed browser submission.
      if (submission.phase === "accepted") emitSemanticCost();
      throw error;
    })), browserAbort);
    void browserTurn.browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      token: token.promise,
      externalProgress,
      browser: browserTurn.browser,
      physicalSettlement: browserTurn.physicalSettlement,
      ...(semanticOccupancy ? { semanticOccupancy, semanticThreadHash: semantic.threadHash } : {}),
      trace,
      text,
      usageInput: checkpointInput.parsed,
      ...(conversationKey ? { conversationKey } : {}),
      ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
      retireCapability: async () => {
        if (activeToken) await broker.revoke(activeToken);
      },
      submission,
      cancel: (reason?: Error) => {
        browserTurn.cancel(reason);
        if (activeToken) {
          void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
            console.error(`[chatgpt-web] failed to revoke cancelled turn token: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
    };
  };

  return {
    name: "chatgpt-web",
    preflightTurn(parsed) {
      if (parsed._compactionRequest) return;
      let key: string;
      try {
        key = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
      } catch {
        // Missing native authority belongs to runTurn's existing validation path.
        return;
      }
      const source = chatGptTurnSessions.find(key);
      if (!source?.isActive() || source.runtime.mode !== "tools") return;
      const results = currentToolResults(parsed, source);
      if (results.length === 0 || results.length !== source.outstanding().length) return;
      const pressure = source.runtime.semanticOccupancy?.batchPressureReason(results.map(result => ({
        callId: result.toolCallId, content: result.content,
      })));
      if (pressure !== "atomic_result_oversize"
        || (source.runtime.semanticOccupancy && canReferenceOversizedResults(
          results, source.runtime.semanticOccupancy, source.runtime.oversizedResultSizes,
        ))) return;
      return {
        type: "error", status: 400, errorType: "invalid_request_error", retryable: false,
        code: "semantic_atomic_result_too_large",
        message: "A complete canonical tool result exceeds the browser's physical capacity. Use an independently available native recovery route.",
      };
    },
    async runTurn(parsed, incoming, emit) {
      if (parsed._compactionRequest) bindAdapterCompactionProtocol(parsed);
      const observerAbort = new AbortController();
      incoming = {
        ...incoming,
        abortSignal: incoming.abortSignal
          ? AbortSignal.any([incoming.abortSignal, observerAbort.signal])
          : observerAbort.signal,
      };
      const write = emit;
      emit = event => {
        if (observerAbort.signal.aborted) throw observerAbort.signal.reason;
        try { write(event); }
        catch (cause) {
          // The response writer is an observer, not the owner of browser execution. Its
          // failure must follow the existing disconnect path even before HTTP signals abort.
          const error = new ChatGptObserverDisconnected(cause);
          observerAbort.abort(error);
          throw error;
        }
      };
      const runChatGptWebTurn = async (): Promise<void> => {
        const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
        if (manualRequest !== manualInteraction) {
          emit({
            type: "error",
            message: manualInteraction
              ? "ChatGPT Zero Risk requires the Zero Risk Web model route."
              : "The Zero Risk Web model route is unavailable while automatic browser interaction is enabled.",
            status: 409,
            errorType: "invalid_request_error",
            code: "browser_interaction_mode_mismatch",
            retryable: false,
          });
          return;
        }
        const turnCapabilities = parsed._compactionRequest && !manualRequest
          ? { ...configuredCapabilities, localToolsEnabled: false }
          : configuredCapabilities;
        const mode = manualRequest
          ? { localTools: true }
          : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
        const structuredOutputValidator = parsed._compactionRequest
          ? undefined
          : createChatGptStructuredOutputValidator(parsed.options.outputFormat);
        const bufferStructuredOutput = structuredOutputValidator !== undefined;
        const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
        const exhaustedRetry = chatGptWebTurnRetryPolicy.exhaustedError(retryKey);
        if (exhaustedRetry) {
          emit({
            type: "error",
            message: exhaustedRetry.message,
            status: exhaustedRetry.status,
            errorType: exhaustedRetry.errorType,
            code: exhaustedRetry.code,
            retryable: false,
          });
          return;
        }
        let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
        if (mode.localTools) {
          try {
            environment = environmentStore.resolve(parsed);
          } catch (error) {
            const identity = extractChatGptTurnIdentity(parsed);
            console.warn(
              `[chatgpt-web] trusted environment unavailable (thread_id=${identity.threadId ? "present" : "missing"}, turn_id=${identity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ?? "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length})`,
            );
            throw error;
          }
        }
        if (parsed._compactionRequest) {
          const structuredCompactionRequired = parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
            && configuredCapabilities.localToolsEnabled;
          if (structuredCompactionRequired
            && (!retainedLauncherDescriptor || (!manualRequest && !structuredBroker))) {
            emit({
              type: "error",
              message: manualRequest
                ? "Zero Risk could not resume the active ChatGPT conversation for context handoff. Retry the task from the Launcher."
                : "ChatGPT could not resume the active conversation for context handoff. Retry the task.",
              status: 409,
              errorType: "invalid_request_error",
              code: "compaction_control_unavailable",
              retryable: false,
            });
            return;
          }
          if (structuredCompactionRequired) {
            const compactionExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
            const compactedSourceExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
            const handoffTraceId = createHash("sha256")
              .update(`${compactionExecutionKey}:handoff`)
              .digest("hex")
              .slice(0, 12);
            const compactionTraceId = createHash("sha256")
              .update(compactionExecutionKey)
              .digest("hex")
              .slice(0, 12);
            const freshCompactionTraceId = `${handoffTraceId}_${freshConversationPerTurn ? "fresh" : "fallback"}`;
            const compactionNativeIdentity = extractChatGptTurnIdentity(parsed);
            let quarantineFence: string | undefined;
            if (experimentalSemanticMemory && compactionNativeIdentity.threadId) {
              try {
                quarantineFence = semanticEpochStore.quarantineFence(compactionNativeIdentity.threadId);
              } catch (error) {
                // The active source may still be capable of an exact retained
                // handoff when the on-disk epoch file is corrupt. The compact
                // can proceed, but it must not acquire authority to lift a
                // quarantine or rewrite the damaged state.
                if (!(error instanceof ChatGptWebAdapterError)
                  || error.code !== "semantic_epoch_state_invalid") throw error;
              }
            }
            let sharedSummary = existingStructuredCompactionRun(compactionExecutionKey);
            if (!sharedSummary) {
              sharedSummary = runStructuredCompactionOnce(
                compactionExecutionKey,
                {
                  ownerKey: `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`,
                  traceIds: [
                    compactionTraceId,
                    handoffTraceId,
                    freshCompactionTraceId,
                  ],
                  ...(compactionNativeIdentity.threadId
                    ? { nativeThreadId: compactionNativeIdentity.threadId }
                    : {}),
                  ...(compactionNativeIdentity.turnId
                    ? { nativeTurnId: compactionNativeIdentity.turnId }
                    : {}),
                },
                async (operatorSignal, retainOwnershipUntil) => {
                  const handoffTimeoutMs = Math.min(
                    timeoutMs ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                    MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                  );
                  const handoffDeadline = new AbortController();
                  const handoffTimeoutError = new ChatGptWebAdapterError(
                    `ChatGPT compaction did not fully settle within ${handoffTimeoutMs}ms`,
                    {
                      status: 409,
                      errorType: "invalid_request_error",
                      code: "compaction_handoff_timeout",
                      retryable: false,
                    },
                  );
                  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
                  let handoffPhase = "source_settlement";
                  const armHandoffDeadline = (): void => {
                    if (handoffDeadline.signal.aborted) return;
                    if (handoffTimer) clearTimeout(handoffTimer);
                    handoffTimer = setTimeout(
                      () => {
                        console.warn(`[chatgpt-web] compaction_timeout ${JSON.stringify({
                          traceId: compactionTraceId, phase: handoffPhase, timeoutMs: handoffTimeoutMs,
                        })}`);
                        handoffDeadline.abort(handoffTimeoutError);
                      },
                      handoffTimeoutMs,
                    );
                    handoffTimer.unref?.();
                  };
                  armHandoffDeadline();
                  const operationSignal = AbortSignal.any([operatorSignal, handoffDeadline.signal]);
                  // A dedicated compactor rewrites the browser execution model/effort.
                  // The retained source must be resolved from its original native
                  // instruction, not from a newly computed compactor conversation key.
                  const exactSource = chatGptTurnSessions.findExactCompactionSource(parsed);
                  const sourceConversationKey = exactSource?.conversationKey()
                    ?? (experimentalSemanticMemory ? undefined : chatGptConversationKey(parsed, executionNamespace));
                  const runFreshCompaction = async (reason: string): Promise<string> => {
                    handoffPhase = "fresh_compaction";
                    if (freshConversationPerTurn) console.info("[chatgpt-web] compaction uses configured fresh conversation mode");
                    else console.warn(`[chatgpt-web] retained compaction fallback=${reason}`);
                    // Fresh compaction is a bounded phase. Each exact multipart acknowledgement
                    // and the final accepted compact prompt re-arms the five-minute liveness budget;
                    // transport time cannot consume the model-generation window.
                    armHandoffDeadline();
                    const semanticCompaction = prepareSemanticRuntimeInput(parsed, undefined, turnCapabilities);
                    // A fresh compact may itself discover invalid epoch evidence.
                    // Bind its completed output only to the quarantine created
                    // synchronously by this same verified validation attempt.
                    quarantineFence ??= semanticCompaction.newlyQuarantinedFence;
                    reserveWebCompaction(parsed, `${compactionExecutionKey}:fresh:${freshCompactionTraceId}`);
                    const fallbackRuntime = startRuntime(
                      parsed,
                      manualRequest ? environment : undefined,
                      freshCompactionTraceId,
                      turnCapabilities,
                      { onCompactionProgress: armHandoffDeadline },
                      semanticCompaction,
                    );
                    retainOwnershipUntil(fallbackRuntime.physicalSettlement);
                    try {
                      const rawSummary = await withAbort(fallbackRuntime.browser, operationSignal);
                      await withAbort(fallbackRuntime.physicalSettlement, operationSignal);
                      return canonicalizeCompactionHandoff(parsed, rawSummary);
                    } catch (error) {
                      fallbackRuntime.cancel(error instanceof Error ? error : new Error(String(error)));
                      // The shared owner retains physical settlement independently of this error.
                      // Neither a timeout nor operator cancellation can open a competing trace.
                      throw error;
                    }
                  };
                  let source: ChatGptTurnSession | undefined;
                  let preserveFinalResponse = false;
                  try {
                    if (freshConversationPerTurn) {
                      // Full native history is the compaction input. Release an unfinished
                      // browser/tool owner before rebuilding it, but keep a committed final
                      // replayable if it won the native compaction race.
                      const previous = chatGptTurnSessions.find(compactedSourceExecutionKey);
                      const settlement = previous?.settledOutcome()?.type === "final"
                        ? previous.physicalSettlement
                        : chatGptTurnSessions.retireAndWait(compactedSourceExecutionKey).then(() => {});
                      retainOwnershipUntil(settlement);
                      await withAbort(settlement, operationSignal);
                      return await runFreshCompaction("configured_fresh_conversation");
                    }
                    // The previous compaction may already have detached the retained head while
                    // its browser/helper is still unwinding. Do not inspect that old epoch or
                    // decide to open a fresh fallback until physical release has completed.
                    if (sourceConversationKey) {
                      await chatGptTurnSessions.waitForConversationRetirement(
                        sourceConversationKey,
                        operationSignal,
                      );
                    }
                    const conversationHead = sourceConversationKey
                      ? chatGptTurnSessions.findConversationHead(sourceConversationKey)
                      : undefined;
                    // Semantic compaction must never settle a newer or unrelated
                    // head when the canonical source has already disappeared.
                    // An active exact source may still own an outstanding tool batch
                    // while a newer head is being registered.
                    source = experimentalSemanticMemory
                      ? exactSource && (exactSource.isActive() || conversationHead === exactSource)
                        ? exactSource
                        : undefined
                      : exactSource?.isActive() ? exactSource : conversationHead;
                    preserveFinalResponse = !source?.isActive()
                      && source?.settledOutcome()?.type === "final";
                    const retainedKey = source?.conversationKey();
                    if (!source || !retainedKey) {
                      return await runFreshCompaction("source_unavailable_before_handoff");
                    }
                    let rawSummary: string;
                    if (manualRequest && source.isActive() && source.runtime.mode === "tools") {
                      const zeroRiskSummary = await settleActiveZeroRiskCompactionSource(
                        parsed,
                        source,
                        broker,
                        operationSignal,
                      );
                      if (zeroRiskSummary === undefined) {
                        preserveFinalResponse = true;
                        rawSummary = await runFreshCompaction("zero_risk_source_had_no_compaction_boundary");
                      } else {
                        rawSummary = zeroRiskSummary;
                      }
                    } else if (manualRequest) {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      rawSummary = await runFreshCompaction("zero_risk_source_already_completed");
                    } else if (source.isActive() && source.runtime.mode === "tools") {
                      // Budget exhaustion must be rejected before the canonical
                      // outstanding tool batch is settled or its source retired.
                      reserveWebCompaction(parsed, `${compactionExecutionKey}:retained:${handoffTraceId}`);
                      const settlement = await settleActiveCompactionSource(
                        parsed,
                        source,
                        structuredBroker!,
                        operationSignal,
                      );
                      preserveFinalResponse = !settlement.compactionInstructionDelivered;
                      // The previous response has physically settled. Its waiting time must not
                      // consume the independent, bounded request for the retained checkpoint.
                      handoffPhase = "retained_checkpoint";
                      armHandoffDeadline();
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                        settlement.oversizedEvidence,
                      );
                    } else {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      handoffPhase = "retained_checkpoint";
                      armHandoffDeadline();
                      reserveWebCompaction(parsed, `${compactionExecutionKey}:retained:${handoffTraceId}`);
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                      );
                    }
                    const summary = canonicalizeCompactionHandoff(parsed, rawSummary);
                    await withAbort(
                      preserveFinalResponse
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey),
                      operationSignal,
                    );
                    return summary;
                  } catch (error) {
                    // A budget guard must not consume an active source. The
                    // canonical compaction request can be routed explicitly
                    // once an authorized recovery path becomes available.
                    if (error instanceof ChatGptWebAdapterError
                      && (error.code === "semantic_web_compaction_cap_hit"
                        || error.code === "semantic_cost_budget_unavailable")) {
                      throw error;
                    }
                    const retainedKey = source?.conversationKey();
                    if (!retainedKey) throw error;
                    let handoffError = error instanceof Error ? error : new Error(String(error));
                    try {
                      // Operator cancellation ends the logical compaction, but cancel-all must not
                      // acknowledge until the retained browser/helper owner has physically retired.
                      await (preserveFinalResponse
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source!,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey));
                    } catch (retirementError) {
                      handoffError = new AggregateError(
                        [handoffError, retirementError instanceof Error ? retirementError : new Error(String(retirementError))],
                        "Structured compaction failed and its retained conversation could not be retired",
                      );
                    }
                    if (handoffError instanceof ChatGptWebAdapterError
                      && handoffError.code === "compaction_source_unavailable") {
                      return await runFreshCompaction("source_disappeared_before_handoff");
                    }
                    throw handoffError;
                  } finally {
                    if (handoffTimer) clearTimeout(handoffTimer);
                  }
                },
              );
            }
            emit({ type: "heartbeat" });
            let summary: string;
            try {
              summary = await withAbort(sharedSummary, incoming.abortSignal);
            } catch (error) {
              if (incoming.abortSignal?.aborted
                && error instanceof DOMException
                && error.name === "AbortError") {
                // The observer detached; the shared exact compaction round continues and remains
                // available to a canonical reconnect without a second browser submission.
                throw error;
              }
              const handoffError = error instanceof Error ? error : new Error(String(error));
              console.error("[chatgpt-web] structured context handoff failed:", handoffError);
              const upstreamError = handoffError instanceof ChatGptWebAdapterError ? handoffError : undefined;
              emit({
                type: "error",
                message: upstreamError?.message ?? "ChatGPT did not complete the context handoff. Retry the task.",
                status: upstreamError?.status ?? 409,
                errorType: upstreamError?.errorType ?? "invalid_request_error",
                code: upstreamError?.code ?? "compaction_handoff_failed",
                // Compaction retry remains an explicit operator decision even when its source
                // failure was retryable; preserve the cause without opening a new retry loop.
                retryable: false,
              });
              return;
            }
            if (experimentalSemanticMemory
              && parsed._canonicalCompactionProtocol === "v2"
              && compactionNativeIdentity.threadId) {
              semanticEpochStore.rememberCompletedCompaction(
                compactionNativeIdentity.threadId, quarantineFence, summary,
              );
            }
            emit({ type: "text_delta", text: summary, phase: "final_answer" });
            emitBrowserCompletion(
              { type: "final", answer: summary },
              estimateChatGptWebUsage(parsed, { answer: summary, reasoning: [] }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
              emit,
            );
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }
          const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
          await chatGptTurnSessions.retireAndWait(responseExecutionKey, incoming.abortSignal);
        }
        const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
        const ownerKey = `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`;
        const nativeIdentity = extractChatGptTurnIdentity(parsed);
        const nativeTurnId = nativeIdentity.turnId;
        if (!nativeTurnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser ownership");
        const abortedTurnIds = manualRequest ? new Set(priorChatGptAbortedTurnIds(parsed)) : undefined;
        if (abortedTurnIds?.size) {
          chatGptTurnSessions.retireAbortedOwnerTurns(ownerKey, abortedTurnIds, executionKey);
        }
        // Tool rounds and exact retries reuse the existing native-turn session. Re-projecting and
        // preflighting the complete canonical request here could reject a large current-turn tool
        // result even though no new browser composer message will be sent. M1 rotates only between
        // native turns; active-turn pressure remains the legacy behavior until the separately gated
        // S5/S6 work exists.
        const existingSession = chatGptTurnSessions.find(executionKey);
        const semantic = existingSession
          ? { parsed }
          : prepareSemanticRuntimeInput(parsed, environment, turnCapabilities);
        const traceId = existingSession?.traceId
          ?? chatGptWebTraceId(provider, parsed, semantic.epoch?.semanticEpoch);
        const session = await chatGptTurnSessions.getOrCreateAfterOwnerRetirement(
          executionKey,
          ownerKey,
          () => {
            if (parsed._compactionRequest) reserveWebCompaction(parsed, `${executionKey}:standalone:${traceId}`);
            return startRuntime(parsed, environment, traceId, turnCapabilities, {}, semantic);
          },
          traceId,
          incoming.abortSignal,
          nativeTurnId,
          nativeIdentity.threadId,
          chatGptInstructionLineage(parsed),
          provider.chatgptWeb?.maxBrowserSessions,
        );
        const roundKey = chatGptTurnRoundKey(parsed);
        const emitRoundEvents = (events: readonly AdapterEvent[]): void => {
          // Journal the complete synchronous event batch before touching the HTTP observer. If the
          // observer disconnects midway through emission, an exact reconnect can replay the entire
          // canonical batch instead of losing the already-drained tail.
          session.appendRoundEvents(roundKey, events);
          for (const event of events) emit(event);
        };
        const emitRoundBatch = (
          produce: (buffer: (event: AdapterEvent) => void) => void,
        ): void => {
          const events: AdapterEvent[] = [];
          produce(event => events.push(event));
          emitRoundEvents(events);
        };
        const emitRoundEvent = (event: AdapterEvent): void => emitRoundEvents([event]);
        let awaitingRuntime = false;
        try {
          await session.runExclusive(async () => {
            const replay = session.roundEvents(roundKey);
            replayEvents(replay, emit);
            if (session.roundCompleted(roundKey)) {
              const failure = session.roundFailure(roundKey);
              if (failure) throw failure;
              return;
            }
            if (session.roundHasTerminalEvent(roundKey)) {
              session.completeRound(roundKey);
              return;
            }
            const settled = session.settledOutcome();
            if (settled) {
              if (settled.type === "error") throw settled.error;
              const trace = session.runtime.trace.drain();
              const completedTextDeltas = session.runtime.text.drain();
              const finalReplay = replay.length === 0
                && trace.length === 0
                && completedTextDeltas.length === 0
                ? session.eventsForFinalReplay()
                : [];
              if (finalReplay.length > 0) {
                session.appendRoundReasoning(roundKey, session.reasoningForFinalReplay());
                emitRoundEvents(finalReplay);
              } else {
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                if (replay.length === 0 && !parsed._compactionRequest) {
                  emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
                }
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
                if (!bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas(completedTextDeltas, buffer));
                }
              }
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              structuredOutputValidator?.(settled.answer);
              if (bufferStructuredOutput) {
                emitRoundBatch(buffer => emitTextDeltas([settled.answer], buffer));
              }
              const reasoning = session.roundReasoning(roundKey);
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(session.roundEvents(roundKey));
              emitRoundBatch(buffer => emitBrowserCompletion(
                settled,
                estimateChatGptWebUsage(currentUsageInput(parsed), { answer: settled.answer, reasoning }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                buffer,
              ));
              session.completeRound(roundKey);
              chatGptWebTurnRetryPolicy.clear(retryKey);
              return;
            }

            let turnToken: string | undefined;
            if (session.runtime.mode === "tools") {
              turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
              if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
              await broker.updateEnvironment(turnToken, environment);

              const outstanding = session.outstanding();
              if (outstanding.length > 0) {
                const results = currentToolResults(parsed, session);
                if (results.length === 0) {
                  const reasoning = session.reasoningForOutstandingReplay();
                  if (replay.length === 0) emitRoundEvents(session.eventsForOutstandingReplay());
                  emitRoundBatch(buffer => emitToolBatch(
                    outstanding,
                    estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning, toolRequests: outstanding }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                    buffer,
                  ));
                  session.completeRound(roundKey);
                  return;
                }
                if (results.length !== outstanding.length) {
                  throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
                }
                const occupancy = session.runtime.semanticOccupancy;
                const batchPressure = occupancy?.batchPressureReason(results.map(message => ({
                  callId: message.toolCallId, content: message.content,
                })));
                if (occupancy && batchPressure === "atomic_result_oversize"
                  && !canReferenceOversizedResults(results, occupancy, session.runtime.oversizedResultSizes)) {
                  if (session.runtime.semanticThreadHash) emitSemanticLog({
                    event: "semantic_fallback",
                    threadHash: session.runtime.semanticThreadHash,
                    to: "recovery_error",
                    reason: batchPressure,
                  });
                  throw new ChatGptWebAdapterError(
                    "A complete canonical tool result exceeds the browser's physical capacity, including during Web compaction. Use an independently available native recovery route.",
                    { status: 409, errorType: "invalid_request_error", code: "semantic_atomic_result_too_large", retryable: false },
                  );
                }
                if (batchPressure && batchPressure !== "atomic_result_oversize") {
                  // Estimated accumulated pressure and uncertain occupancy are advisory.
                  // Deliver the unchanged batch once; the actual browser outcome owns failure.
                  console.warn(`[chatgpt-web] semantic_pressure_advisory ${JSON.stringify({ reason: batchPressure })}`);
                }
                // The broker must reserve all references against the cumulative
                // turn budget before any result is acknowledged to the browser.
                const reservations = oversizedResultReservations(results, occupancy);
                if (reservations.length > 0) {
                  await broker.reserveOversizedResults(turnToken, reservations);
                  const sizes = session.runtime.oversizedResultSizes ??= new Map<string, number>();
                  for (const entry of reservations) sizes.set(entry.callId, entry.canonical.length);
                }
                for (const message of results) {
                  const delivered = await browserFacingResult(broker, turnToken, message, occupancy);
                  await broker.completeTool(turnToken, message.toolCallId, delivered.result);
                  occupancy?.recordToolResult(message.toolCallId, delivered.visibleContent);
                  session.runtime.externalProgress.recordToolResult();
                  session.markResultDelivered(message.toolCallId);
                }
              }
            } else if (session.outstanding().length > 0) {
              throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
            }

            const toolWaitAbort = new AbortController();
            try {
              const roundReasoning = session.roundReasoning(roundKey);
              const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
                roundReasoning.push(...trace.map(event => event.text));
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
              };
              const emitNewText = (deltas: string[]) => {
                if (!bufferStructuredOutput) emitRoundBatch(buffer => emitTextDeltas(deltas, buffer));
              };
              if (replay.length === 0 && !parsed._compactionRequest) {
                emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              const externalProgress = session.runtime.mode === "tools"
                ? session.runtime.externalProgress
                : undefined;
              const armNextTools = () => turnToken
                ? broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(async requests => {
                  if (!externalProgress) {
                    throw new Error("ChatGPT broker returned tools for a read-only browser turn");
                  }
                  if (requests.length > 0) {
                    const revision = externalProgress.recordToolBatch(requests.length);
                    if (!session.runtime.manualControl) {
                      // The browser outcome is in the same race below and owns the semantic DOM and
                      // renderer deadlines. A second fixed timer here can retire an accepted turn
                      // while its same-tab observer is still recovering. Keep the causal barrier —
                      // tools are not emitted until the browser captures their text boundary — but
                      // let browser settlement or request cancellation end the wait.
                      await externalProgress.waitForToolBatchObservation(
                        revision,
                        toolWaitAbort.signal,
                      );
                    }
                    externalProgress.assertToolBatchActive(revision);
                  }
                  return { type: "tools" as const, requests };
                }).catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error))
                : undefined;
              let nextTools = armNextTools();
              const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
              const finishBrowserOutcome = async (completedOutcome: ChatGptBrowserOutcome): Promise<void> => {
                // Zero Risk completion and its owner-only empty-batch signal are resolved by the
                // same broker transition. Drain once more so the accepted final answer cannot be
                // overtaken by the terminal owner notification.
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(session.roundEvents(roundKey));
                if (turnToken) await broker.revoke(turnToken);
                if (completedOutcome.type === "error") throw completedOutcome.error;
                if (session.runtime.text.value() !== completedOutcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                structuredOutputValidator?.(completedOutcome.answer);
                if (bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas([completedOutcome.answer], buffer));
                }
                emitRoundBatch(buffer => emitBrowserCompletion(
                  completedOutcome,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { answer: completedOutcome.answer, reasoning: roundReasoning }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                  buffer,
                ));
                session.completeRound(roundKey);
                chatGptWebTurnRetryPolicy.clear(retryKey);
              };
              const waitForTrace = () => session.runtime.trace.wait(toolWaitAbort.signal)
                .then(() => ({ type: "trace" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              const waitForText = () => session.runtime.text.wait(toolWaitAbort.signal)
                .then(() => ({ type: "text" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              let nextTrace = waitForTrace();
              let nextText = waitForText();
              for (;;) {
                awaitingRuntime = true;
                const next = await withAbort(
                  Promise.race([
                    ...(nextTools ? [nextTools] : []),
                    browserOutcome,
                    nextTrace,
                    nextText,
                  ]),
                  incoming.abortSignal,
                );
                awaitingRuntime = false;
                if (next.type === "trace") {
                  emitNewTrace(session.runtime.trace.drain());
                  nextTrace = waitForTrace();
                  continue;
                }
                if (next.type === "text") {
                  emitNewText(session.runtime.text.drain());
                  nextText = waitForText();
                  continue;
                }
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                if (next.type === "browser") {
                  await finishBrowserOutcome(next.outcome);
                  return;
                }
                if (!turnToken || session.runtime.mode !== "tools" || !externalProgress) {
                  throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
                }
                if (next.requests.length === 0) {
                  if (!session.runtime.manualControl) {
                    throw new Error("ChatGPT tool bridge returned an empty batch");
                  }
                  await finishBrowserOutcome(await session.browserOutcome);
                  return;
                }
                validateBatchTools(parsed, next.requests);
                session.setOutstanding(next.requests, roundReasoning, session.roundEvents(roundKey));
                session.runtime.semanticOccupancy?.record(
                  `calls:${roundKey}`,
                  estimateTokens(JSON.stringify(next.requests), parsed.modelId),
                );
                emitRoundBatch(buffer => emitToolBatch(
                  next.requests,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                  buffer,
                ));
                session.completeRound(roundKey);
                return;
              }
            } finally {
              toolWaitAbort.abort();
            }
          });
        } catch (error) {
          if (incoming.abortSignal?.aborted && error instanceof DOMException && error.name === "AbortError") {
            if (session.runtime.manualControl) {
              // Zero Risk is user-driven and has no DOM observer that can distinguish continued
              // work from a stopped native turn. A closed Responses stream is therefore terminal:
              // revoke the MCP capability and release the Launcher tab instead of leaving a task
              // that Codex already shows as stopped waiting forever.
              chatGptTurnSessions.retire(executionKey, session);
            }
            // Automatic browser turns keep their exact execution and journal for reconnect. Their
            // owned DOM observer can continue proving the same accepted ChatGPT submission.
            throw error;
          }
          // Browser failure can retire tools before their next wait starts. Once that exact
          // browser has failed, its cause takes precedence over the cleanup's token error.
          // Validation and result-delivery failures never enter this branch.
          const settled = awaitingRuntime ? session.settledOutcome() : undefined;
          if (settled?.type === "error") error = settled.error;
          const turnError = submittedTurnFailure(session, error);
          const handledError = turnError instanceof ChatGptWebAdapterError && turnError.retryable
            ? chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, turnError)
            : turnError;
          if (!(turnError instanceof ChatGptWebAdapterError && turnError.retryable)) {
            chatGptWebTurnRetryPolicy.clear(retryKey);
          }
          if (handledError instanceof ChatGptWebAdapterError
            && handledError.code === "chatgpt_active_turn_compaction_required") {
            // Keep the exact outstanding calls and live source untouched. The current
            // ordinary round can replay its control error, while canonical compaction
            // owns any later settlement of the complete batch.
            emitRoundEvent({
              type: "error", message: handledError.message, status: handledError.status,
              errorType: handledError.errorType, code: handledError.code, retryable: false,
            });
            session.completeRound(roundKey);
            return;
          }
          if (handledError instanceof ChatGptWebAdapterError && !handledError.retryable) {
            // A deterministic request failure remains replayable so a native reconnect cannot burn
            // another browser attempt. Every other failure retires the browser session: client
            // disconnects, stage failures, and retryable ChatGPT errors must start a fresh surface
            // instead of replaying one rejected browser outcome for the registry's full TTL.
            session.cancel();
          } else {
            chatGptTurnSessions.retire(executionKey, session);
          }
          if (session.runtime.mode === "tools") {
            void session.runtime.token.then(turnToken => broker.revoke(turnToken)).catch(() => {});
          }
          if (handledError instanceof ChatGptWebAdapterError) {
            emitRoundEvent({
              type: "error",
              message: handledError.message,
              status: handledError.status,
              errorType: handledError.errorType,
              code: handledError.code,
              retryable: handledError.retryable,
            });
            session.completeRound(roundKey);
            return;
          }
          session.failRound(roundKey, turnError);
          chatGptWebTurnRetryPolicy.clear(retryKey);
          throw turnError;
        }
      };

      // Arm this before any awaited work, including environment lookup and owner retirement.
      const heartbeat = setInterval(
        () => {
          try { emit({ type: "heartbeat" }); }
          catch { /* emit detached the observer and wakes its pending awaits. */ }
        },
        CHATGPT_WEB_ADAPTER_HEARTBEAT_MS,
      );
      try {
        emit({ type: "heartbeat" });
        await runChatGptWebTurn();
      } catch (error) {
        // Cost state/rotation guards can reject before a browser session exists.
        // Preserve their typed 409 instead of letting the Responses bridge
        // reclassify a plain thrown error as a generic upstream failure.
        if (!(error instanceof ChatGptWebAdapterError)) throw error;
        emit({ type: "error", message: error.message, status: error.status,
          errorType: error.errorType, code: error.code, retryable: error.retryable });
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
