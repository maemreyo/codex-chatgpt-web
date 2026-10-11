import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeToolDiagnosticReport } from "../scripts/native-tool-diagnostic-report";

test("native tool log report correlates launcher MCP and broker records without text payloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-tool-report-"));
  const file = join(dir, "diagnostics.jsonl");
  const diagnosticId = "diag_aabbccddeeff0011";
  const event = (value: Record<string, unknown>) => JSON.stringify({
    at: "2026-10-08T00:00:00.000Z", level: "info", event: "runtime.daemon_stdout",
    detail: { line: JSON.stringify(value) },
  });
  const mcp = (value: Record<string, unknown>) => JSON.stringify({
    at: "2026-10-08T00:00:00.000Z", level: "warning", event: "runtime.mcp_stderr",
    detail: { line: `[chatgpt-web-mcp] transport=${JSON.stringify(value)}` },
  });
  try {
    writeFileSync(file, [
      mcp({ event: "call_received", diagnosticId, tool: "codex_exec" }),
      event({ event: "native_tool_diagnostic", diagnosticId, stage: "mcp_ingress", requestKind: "shell", requestStructure: "inline_script", requestChars: 45 }),
      event({ event: "native_tool_diagnostic", diagnosticId, stage: "broker_queued" }),
      event({ event: "native_tool_diagnostic", diagnosticId, stage: "broker_claim_with_turn", traceId: "sample-trace" }),
      event({ event: "native_tool_diagnostic", diagnosticId, stage: "broker_delivered_to_codex_adapter" }),
      event({ event: "native_tool_diagnostic", diagnosticId, stage: "codex_result_received", outcome: "is_error", failureKind: "safety_status_unknown" }),
      mcp({ event: "reply_sent", diagnosticId, is_error: true }),
      event({ event: "native_tool_diagnostic", stage: "browser_safety_text_visible", traceId: "sample-trace" }),
      event({ event: "native_tool_diagnostic", stage: "browser_safety_text_visible", traceId: "unlinked-trace" }),
      JSON.stringify({ at: "test", level: "info", event: "runtime.stdout", detail: { line: "private text and secret_command" } }),
    ].join("\n"));
    const report = nativeToolDiagnosticReport(file);
    expect(report).toMatchObject({
      mcpIngressCalls: 1,
      browserSafetyTextObservations: 2,
      observedCorrelations: 1,
      correlationsWithCodexResult: 1,
      correlationsWithReportedError: 1,
      archiveRetention: {
        overflowObserved: false,
        droppedRoutine: 0, droppedActionable: 0, droppedInvalid: 0,
        correlationCoverage: "observed_only",
      },
      requestKinds: { shell: 1 },
      failureKinds: { safety_status_unknown: 1 },
    });
    expect(report.recentCalls[0]).toEqual({
      diagnosticId,
      stages: ["mcp_ingress", "broker_queued", "broker_claim_with_turn", "broker_delivered_to_codex_adapter", "codex_result_received", "mcp_reply_sent"],
      reportedError: true,
      traceHash: expect.any(String),
      requestKind: "shell", requestStructure: "inline_script", requestChars: 45,
      failureKind: "safety_status_unknown",
    });
    expect(report.safetySignals).toHaveLength(2);
    expect(report.safetySignals.map(signal => [signal.correlatedCalls, signal.observedMcpIngresses])).toEqual([[1, 1], [0, 0]]);
    expect(JSON.stringify(report)).not.toContain("secret_command");
    expect(JSON.stringify(report)).not.toContain("private text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native tool diagnostic report flags archive-pruned lifecycle evidence without guessing missing results", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-tool-pruned-report-"));
  const file = join(dir, "diagnostics.jsonl");
  const observed = (payload: Record<string, unknown>) => JSON.stringify({
    at: "2026-10-11T12:00:00.000Z", level: "info", event: "diagnostic_observation",
    detail: { line: JSON.stringify(payload) },
  });
  try {
    writeFileSync(file, [
      observed({ event: "diagnostic_archive_overflow", droppedRoutine: 122,
        droppedActionable: 0, droppedInvalid: 3, prompt: "PRIVATE_PROMPT" }),
      observed({ event: "native_tool_diagnostic", diagnosticId: "diag_0123456789abcdef",
        stage: "mcp_ingress" }),
      observed({ event: "native_tool_diagnostic", diagnosticId: "diag_0123456789abcdef",
        stage: "broker_queued" }),
    ].join("\n"));
    const report = nativeToolDiagnosticReport(file);
    expect(report).toMatchObject({
      mcpIngressCalls: 1, correlationsWithCodexResult: 0,
      archiveRetention: { overflowObserved: true, droppedRoutine: 122,
        droppedActionable: 0, droppedInvalid: 3, correlationCoverage: "partial" },
    });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_PROMPT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native tool diagnostic report only exposes archive-allowlisted classification values", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-tool-private-report-"));
  const file = join(dir, "diagnostics.jsonl");
  const unsafeId = "diag_1111111111111111";
  const safeId = "diag_2222222222222222";
  const secret = "SECRET_FROM_RAW_LOG";
  const observed = (payload: Record<string, unknown>) => JSON.stringify({
    at: "2026-10-11T12:00:00.000Z", level: "info", event: "runtime.daemon_stdout",
    detail: { line: JSON.stringify(payload) },
  });
  try {
    writeFileSync(file, [
      observed({ event: "native_tool_diagnostic", diagnosticId: unsafeId, stage: "mcp_ingress",
        requestKind: `${secret}_kind`, requestStructure: `${secret}_structure`,
        failureKind: `${secret}_failure`, requestChars: -1 }),
      observed({ event: "native_tool_diagnostic", diagnosticId: unsafeId,
        stage: `${secret}_stage`, requestKind: "shell", failureKind: "openai_safety_block" }),
      observed({ event: "native_tool_diagnostic", diagnosticId: safeId, stage: "mcp_ingress",
        requestKind: "shell", requestStructure: "single", requestChars: 12,
        failureKind: "openai_safety_block" }),
      observed({ event: "native_tool_diagnostic", diagnosticId: safeId, stage: "broker_queued",
        requestKind: `${secret}_kind`, requestStructure: `${secret}_structure`,
        failureKind: `${secret}_failure` }),
      observed({ event: "native_tool_diagnostic", diagnosticId: safeId, stage: "codex_result_received",
        failureKind: "safety_status_unknown" }),
    ].join("\n"));
    const report = nativeToolDiagnosticReport(file);
    expect(report.requestKinds).toEqual({ shell: 1 });
    expect(report.failureKinds).toEqual({ safety_status_unknown: 1 });
    expect(report.lifecycleStages).toEqual({ mcp_ingress: 2, broker_queued: 1, codex_result_received: 1 });
    expect(report.recentCalls).toEqual([
      { diagnosticId: unsafeId, stages: ["mcp_ingress"], reportedError: false },
      { diagnosticId: safeId, stages: ["mcp_ingress", "broker_queued", "codex_result_received"],
        reportedError: false, requestKind: "shell", requestStructure: "single", requestChars: 12,
        failureKind: "safety_status_unknown" },
    ]);
    expect(JSON.stringify(report)).not.toContain(secret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
