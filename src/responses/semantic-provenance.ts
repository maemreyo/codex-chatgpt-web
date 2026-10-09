import { createHash } from "node:crypto";
import { estimateTokens } from "../lib/token-estimate";
import { namespacedToolName } from "../types";
import type {
  CodexAssistantMessage,
  CodexMessage,
  CodexParsedRequest,
  CodexSemanticCanonicalItemV1,
  CodexSemanticProvenanceV1,
  CodexToolCall,
  CodexToolResultMessage,
} from "../types";

export const SEMANTIC_DIGEST_POLICY_VERSION = 3 as const;
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

// Codex rewrites these presentation-only fields when it replays completed
// responses. This normalization is restricted to their documented item shapes;
// user/developer messages, tool arguments and tool results remain exact.
function stableHistoryItem(value: unknown): unknown {
  const item = record(value);
  if (!item) return value;
  if (item.type === "reasoning") {
    const copy = { ...item };
    if (copy.content === null) delete copy.content;
    if (copy.encrypted_content === null) delete copy.encrypted_content;
    return copy;
  }
  if (item.type === "message" && item.role === "assistant") {
    const copy = { ...item };
    if (copy.status === "completed") delete copy.status;
    if (Array.isArray(copy.content)) {
      copy.content = copy.content.map(value => {
        const part = record(value);
        if (!part || part.type !== "output_text" || !Array.isArray(part.annotations)
          || part.annotations.length !== 0) return value;
        const cleaned = { ...part };
        delete cleaned.annotations;
        return cleaned;
      });
    }
    return copy;
  }
  return value;
}

function stableHistoryJson(canonicalJson: string): string {
  return semanticCanonicalJson(stableHistoryItem(JSON.parse(canonicalJson)));
}

export function semanticHistoryItemHash(canonicalJson: string, version: 1 | 2 | 3 = SEMANTIC_DIGEST_POLICY_VERSION): string {
  return semanticHash(version === 1 ? canonicalJson : stableHistoryJson(canonicalJson));
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
    const digest = semanticHistoryItemHash(canonicalJson);
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
  version: 1 | 2 | 3 = SEMANTIC_DIGEST_POLICY_VERSION,
): string {
  const index = provenance.items.findIndex(item => item.ref === coveredThroughRef);
  if (index < 0) throw new Error("Semantic covered-history anchor is missing");
  const hash = createHash("sha256");
  hash.update(`semantic-digest-v${version}\n`);
  for (const item of provenance.items.slice(0, index + 1)) {
    // additional_tools is the CURRENT live tool registry injected with each
    // request; its ephemeral id/descriptions are not settled historical evidence.
    // The parser independently refreshes those tool specs on every turn.
    if (version >= 2 && item.type === "additional_tools") continue;
    hash.update(version === 1 ? item.canonicalJson : stableHistoryJson(item.canonicalJson));
    hash.update("\n");
  }
  if (version === 3) {
    hash.update("covered-tool-registry-v1\n");
    hash.update(semanticCanonicalJson(coveredToolRegistrations(provenance, index)));
    hash.update("\n");
  }
  return hash.digest("hex");
}

// Live `additional_tools` is reissued on every request. Bind only execution
// contracts for names actually called in the covered prefix. IDs and human
// descriptions are volatile; routing, type and argument schemas are not.
// A changed name/schema therefore invalidates the epoch without requiring
// unrelated current tool descriptions to match a historical browser turn.
function coveredToolRegistrations(provenance: CodexSemanticProvenanceV1, cut: number): unknown[] {
  const used = new Set<string>();
  for (const item of provenance.items.slice(0, cut + 1)) {
    if (!["function_call", "custom_tool_call", "tool_search_call", "local_shell_call"].includes(item.type ?? "")) continue;
    const call = record(JSON.parse(item.canonicalJson));
    if (item.type === "tool_search_call") used.add("tool_search");
    else if (item.type === "local_shell_call") used.add("local_shell");
    else if (typeof call?.name === "string") {
      const namespace = typeof call.namespace === "string" && call.namespace !== "functions"
        ? call.namespace : undefined;
      used.add(namespacedToolName(namespace, call.name));
    }
  }
  const definitions = new Map<string, unknown[]>();
  function binding(value: unknown, depth = 0): unknown {
    const obj = record(value);
    if (!obj) return Array.isArray(value) ? value.map(child => binding(child, depth + 1)) : value;
    return Object.fromEntries(Object.entries(obj)
      // `id` is volatile on the declaration itself. Within a parameter schema,
      // `properties.id` is a real argument and must remain digest-bound.
      .filter(([key]) => key !== "description" && !(depth === 0 && key === "id"))
      .map(([key, child]) => [key, binding(child, depth + 1)]));
  }
  function register(spec: unknown, namespace?: string): void {
    const tool = record(spec);
    if (!tool) return;
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      for (const child of tool.tools) register(child, tool.name === "functions" ? undefined : String(tool.name));
      return;
    }
    const name = tool.type === "tool_search" ? "tool_search"
      : typeof tool.name === "string" ? (namespace ? `${namespace}__${tool.name}` : tool.name) : undefined;
    if (!name || !used.has(name)) return;
    const entries = definitions.get(name) ?? [];
    entries.push(binding({ ...tool, ...(namespace ? { namespace } : {}) }));
    definitions.set(name, entries);
  }
  // Replayed tool-search results already belong to the covered digest. The
  // additional_tools registry here is only the live declaration surface.
  for (const item of provenance.items) {
    if (item.type !== "additional_tools") continue;
    const registry = record(JSON.parse(item.canonicalJson));
    if (Array.isArray(registry?.tools)) for (const spec of registry.tools) register(spec);
  }
  for (const spec of provenance.toolRegistrySpecs ?? []) register(spec);
  // Duplicate declarations of the same execution contract are semantically
  // identical; replay must not depend on the number of registry wrappers.
  return [...used].sort().map(name => [
    name, [...new Set((definitions.get(name) ?? []).map(semanticCanonicalJson))].sort(),
  ]);
}

