const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLogger, exportSanitizedLogs } = require("../electron/logging.cjs");
const {
  appendObservation, archiveDirectory, observationPaths, readObservations, safeObservation,
} = require("../electron/diagnostic-archive.cjs");

const threadHash = "0123456789abcdef";
const at = new Date().toISOString();
const atMs = Date.parse("2026-10-08T10:00:00.000Z");
const semantic = (event, details = {}) => JSON.stringify({ event, threadHash, ...details });
const wrapped = (line, when = at) => ({
  at: when, level: "info", event: "runtime.daemon_stdout", detail: { line },
});
const scratch = run => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-diagnostic-archive-"));
  try { return run(path.join(root, "launcher.jsonl")); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
};

test("archive accepts only a bounded allowlist of content-free semantic and tool observations", () => {
  const secret = "SECRET_PRIVATE_PROMPT_123";
  const event = safeObservation(wrapped(semantic("semantic_reject", {
    class: "D", kind: "http_413", mode: secret, effort: "high",
    messageChars: 999, reason: secret, command: secret, prompt: secret,
  })));
  assert.equal(event.event, "diagnostic_observation");
  assert.deepEqual(JSON.parse(event.detail.line), {
    event: "semantic_reject", threadHash, kind: "http_413", effort: "high",
    messageChars: 999, class: "D",
  });
  const cut = safeObservation(wrapped(semantic("semantic_skip", {
    reason: "cross_boundary", prompt: secret,
  })));
  assert.deepEqual(JSON.parse(cut.detail.line), {
    event: "semantic_skip", threadHash, reason: "cross_boundary",
  });
  assert.deepEqual(JSON.parse(safeObservation(wrapped(semantic("semantic_validation_failed", {
    reason: "cross_boundary", fellBackTo: "legacy",
  }))).detail.line), {
    event: "semantic_validation_failed", threadHash, reason: "cross_boundary", fellBackTo: "legacy",
  });
  const skip = safeObservation(wrapped(semantic("semantic_skip", {
    reason: "ineligible", detail: "missing_turn_provenance", prompt: secret,
  })));
  assert.deepEqual(JSON.parse(skip.detail.line), {
    event: "semantic_skip", threadHash, reason: "ineligible", detail: "missing_turn_provenance",
  });
  const unsafeSkip = safeObservation(wrapped(semantic("semantic_skip", {
    reason: "ineligible", detail: secret,
  })));
  assert.deepEqual(JSON.parse(unsafeSkip.detail.line), {
    event: "semantic_skip", threadHash, reason: "ineligible",
  });
  for (const reason of ["no_fit", "cooldown", "low_pressure"]) {
    const preserved = safeObservation(wrapped(semantic("semantic_skip", { reason })));
    assert.equal(JSON.parse(preserved.detail.line).reason, reason);
  }
  for (const reason of ["initial", "physical_pressure", "token_savings"]) {
    for (const fitsSingleMessage of [true, false]) {
      const rotation = safeObservation(wrapped(semantic("semantic_rotation", {
        fromEpoch: 1, toEpoch: 2, reason, fitsSingleMessage,
        prompt: secret, command: secret,
      })));
      assert.deepEqual(JSON.parse(rotation.detail.line), {
        event: "semantic_rotation", threadHash, fromEpoch: 1, toEpoch: 2,
        reason, fitsSingleMessage,
      });
    }
  }
  const fallback = safeObservation(wrapped(semantic("semantic_fallback", {
    to: "legacy", reason: "active_epoch_validation_failed",
  })));
  assert.equal(JSON.parse(fallback.detail.line).reason, "active_epoch_validation_failed");
  const tool = safeObservation(wrapped(JSON.stringify({
    event: "native_tool_diagnostic", stage: "broker_queued", diagnosticId: "diag_0123456789abcdef",
    traceId: "trace_0123456789abcdef", outcome: "is_error", elapsedMs: 12,
    requestKind: "shell", requestStructure: "inline_script", requestChars: 45, requestArgCount: 2,
    failureKind: "safety_status_unknown",
    tool: secret, result: secret, arguments: { key: secret },
  })));
  const toolFields = JSON.parse(tool.detail.line);
  assert.match(toolFields.traceId, /^trace_[a-f0-9]{24}$/);
  delete toolFields.traceId;
  assert.deepEqual(toolFields, {
    event: "native_tool_diagnostic", stage: "broker_queued", diagnosticId: "diag_0123456789abcdef",
    outcome: "is_error", elapsedMs: 12,
    requestKind: "shell", requestStructure: "inline_script", requestChars: 45, requestArgCount: 2,
    failureKind: "safety_status_unknown",
  });
  const invalid = safeObservation(wrapped(JSON.stringify({
    event: "native_tool_diagnostic", stage: "mcp_ingress", diagnosticId: "diag_0123456789abcdef",
    requestKind: secret, requestStructure: secret, failureKind: secret, requestChars: secret,
  })));
  assert.deepEqual(JSON.parse(invalid.detail.line), {
    event: "native_tool_diagnostic", stage: "mcp_ingress", diagnosticId: "diag_0123456789abcdef",
  });
  assert.doesNotMatch(JSON.stringify([event, tool]), /SECRET_PRIVATE_PROMPT/);
  assert.equal(safeObservation(wrapped(semantic("semantic_reject", { class: "D" }).replace(threadHash, secret))), undefined);
  assert.equal(safeObservation(wrapped(JSON.stringify({ event: "unknown_log", threadHash }))), undefined);
  assert.equal(safeObservation(wrapped(JSON.stringify({ event: "native_tool_diagnostic", stage: secret }))), undefined);
});

