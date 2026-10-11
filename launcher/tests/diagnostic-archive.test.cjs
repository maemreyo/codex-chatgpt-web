const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
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
  assert.deepEqual(JSON.parse(safeObservation(wrapped(semantic("semantic_validation_failed", {
    reason: "operational_unknown", fellBackTo: "legacy", error: secret,
  }))).detail.line), {
    event: "semantic_validation_failed", threadHash, reason: "operational_unknown", fellBackTo: "legacy",
  });
  assert.deepEqual(JSON.parse(safeObservation(wrapped(semantic("semantic_compaction_accepted", {
    prompt: secret, source: secret,
  }))).detail.line), { event: "semantic_compaction_accepted", threadHash });
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
  for (const reason of ["unknown_occupancy", "atomic_result_oversize", "accumulated_occupancy", "quarantined_epoch"]) {
    const safe = safeObservation(wrapped(semantic("semantic_fallback", {
      to: "compaction_required", reason, prompt: secret, toolResult: secret,
    })));
    assert.deepEqual(JSON.parse(safe.detail.line), {
      event: "semantic_fallback", threadHash, to: "compaction_required", reason,
    });
  }
  const unsafe = safeObservation(wrapped(semantic("semantic_fallback", {
    to: "compaction_required", reason: secret, prompt: secret,
  })));
  assert.deepEqual(JSON.parse(unsafe.detail.line), {
    event: "semantic_fallback", threadHash, to: "compaction_required",
  });
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
  assert.equal(appendObservation(filePath, record("2026-10-08"), atMs), true);
  assert.equal(readObservations(filePath, atMs).length, 4);
  assert.ok(fs.statSync(file).size <= 4 * 1024 * 1024);
}));

test("legacy 2026 archive saturated at 4,194,287 bytes retains later failures and SEM acceptance", () => scratch(filePath => {
  const now = Date.parse("2026-10-11T16:30:00.000Z");
  const date = "2026-10-11T16:00:00.000Z";
  const folder = archiveDirectory(filePath);
  fs.mkdirSync(folder, { recursive: true });
  const destination = path.join(folder, "2026-10-11.jsonl");
  const encoded = line => `${JSON.stringify(safeObservation(wrapped(line, date)))}\n`;
  const rotation = encoded(semantic("semantic_rotation", {
    fromEpoch: 1, toEpoch: 2, reason: "physical_pressure",
  }));
  const ingress = encoded(JSON.stringify({
    event: "native_tool_diagnostic", stage: "mcp_ingress", diagnosticId: "diag_0123456789abcdef",
    requestKind: "shell", command: "PRIVATE_COMMAND_AND_TOKEN",
  }));
  const target = 4_194_287;
  const repeats = Math.floor((target - Buffer.byteLength(rotation)) / Buffer.byteLength(ingress));
  const padding = target - Buffer.byteLength(rotation) - repeats * Buffer.byteLength(ingress);
  const legacy = rotation + ingress.repeat(repeats - 1)
    + ingress.trimEnd().padEnd(ingress.length + padding - 1, " ") + "\n";
  assert.equal(Buffer.byteLength(legacy), target);
  fs.writeFileSync(destination, legacy);

  const after = [
    semantic("semantic_validation_failed", { reason: "operational_unknown",
      fellBackTo: "legacy", error: "SECRET_ERROR" }),
    semantic("semantic_validation_failed", { reason: "anchor_missing", anchorDetail: "compaction_boundary_present",
      fellBackTo: "legacy", error: "SECRET_ERROR" }),
    semantic("semantic_compaction_accepted", { prompt: "SECRET_PROMPT" }),
    JSON.stringify({
      event: "native_tool_diagnostic", stage: "handler_failed", outcome: "unclassified_error",
      diagnosticId: "diag_ffffffffffffffff", error: "SECRET_ERROR",
    }),
  ];
  for (const line of after) {
    assert.equal(appendObservation(filePath, wrapped(line, date), now), true);
    assert.ok(fs.statSync(destination).size <= 4 * 1024 * 1024);
  }
  const archived = readObservations(filePath, now).map(item => JSON.parse(item.detail.line));
  const overflow = archived.find(item => item.event === "diagnostic_archive_overflow");
  assert.ok(overflow.droppedRoutine > 0);
  assert.equal(overflow.droppedActionable, 0);
  assert.ok(archived.some(item => item.event === "semantic_rotation" && item.reason === "physical_pressure"));
  assert.ok(archived.some(item => item.event === "semantic_validation_failed"
    && item.reason === "operational_unknown"));
  assert.ok(archived.some(item => item.event === "semantic_validation_failed"
    && item.reason === "anchor_missing" && item.anchorDetail === "compaction_boundary_present"));
  assert.ok(archived.some(item => item.event === "semantic_compaction_accepted"));
  assert.ok(archived.some(item => item.event === "native_tool_diagnostic" && item.stage === "handler_failed"));
  assert.doesNotMatch(JSON.stringify(archived), /SECRET_|PRIVATE_/);
  assert.ok(fs.statSync(destination).size < target);
}));