export function semanticCoveredToolCallsExist(provenance: CodexSemanticProvenanceV1, coveredThroughRef: string): boolean {
  const index = provenance.items.findIndex(item => item.ref === coveredThroughRef);
  if (index < 0) return false;
  return provenance.items.slice(0, index + 1).some(item =>
    ["function_call", "custom_tool_call", "tool_search_call", "local_shell_call"].includes(item.type ?? ""));
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
  return text.split(/\r?\n/).some(line => {
    const row = line.trim();
    if (/^(?:\(?fail\)|FAIL(?:ED)?\b|not ok\b)(?:\s|:|$)/i.test(row)) return true;
    // "0 fail" and "0 failed" are successful test summaries, not failure markers.
    return /\b[1-9]\d*\s+fail(?:ed|ures?)?\b/i.test(row);
  });
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
  status: "success" | "failure" | "unknown";
  exit?: number;
}

export function semanticMaskToolResult(
  message: CodexToolResultMessage,
  canonicalRef: string,
): SemanticMaskedToolResultV1 {
  const text = resultText(message);
  const exit = exitCode(text);
  const failed = message.isError || (exit !== undefined && exit !== 0) || failingTestOutput(text);
  const status = failed ? "failure" : exit === 0 ? "success" : "unknown";
  const outcome = message.isError ? "error" : exit !== undefined ? `exit ${exit}` : failed ? "error" : "unknown";
  const originalTokens = estimateTokens(text);
  const bodyExcerpt = failed ? excerpt(text) : "none";
  const placeholder = `[tool result omitted: tool=${message.toolName || "unknown"} ref=${canonicalRef} size=${originalTokens} outcome=${outcome} excerpt=${bodyExcerpt}. The body is not in view. Re-running a tool may not be safe or idempotent.]`;
  return {
    message: { ...message, content: placeholder },
    originalTokens,
    maskedTokens: estimateTokens(placeholder),
    failed,
    status,
    ...(exit !== undefined ? { exit } : {}),
  };
}

export type SemanticArtifactOutcome = "success" | "failure" | "unknown";

export interface ChatGptArtifactLedgerV1 {
  filesTouched: Array<{ path: string; op: "read" | "write" | "delete" | "unknown"; ref: string }>;
  // `failed` remains for persisted v1 compatibility. Only `status` can establish success;
  // `failed: false` alone can mean the result was absent or inconclusive.
  commands: Array<{ commandDigest: string; exit?: number; failed: boolean; status?: SemanticArtifactOutcome; ref: string }>;
  testOutcomes: Array<{ ref: string; failed: boolean; status?: SemanticArtifactOutcome; excerptRef?: string }>;
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
        status: masked?.status ?? "unknown",
        ref,
      });
      if (classification.test) {
        ledger.testOutcomes.push({
          ref,
          failed: masked?.failed ?? false,
          status: masked?.status ?? "unknown",
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
    "Treat status=unknown and legacy rows without status as unverified. A failed=false field alone does not prove success.",
    semanticCanonicalJson(ledger),
    "</semantic_artifact_ledger>",
  ].join("\n");
}

export function semanticAssistantToolCallIds(message: CodexAssistantMessage): string[] {
  return message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []);
}