test("launcher automatically archives diagnostics through raw-log rotations and exports each only once", () => scratch(filePath => {
  const logger = createLogger({ filePath });
  const rotation = semantic("semantic_rotation", {
    fromEpoch: 1, toEpoch: 2, reason: "physical_pressure",
    fitsSingleMessage: false, maskedTokensEst: 300,
  });
  const reject = semantic("semantic_reject", { class: "D", kind: "http_413" });
  const tool = JSON.stringify({
    event: "native_tool_diagnostic", stage: "mcp_ingress", diagnosticId: "diag_0123456789abcdef",
    traceId: "trace_0123456789abcdef", details: "SECRET_PRIVATE_PROMPT_123",
  });
  logger.info("runtime.daemon_stdout", { line: rotation });
  logger.info("runtime.daemon_stdout", { line: reject });
  logger.info("runtime.daemon_stderr", { line: tool });
  const archiveDir = archiveDirectory(filePath);
  assert.equal(fs.readdirSync(archiveDir).length, 1);
  const archived = readObservations(filePath);
  assert.equal(archived.length, 3);
  assert.equal(JSON.parse(archived[0].detail.line).reason, "physical_pressure");
  assert.equal(JSON.parse(archived[0].detail.line).fitsSingleMessage, false);
  const destination = path.join(path.dirname(filePath), "export.jsonl");
  assert.equal(exportSanitizedLogs({ filePath, destinationPath: destination }), 3);
  let rows = fs.readFileSync(destination, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map(row => JSON.parse(row.detail.line).event), [
    "semantic_rotation", "semantic_reject", "native_tool_diagnostic",
  ]);
  assert.equal(JSON.parse(rows[0].detail.line).reason, "physical_pressure");
  assert.equal(JSON.parse(rows[0].detail.line).fitsSingleMessage, false);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET_PRIVATE_PROMPT/);
  // Raw activity is short-lived, but the archive retains metadata after it rolls away.
  fs.writeFileSync(`${filePath}.1`, `${JSON.stringify({ at, level: "info", event: "other", detail: {} })}\n`);
  fs.writeFileSync(filePath, "");
  assert.equal(exportSanitizedLogs({ filePath, destinationPath: destination }), 4);
  rows = fs.readFileSync(destination, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.filter(row => row.event === "diagnostic_observation").length, 3);
  assert.throws(() => exportSanitizedLogs({
    filePath, destinationPath: path.join(archiveDir, fs.readdirSync(archiveDir)[0]),
  }), /Refusing to overwrite a launcher source log/);
}));

test("observation archive bounds each day to 4 MiB and keeps only the most recent 14 days", () => scratch(filePath => {
  const record = (date) => wrapped(semantic("semantic_turn", {
    epoch: 1, tier: 0, canonicalTokens: 99,
  }), `${date}T10:00:00.000Z`);
  fs.mkdirSync(archiveDirectory(filePath), { recursive: true });
  const old = path.join(archiveDirectory(filePath), "2026-09-23.jsonl");
  fs.writeFileSync(old, "old");
  assert.equal(appendObservation(filePath, record("2026-09-25"), atMs), true);
  assert.equal(appendObservation(filePath, record("2026-10-08"), atMs), true);
  assert.equal(fs.existsSync(old), false);
  assert.equal(readObservations(filePath, atMs).length, 2);
  const file = observationPaths(filePath, atMs).at(-1);
  fs.appendFileSync(file, "x".repeat(4 * 1024 * 1024));
  assert.equal(appendObservation(filePath, record("2026-10-08"), atMs), false);
  assert.equal(readObservations(filePath, atMs).length, 2);
}));

test("unavailable archive never blocks ordinary launcher logging", () => scratch(filePath => {
  fs.writeFileSync(archiveDirectory(filePath), "occupied");
  const logger = createLogger({ filePath });
  logger.info("runtime.daemon_stdout", { line: semantic("semantic_turn", { epoch: 1 }) });
  assert.equal(logger.recent().length, 1);
  assert.equal(fs.readFileSync(filePath, "utf8").trim().length > 0, true);
}));
