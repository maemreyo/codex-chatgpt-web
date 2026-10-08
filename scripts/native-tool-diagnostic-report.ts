import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

type Json = Record<string, unknown>;

export interface NativeToolDiagnosticReport {
  mcpIngressCalls: number;
  browserSafetyTextObservations: number;
  observedCorrelations: number;
  correlationsWithCodexResult: number;
  correlationsWithReportedError: number;
  lifecycleStages: Record<string, number>;
  safetySignals: Array<{ traceHash: string; correlatedCalls: number; observedMcpIngresses: number }>;
  recentCalls: Array<{
    diagnosticId: string;
    traceHash?: string;
    stages: string[];
    reportedError: boolean;
  }>;
}

const STAGES = new Set([
  "mcp_ingress", "mcp_reply_sent", "mcp_reply_send_failed",
  "handler_entered", "broker_claimed", "handler_result", "handler_failed",
  "broker_invoke_requested", "broker_invoke_settled", "broker_invoke_failed",
  "broker_queued", "broker_delivered_to_codex_adapter", "broker_redelivered",
  "codex_result_received", "broker_claim_with_turn", "browser_safety_text_visible",
]);

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function parseJson(value: string): Json | undefined {
  try { return object(JSON.parse(value)); } catch { return undefined; }
}

function diagnosticRecord(line: string): Json | undefined {
  const envelope = parseJson(line);
  if (!envelope) return undefined;
  const source = typeof object(envelope.detail)?.line === "string" ? object(envelope.detail)!.line as string : line;
  // MCP transport observations use the existing logger prefix; runtime events
  // are already JSON. Never include arbitrary input text in this report.
  const payload = source.startsWith("[chatgpt-web-mcp] transport=")
    ? source.slice("[chatgpt-web-mcp] transport=".length) : source;
  return parseJson(payload);
}

export function nativeToolDiagnosticReport(path: string): NativeToolDiagnosticReport {
  const calls = new Map<string, { stages: string[]; reportedError: boolean; traceHash?: string }>();
  const safetyTraces = new Set<string>();
  const lifecycleStages: Record<string, number> = {};
  let browserSafetyTextObservations = 0;
  const traceHash = (value: unknown): string | undefined => (
    typeof value === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(value)
      ? createHash("sha256").update(value).digest("hex").slice(0, 12) : undefined
  );

  const observe = (diagnosticId: string, stage: string, error = false) => {
    let entry = calls.get(diagnosticId);
    if (!entry) {
      entry = { stages: [], reportedError: false };
      calls.set(diagnosticId, entry);
    }
    if (!entry.stages.includes(stage)) entry.stages.push(stage);
    entry.reportedError ||= error;
  };

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const event = diagnosticRecord(line);
    if (!event) continue;
    const diagnosticId = typeof event.diagnosticId === "string" && /^diag_[a-f0-9]{16}$/.test(event.diagnosticId)
      ? event.diagnosticId : undefined;
    if (event.event === "native_tool_diagnostic" && typeof event.stage === "string" && STAGES.has(event.stage)) {
      lifecycleStages[event.stage] = (lifecycleStages[event.stage] ?? 0) + 1;
      const trace = traceHash(event.traceId);
      if (event.stage === "browser_safety_text_visible") {
        browserSafetyTextObservations += 1;
        if (trace) safetyTraces.add(trace);
      }
      if (diagnosticId) {
        observe(diagnosticId, event.stage,
          event.outcome === "is_error" || event.outcome === "timeout" || event.outcome === "unclassified_error");
        if (trace) calls.get(diagnosticId)!.traceHash = trace;
      }
    } else if (event.event === "call_received" && diagnosticId) {
      observe(diagnosticId, "mcp_ingress");
    } else if (event.event === "reply_sent" && diagnosticId) {
      observe(diagnosticId, "mcp_reply_sent", event.is_error === true || event.outcome === "protocol_error");
    } else if (event.event === "reply_send_failed" && diagnosticId) {
      observe(diagnosticId, "mcp_reply_send_failed", true);
    }
  }

  const recentCalls = [...calls].slice(-50).map(([diagnosticId, observation]) => ({
    diagnosticId, ...observation,
  }));
  return {
    mcpIngressCalls: [...calls.values()].filter(call => call.stages.includes("mcp_ingress")).length,
    browserSafetyTextObservations,
    observedCorrelations: calls.size,
    correlationsWithCodexResult: [...calls.values()].filter(call => call.stages.includes("codex_result_received")).length,
    correlationsWithReportedError: [...calls.values()].filter(call => call.reportedError).length,
    lifecycleStages,
    safetySignals: [...safetyTraces].map(trace => {
      const related = [...calls.values()].filter(call => call.traceHash === trace);
      return {
        traceHash: trace, correlatedCalls: related.length,
        observedMcpIngresses: related.filter(call => call.stages.includes("mcp_ingress")).length,
      };
    }),
    recentCalls,
  };
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: bun run scripts/native-tool-diagnostic-report.ts <exported-diagnostics.jsonl>");
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(nativeToolDiagnosticReport(file), null, 2));
  }
}