test("simultaneous launcher processes append after legacy saturation without losing actionable records", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-archive-concurrent-"));
  const filePath = path.join(root, "launcher.jsonl");
  const folder = archiveDirectory(filePath);
  const destination = path.join(folder, "2026-10-11.jsonl");
  const barrier = path.join(root, "start");
  const date = "2026-10-11T16:00:00.000Z";
  const now = Date.parse("2026-10-11T16:30:00.000Z");
  const workers = 8;
  const perWorker = 7;
  try {
    fs.mkdirSync(folder, { recursive: true });
    const routine = `${JSON.stringify(safeObservation(wrapped(JSON.stringify({
      event: "native_tool_diagnostic", stage: "mcp_ingress",
      diagnosticId: "diag_0123456789abcdef",
    }), date)))}\n`;
    const rotation = `${JSON.stringify(safeObservation(wrapped(semantic("semantic_rotation", {
      fromEpoch: 1, toEpoch: 2, reason: "physical_pressure",
    }), date)))}\n`;
    const target = 4_194_287;
    const count = Math.floor((target - Buffer.byteLength(rotation)) / Buffer.byteLength(routine));
    const padding = target - Buffer.byteLength(rotation) - count * Buffer.byteLength(routine);
    fs.writeFileSync(destination, rotation + routine.repeat(count - 1)
      + routine.trimEnd().padEnd(routine.length + padding - 1, " ") + "\n");
    assert.equal(fs.statSync(destination).size, target);

    const workerSource = [
      'const fs = require("node:fs");',
      'const { appendObservation } = require(process.argv[1]);',
      'const [filePath, barrier, worker, count, date] = process.argv.slice(2);',
      'const gate = new Int32Array(new SharedArrayBuffer(4));',
      'const deadline = Date.now() + 5_000;',
      'while (!fs.existsSync(barrier) && Date.now() < deadline) Atomics.wait(gate, 0, 0, 5);',
      'if (!fs.existsSync(barrier)) process.exit(2);',
      'for (let i = 0; i < Number(count); i++) {',
      '  const diagnosticId = "diag_" + (Number(worker) * 100 + i).toString(16).padStart(16, "0");',
      '  const line = JSON.stringify({ event: "native_tool_diagnostic", stage: "handler_failed",',
      '    diagnosticId, outcome: "unclassified_error", error: "PRIVATE_ERROR" });',
      '  const record = { at: date, event: "runtime.daemon_stderr", detail: { line } };',
      '  if (!appendObservation(filePath, record, Date.parse(date) + 30_000)) process.exit(3);',
      '}',
    ].join("\n");
    const modulePath = require.resolve("../electron/diagnostic-archive.cjs");
    const processes = Array.from({ length: workers }, (_, worker) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", workerSource, modulePath, filePath,
        barrier, String(worker), String(perWorker), date], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += String(chunk).slice(0, 1024); });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ worker, code, signal, stderr }));
    }));
    fs.writeFileSync(barrier, "go");
    const outcomes = await Promise.all(processes);
    assert.ok(outcomes.every(result => result.code === 0), JSON.stringify(outcomes));

    const observations = readObservations(filePath, now).map(record => JSON.parse(record.detail.line));
    const recorded = observations.filter(record => record.event === "native_tool_diagnostic"
      && record.stage === "handler_failed").map(record => record.diagnosticId);
    const expected = Array.from({ length: workers }, (_, worker) => Array.from(
      { length: perWorker }, (_, index) => `diag_${(worker * 100 + index).toString(16).padStart(16, "0")}`,
    )).flat();
    assert.equal(recorded.length, expected.length);
    assert.deepEqual(new Set(recorded), new Set(expected));
    assert.ok(observations.some(record => record.event === "semantic_rotation"));
    assert.ok(observations.some(record => record.event === "diagnostic_archive_overflow"
      && record.droppedRoutine > 0));
    assert.ok(fs.statSync(destination).size <= 4 * 1024 * 1024);
    assert.equal(fs.existsSync(`${destination}.lock`), false);
    assert.doesNotMatch(fs.readFileSync(destination, "utf8"), /PRIVATE_ERROR/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unavailable archive never blocks ordinary launcher logging", () => scratch(filePath => {
  fs.writeFileSync(archiveDirectory(filePath), "occupied");
  const logger = createLogger({ filePath });
  logger.info("runtime.daemon_stdout", { line: semantic("semantic_turn", { epoch: 1 }) });
  assert.equal(logger.recent().length, 1);
  assert.equal(fs.readFileSync(filePath, "utf8").trim().length > 0, true);
}));
