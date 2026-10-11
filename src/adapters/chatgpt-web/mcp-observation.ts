import { randomBytes } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// New opaque identity for each invocation; JSON-RPC IDs can be reused sequentially.
// Neither the protocol ID nor request arguments enter the diagnostic stream.
export function mcpDiagnosticId(): string {
  return `diag_${randomBytes(8).toString("hex")}`;
}

/** Fixed-schema lifecycle diagnostics. Never pass raw tool args, replies or error messages. */
export interface NativeToolDiagnosticFields {
  stage: string;
  diagnosticId?: string;
  traceId?: string;
  callId?: string;
  tool?: string;
  outcome?: "ok" | "is_error" | "timeout" | "aborted" | "unclassified_error";
  elapsedMs?: number;
  requestKind?: "shell" | "patch" | "freeform" | "structured";
  requestStructure?: "single" | "multiline" | "pipeline" | "inline_script" | "redirection";
  requestChars?: number;
  requestArgCount?: number;
  failureKind?: "safety_status_unknown" | "openai_safety_block";
}

/** Request metadata for classifier diagnostics. Never persist command, patch, args or input text. */
export function nativeToolRequestShape(request: {
  wireName: string;
  freeform: boolean;
  arguments?: Record<string, unknown>;
  input?: string;
}): Pick<NativeToolDiagnosticFields, "requestKind" | "requestStructure" | "requestChars" | "requestArgCount"> {
  const args = request.arguments;
  const command = typeof args?.cmd === "string" ? args.cmd
    : typeof args?.command === "string" ? args.command : undefined;
  const requestKind = /(?:^|_)apply_patch$/.test(request.wireName) ? "patch"
    : command !== undefined ? "shell"
      : request.freeform ? "freeform" : "structured";
  const text = command ?? (requestKind === "patch" && typeof args?.patch === "string" ? args.patch : undefined)
    ?? (request.freeform ? request.input : undefined);
  return {
    requestKind,
    requestArgCount: Math.min(Object.keys(args ?? {}).length, 256),
    ...(text === undefined ? {} : {
      requestChars: Math.min(text.length, 1_000_000),
      requestStructure: /<<\s*['"]?\w+|\b(?:python\d*|node|ruby|perl)\s+-[ce]\b/.test(text)
        ? "inline_script" as const
        : /\r|\n/.test(text) ? "multiline" as const
          : /\|/.test(text) ? "pipeline" as const
            : /[<>]/.test(text) ? "redirection" as const : "single" as const,
    }),
  };
}

/** Recognize literal tool error signals without retaining the error body. */
export function nativeToolSafetyMessage(error: unknown): NativeToolDiagnosticFields["failureKind"] {
  const text = error instanceof Error ? error.message : error;
  if (typeof text !== "string") return undefined;
  if (/couldn['’]t determine the safety status of the request/i.test(text)) return "safety_status_unknown";
  if (/blocked by OpenAI|OpenAI['’]s safety checks/i.test(text)) return "openai_safety_block";
  return undefined;
}

export function nativeToolSafetyFailure(result: { isError?: boolean; content?: unknown[] }): NativeToolDiagnosticFields["failureKind"] {
  if (!result.isError || !Array.isArray(result.content)) return undefined;
  for (const item of result.content.slice(0, 8)) {
    const text = item && typeof item === "object" && "text" in item ? item.text : undefined;
    if (typeof text !== "string") continue;
    const category = nativeToolSafetyMessage(text);
    if (category) return category;
  }
  return undefined;
}

let remoteSink: ((fields: NativeToolDiagnosticFields) => void) | undefined;

/** A single MCP process can relay its bounded metadata to the daemon log. */
export function setNativeToolDiagnosticSink(sink?: (fields: NativeToolDiagnosticFields) => void): void {
  remoteSink = sink;
}

export function emitNativeToolDiagnostic(fields: NativeToolDiagnosticFields): void {
  try {
    // MCP uses stdout exclusively for JSON-RPC. Never write diagnostics there.
    console.error(JSON.stringify({ event: "native_tool_diagnostic", ...fields }));
  } catch { /* Logging must not alter MCP or Codex execution. */ }
  try { remoteSink?.(fields); } catch { /* Preserve execution if the relay is unavailable. */ }
}

/** The model override only; prompts, names, items and other tool arguments stay private. */
export function subagentModelObservation(wireName: string, args?: Record<string, unknown>) {
  if (!/^(multi_agent_v[12]|collaboration)__spawn_agent$/.test(wireName)) return undefined;
  if (!args || !Object.hasOwn(args, "model")) return { modelOverride: "omitted" as const };
  const model = args.model;
  // Unknown model values remain visible as an explicit override without logging arbitrary input.
  return typeof model === "string" && /^(?:chatgpt-web\/)?gpt-[a-z0-9][a-z0-9._-]{0,79}$/.test(model)
    ? { modelOverride: "explicit" as const, requestedModel: model }
    : { modelOverride: "unrecognized" as const };
}

/** Content-free receipt/reply observations. A sent MCP result is not proof of tool execution. */
export function observeMcpToolCalls(
  transport: Transport,
  knownTools: ReadonlySet<string>,
  write: (event: Record<string, unknown>) => void = event => console.error(`[chatgpt-web-mcp] transport=${JSON.stringify(event)}`),
  invocationIds: Map<string | number, string> = new Map(),
): Transport {
  let sequence = 0;
  const pending = new Map<string | number, {
    call: number; diagnosticId: string; tool: string; started: number;
    outstanding: number; ambiguous: boolean;
  }>();
  const emit = (event: Record<string, unknown>) => {
    // Logging is observational: a broken sink cannot change the invocation or its result.
    try { write({ pid: process.pid, ...event }); } catch { /* Preserve transport semantics. */ }
  };
  const receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if ("method" in message && message.method === "tools/call" && "id" in message) {
      const name = message.params?.name;
      const tool = typeof name === "string" && knownTools.has(name) ? name : "unknown";
      const rawArgs = message.params?.arguments;
      const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? rawArgs as Record<string, unknown> : undefined;
      const shape = nativeToolRequestShape({
        wireName: tool === "codex_exec" ? "exec_command" : tool,
        freeform: false, arguments: args,
      });
      const previous = pending.get(message.id);
      if (previous) {
        // An ambiguous protocol ID cannot safely correlate either reply.
        previous.ambiguous = true;
        previous.outstanding += 1;
        invocationIds.delete(message.id);
        emit({ event: "uncorrelated_call", reason: "duplicate_id", tool });
      } else if (pending.size >= 1_024) {
        emit({ event: "uncorrelated_call", reason: "tracking_limit", tool });
      } else {
        const call = {
          call: ++sequence, diagnosticId: mcpDiagnosticId(), tool, started: performance.now(),
          outstanding: 1, ambiguous: false,
        };
        pending.set(message.id, call);
        invocationIds.set(message.id, call.diagnosticId);
        emit({ event: "call_received", call: call.call, diagnosticId: call.diagnosticId, tool, ...shape });
      }
    }
    receive?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    const id = "id" in message ? message.id : undefined;
    const call = id !== undefined && id !== null && !("method" in message) ? pending.get(id) : undefined;
    try {
      await send(message, options);
      if (call && !call.ambiguous) {
        const result = "result" in message ? message.result : undefined;
        emit({
          event: "reply_sent", call: call.call, diagnosticId: call.diagnosticId, tool: call.tool,
          elapsed_ms: Math.round(performance.now() - call.started),
          outcome: "error" in message ? "protocol_error" : "result",
          ...("result" in message ? { is_error: result?.isError === true } : {}),
        });
      }
    } catch (error) {
      if (call && !call.ambiguous) emit({ event: "reply_send_failed", call: call.call, diagnosticId: call.diagnosticId, tool: call.tool });
      throw error;
    } finally {
      if (call && id !== undefined && id !== null) {
        call.outstanding -= 1;
        if (call.outstanding === 0 && pending.get(id) === call) {
          pending.delete(id);
          invocationIds.delete(id);
        }
      }
    }
  };
  const close = transport.onclose;
  transport.onclose = () => {
    if (pending.size) emit({ event: "transport_closed", tracked_calls: pending.size });
    pending.clear();
    invocationIds.clear();
    close?.();
  };
  return transport;
}
