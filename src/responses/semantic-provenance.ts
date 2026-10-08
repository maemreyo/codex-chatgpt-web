import { createHash } from "node:crypto";
import { estimateTokens } from "../lib/token-estimate";
import type {
  CodexAssistantMessage,
  CodexMessage,
  CodexParsedRequest,
  CodexSemanticCanonicalItemV1,
  CodexSemanticProvenanceV1,
  CodexToolCall,
  CodexToolResultMessage,
} from "../types";

export const SEMANTIC_DIGEST_POLICY_VERSION = 1 as const;
export const SEMANTIC_MASKING_POLICY_VERSION = 1 as const;
const EXCERPT_CHARS = 160;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  const object = record(value);
  if (!object) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    const child = object[key];
    if (child !== undefined) result[key] = normalized(child);
  }
  return result;
}

export function semanticCanonicalJson(value: unknown): string {
  return JSON.stringify(normalized(value));
}

export function semanticHash(value: unknown): string {
  const source = typeof value === "string" ? value : semanticCanonicalJson(value);
  return createHash("sha256").update(source).digest("hex");
}

function sourceInput(body: unknown): unknown[] {
  const raw = record(body)?.input;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return [{ role: "user", content: raw }];
  return raw === undefined ? [] : [raw];
}

export function semanticCanonicalItemsFromBody(body: unknown): CodexSemanticCanonicalItemV1[] {
  const occurrences = new Map<string, number>();
  return sourceInput(body).map((item, rawIndex) => {
    const canonicalJson = semanticCanonicalJson(item);
    const digest = semanticHash(canonicalJson);
    const ordinal = (occurrences.get(digest) ?? 0) + 1;
    occurrences.set(digest, ordinal);
    const raw = record(item);
    const metadata = record(raw?.internal_chat_message_metadata_passthrough);
    const effectiveType = typeof raw?.type === "string"
      ? raw.type
      : typeof raw?.role === "string" ? "message" : undefined;
    return {
      ref: `ci1_${digest.slice(0, 24)}_${ordinal}`,
      canonicalJson,
      rawIndex,
      ...(effectiveType ? { type: effectiveType } : {}),
      ...(typeof raw?.role === "string" ? { role: raw.role } : {}),
      ...(typeof metadata?.turn_id === "string" ? { turnId: metadata.turn_id } : {}),
      ...(typeof raw?.id === "string" ? { itemId: raw.id } : {}),
      ...(typeof raw?.call_id === "string" ? { callId: raw.call_id } : {}),
    };
  });
}

export function semanticCoveredHistoryDigest(
  provenance: CodexSemanticProvenanceV1,
  coveredThroughRef: string,
): string {
  const index = provenance.items.findIndex(item => item.ref === coveredThroughRef);
  if (index < 0) throw new Error("Semantic covered-history anchor is missing");
  const hash = createHash("sha256");
  hash.update(`semantic-digest-v${SEMANTIC_DIGEST_POLICY_VERSION}\n`);
  for (const item of provenance.items.slice(0, index + 1)) {
    hash.update(item.canonicalJson);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function semanticMessageRefs(parsed: CodexParsedRequest, messageIndex: number): readonly string[] {
  return parsed._semanticProvenance?.messageSourceRefs[messageIndex] ?? [];
}

export function semanticPinnedMessageRefs(parsed: CodexParsedRequest): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  parsed.context.messages.forEach((message, index) => {
    if (message.role !== "developer" && !(message.role === "user" && message.origin === "codex_skill")) return;
    for (const ref of semanticMessageRefs(parsed, index)) {
      if (!seen.has(ref)) {
        seen.add(ref);
        refs.push(ref);
      }
    }
  });
  return refs;
}

function resultText(message: CodexToolResultMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map(part => part.type === "text" ? part.text : "[image output omitted]").join("\n");
}

function exitCode(text: string): number | undefined {
  const patterns = [
    /Process exited with code\s+(-?\d+)/i,
    /\bexit(?:ed)?(?:\s+with)?(?:\s+code)?[:= ]+(-?\d+)\b/i,
    /\"exit_code\"\s*:\s*(-?\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return undefined;
}

function failingTestOutput(text: string): boolean {
  return /(?:^|\b)(?:FAIL(?:ED)?|\d+\s+fail(?:ed|ures?)?|tests?\s+failed)(?:\b|:)/im.test(text);
}

function excerpt(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= EXCERPT_CHARS * 2) return compact;
  return `${compact.slice(0, EXCERPT_CHARS)} … ${compact.slice(-EXCERPT_CHARS)}`;
}

export interface SemanticMaskedToolResultV1 {
  message: CodexToolResultMessage;
  originalTokens: number;
  maskedTokens: number;
  failed: boolean;
  exit?: number;
}

export function semanticMaskToolResult(
  message: CodexToolResultMessage,
  canonicalRef: string,
): SemanticMaskedToolResultV1 {
  const text = resultText(message);
  const exit = exitCode(text);
  const failed = message.isError || (exit !== undefined && exit !== 0) || failingTestOutput(text);
  const outcome = message.isError ? "error" : exit !== undefined ? `exit ${exit}` : failed ? "error" : "ok";
  const originalTokens = estimateTokens(text);
  const bodyExcerpt = failed ? excerpt(text) : "none";
  const placeholder = `[tool result omitted: tool=${message.toolName || "unknown"} ref=${canonicalRef} size=${originalTokens} outcome=${outcome} excerpt=${bodyExcerpt}. The body is not in view. Re-running a tool may not be safe or idempotent.]`;
  return {
    message: { ...message, content: placeholder },
    originalTokens,
    maskedTokens: estimateTokens(placeholder),
    failed,
    ...(exit !== undefined ? { exit } : {}),
  };
}

export interface ChatGptArtifactLedgerV1 {
  filesTouched: Array<{ path: string; op: "read" | "write" | "delete" | "unknown"; ref: string }>;
  commands: Array<{ commandDigest: string; exit?: number; failed: boolean; ref: string }>;
  testOutcomes: Array<{ ref: string; failed: boolean; excerptRef?: string }>;
}

export type SemanticArtifactToolClassification =
  | { kind: "file"; op: "read" | "write" | "delete" | "unknown"; paths: string[] }
  | { kind: "command"; command: string; test: boolean }
  | { kind: "unknown" };

function stringPaths(arguments_: Record<string, unknown>): string[] {
  const candidates = [arguments_.path, arguments_.file_path, arguments_.filepath, arguments_.target];
  return candidates.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]!.trim());
}

