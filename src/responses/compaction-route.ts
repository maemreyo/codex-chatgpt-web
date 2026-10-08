import { isNativeTextCompaction } from "./compaction";

export type CanonicalCompactionProtocol = "v1" | "v2" | "memento";

/** Classify canonical Codex input before selecting native or browser inference. */
export function classifyCanonicalCompaction(
  body: unknown,
  endpoint: "responses" | "responses/compact",
): CanonicalCompactionProtocol | undefined {
  if (endpoint === "responses/compact") return "v1";
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const request = body as { input?: unknown };
  const last = Array.isArray(request.input) ? request.input.at(-1) : undefined;
  if (last && typeof last === "object" && !Array.isArray(last) && (last as { type?: unknown }).type === "compaction_trigger") {
    return "v2";
  }
  return isNativeTextCompaction(body) ? "memento" : undefined;
}