function commandText(arguments_: Record<string, unknown>): string | undefined {
  if (typeof arguments_.cmd === "string") return arguments_.cmd;
  if (typeof arguments_.command === "string") return arguments_.command;
  if (Array.isArray(arguments_.command) && arguments_.command.every(value => typeof value === "string")) {
    return arguments_.command.join(" ");
  }
  if (typeof arguments_.input === "string") return arguments_.input;
  return undefined;
}

export function classifySemanticArtifactToolCall(call: CodexToolCall): SemanticArtifactToolClassification {
  const name = call.name.toLowerCase();
  const command = commandText(call.arguments);
  if (["shell", "exec_command", "codex_exec"].includes(name) && command !== undefined) {
    return { kind: "command", command, test: /(^|\s)(?:bun\s+test|npm\s+test|pnpm\s+test|yarn\s+test|pytest|vitest|jest)(\s|$)/i.test(command) };
  }
  if (["apply_patch", "codex_apply_patch"].includes(name)) {
    const patch = typeof call.arguments.patch === "string" ? call.arguments.patch : command ?? "";
    return { kind: "file", op: "write", paths: patchPaths(patch) };
  }
  const paths = stringPaths(call.arguments);
  if (["read_file", "codex_view_image"].includes(name)) return { kind: "file", op: "read", paths };
  if (["write_file", "edit_file", "patch_file"].includes(name)) return { kind: "file", op: "write", paths };
  if (["delete_file", "remove_file"].includes(name)) return { kind: "file", op: "delete", paths };
  if (paths.length > 0) return { kind: "file", op: "unknown", paths };
  return { kind: "unknown" };
}

function toolCalls(messages: readonly CodexMessage[]): CodexToolCall[] {
  return messages.flatMap(message => message.role === "assistant"
    ? message.content.filter((part): part is CodexToolCall => part.type === "toolCall")
    : []);
}

function toolResultByCall(messages: readonly CodexMessage[], callId: string): { message: CodexToolResultMessage; index: number } | undefined {
  const index = messages.findIndex(message => message.role === "toolResult" && message.toolCallId === callId);
  if (index < 0) return undefined;
  return { message: messages[index] as CodexToolResultMessage, index };
}

function callRef(provenance: CodexSemanticProvenanceV1, callId: string): string | undefined {
  return provenance.items.find(item => item.callId === callId)?.ref;
}

export function extractSemanticArtifactLedger(
  parsed: CodexParsedRequest,
  coveredThroughRef: string,
): ChatGptArtifactLedgerV1 {
  const provenance = parsed._semanticProvenance;
  if (!provenance) throw new Error("Semantic provenance is unavailable");
  const cut = provenance.items.findIndex(item => item.ref === coveredThroughRef);
  if (cut < 0) throw new Error("Semantic covered-history anchor is missing");
  const coveredRefs = new Set(provenance.items.slice(0, cut + 1).map(item => item.ref));
  const ledger: ChatGptArtifactLedgerV1 = { filesTouched: [], commands: [], testOutcomes: [] };
  for (const call of toolCalls(parsed.context.messages)) {
    const ref = callRef(provenance, call.id);
    if (!ref || !coveredRefs.has(ref)) continue;
    const classification = classifySemanticArtifactToolCall(call);
    const result = toolResultByCall(parsed.context.messages, call.id);
    const resultRef = result ? semanticMessageRefs(parsed, result.index)[0] : undefined;
    const masked = result && resultRef ? semanticMaskToolResult(result.message, resultRef) : undefined;
    if (classification.kind === "file") {
      for (const path of classification.paths) ledger.filesTouched.push({ path, op: classification.op, ref });
    } else if (classification.kind === "command") {
      ledger.commands.push({
        commandDigest: semanticHash(classification.command),
        ...(masked?.exit !== undefined ? { exit: masked.exit } : {}),
        failed: masked?.failed ?? false,
        ref,
      });
      if (classification.test) {
        ledger.testOutcomes.push({
          ref,
          failed: masked?.failed ?? false,
          ...(masked?.failed && resultRef ? { excerptRef: resultRef } : {}),
        });
      }
    }
  }
  return ledger;
}

export function renderSemanticArtifactLedger(ledger: ChatGptArtifactLedgerV1): string {
  return [
    "<semantic_artifact_ledger version=\"1\">",
    "Bridge-extracted historical artifact metadata; it is not verified current repository state.",
    semanticCanonicalJson(ledger),
    "</semantic_artifact_ledger>",
  ].join("\n");
}

export function semanticAssistantToolCallIds(message: CodexAssistantMessage): string[] {
  return message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []);
}
