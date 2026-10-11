const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");

// Durable, content-free observations, independent from the launcher's small
// rolling activity log. Maximum retained size is 14 * 4 MiB.
const DAYS_TO_KEEP = 14;
const MAX_DAY_BYTES = 4 * 1024 * 1024;
const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 15;
const lockPause = new Int32Array(new SharedArrayBuffer(4));
const DAY_MS = 86_400_000;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const THREAD = /^[a-f0-9]{16}$/;
const DIAGNOSTIC_ID = /^diag_[a-f0-9]{16}$/;
const TRACE_ID = /^[a-zA-Z0-9_-]{6,128}$/;

const SEMANTIC = {
  semantic_compaction_accepted: "threadHash",
  semantic_turn: "threadHash epoch tier canonicalTokens nextWireTokens estimatedEpochOccupancy occupancyConfidence physicalLimit",
  semantic_rotation: "threadHash fromEpoch toEpoch reason firstMessageTokens firstMessageChars fitsSingleMessage maskedResults maskedTokensEst ledgerFiles ledgerCommands windowSize",
  semantic_skip: "threadHash reason detail",
  semantic_validation_failed: "threadHash reason fellBackTo anchorDetail",
  semantic_reject: "threadHash kind mode effort estimatedMessageTokens messageChars ledgerValue class",
  semantic_fallback: "threadHash to reason",
  semantic_cost: "threadHash epoch checkpointTailRequests checkpointTailTokensEst epochRotations reseedInputTokensEst webCompactionSubmissions extraStageSubmissions maskedResults maskedTokensEst discardedTails legacyEquivalentSubmissions",
};
const ENUMS = {
  anchorDetail: new Set([
    "compaction_boundary_present", "answer_hash_retained", "source_turn_retained", "source_turn_absent",
  ]),
  detail: new Set([
    "manual_interaction", "compaction", "model_mismatch", "model_family_missing",
    "local_tools_disabled", "trusted_environment_missing", "launcher_missing",
    "fresh_conversation", "thread_missing", "missing_turn_provenance",
    "no_completed_turn", "missing_source_revision",
  ]),
  reason: new Set([
    "ineligible", "no_fit", "cooldown", "cap_hit", "outstanding_tools", "cross_boundary", "unknown_occupancy",
    "low_pressure", "model_family_change", "digest_mismatch", "anchor_missing", "schema", "corrupt_store", "operational_unknown",
    "web_compaction_cap_hit", "compaction_view_unavailable", "active_epoch_validation_failed", "quarantined_epoch",
    "retained_epoch_preflight_failed", "rotation_cap_hit_epoch_no_fit", "rotation_cap_hit",
    "rotation_first_message_no_fit", "rotation_cap_changed_before_commit",
    "candidate_projection_failed", "committed_epoch_projection_failed",
    "initial", "physical_pressure", "token_savings", "atomic_result_oversize", "accumulated_occupancy",
  ]),
  fellBackTo: new Set(["legacy", "recovery_error"]),
  kind: new Set(["http_413", "sse_input_too_large"]),
  class: new Set(["A", "B", "C", "D", "unknown"]),
  to: new Set(["legacy", "compaction_required", "recovery_error"]),
  occupancyConfidence: new Set(["known", "reconstructed", "unknown"]),
  stage: new Set([
    "mcp_ingress", "mcp_reply_sent", "mcp_reply_send_failed", "handler_entered", "broker_claimed",
    "handler_result", "handler_failed", "broker_invoke_requested", "broker_invoke_settled",
    "broker_invoke_failed", "broker_queued", "broker_delivered_to_codex_adapter", "broker_redelivered",
    "codex_result_received", "broker_claim_with_turn", "browser_safety_text_visible",
  ]),
  outcome: new Set(["ok", "is_error", "timeout", "aborted", "unclassified_error"]),
  requestKind: new Set(["shell", "patch", "freeform", "structured"]),
  requestStructure: new Set(["single", "multiline", "pipeline", "inline_script", "redirection"]),
  failureKind: new Set(["safety_status_unknown", "openai_safety_block"]),
};
const NULLABLE_NUMBERS = new Set(["ledgerValue", "estimatedEpochOccupancy"]);
const OVERFLOW_FIELDS = "droppedRoutine droppedActionable droppedInvalid";
const ROUTINE_STAGES = new Set([
  "mcp_ingress", "mcp_reply_sent", "handler_entered", "broker_claimed",
  "handler_result", "broker_invoke_requested", "broker_invoke_settled",
  "broker_queued", "broker_delivered_to_codex_adapter", "broker_redelivered",
  "codex_result_received", "broker_claim_with_turn",
]);

function archiveDirectory(filePath) {
  return path.join(path.dirname(filePath), "diagnostic-observations");
}

function safeField(field, value) {
  if (field === "threadHash") return typeof value === "string" && THREAD.test(value) ? value : undefined;
  if (field === "diagnosticId") return typeof value === "string" && DIAGNOSTIC_ID.test(value) ? value : undefined;
  if (field === "traceId") return typeof value === "string" && TRACE_ID.test(value)
    ? /^trace_[a-f0-9]{24}$/.test(value) ? value
      : `trace_${createHash("sha256").update(value).digest("hex").slice(0, 24)}` : undefined;
  if (field === "fitsSingleMessage") return typeof value === "boolean" ? value : undefined;
  if (ENUMS[field]) return ENUMS[field].has(value) ? value : undefined;
  if (field === "mode" || field === "effort") {
    return typeof value === "string" && /^(?:gpt-6-sol|gpt-6-luna|instant|medium|high|xhigh|extra_high|low|none|unknown)$/.test(value)
      ? value : undefined;
  }
  if (field === "tool") return [
    "codex_exec", "codex_write_stdin", "codex_apply_patch", "codex_view_image",
    "codex_tool_inventory", "codex_tool_call", "unknown",
  ].includes(value) ? value : undefined;
  if (NULLABLE_NUMBERS.has(field) && value === null) return null;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeObservation(record) {
  if (!record || typeof record !== "object" || typeof record.at !== "string") return undefined;
  const timestamp = Date.parse(record.at);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== record.at) return undefined;
  let payload;
  if (Object.hasOwn(SEMANTIC, record.event) || record.event === "native_tool_diagnostic"
    || record.event === "diagnostic_archive_overflow") {
    payload = { event: record.event, ...record.detail };
  } else if (/^runtime\.[a-z_]+_(?:stdout|stderr)$/.test(record.event)
    || record.event === "runtime.stdout" || record.event === "runtime.stderr") {
    const line = record.detail?.line;
    if (typeof line !== "string" || line.length > 16 * 1024) return undefined;
    try { payload = JSON.parse(line); } catch { return undefined; }
  } else return undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const fields = payload.event === "native_tool_diagnostic"
    ? "stage diagnosticId traceId tool outcome elapsedMs requestKind requestStructure requestChars requestArgCount failureKind"
    : payload.event === "diagnostic_archive_overflow" ? OVERFLOW_FIELDS : SEMANTIC[payload.event];
  if (!fields) return undefined;
  const detail = {};
  for (const field of fields.split(" ")) {
    const safe = safeField(field, payload[field]);
    if (safe !== undefined) detail[field] = safe;
  }
  if (payload.event === "native_tool_diagnostic" ? !detail.stage
    : payload.event === "diagnostic_archive_overflow" ? !Object.hasOwn(detail, "droppedRoutine")
      : !detail.threadHash) return undefined;
  // Preserve the existing report scripts' expected nested JSON-line format.
  return {
    at: record.at, level: "info", event: "diagnostic_observation",
    detail: { line: JSON.stringify({ event: payload.event, ...detail }) },
  };
}

function routineObservation(observation) {
  const payload = JSON.parse(observation.detail.line);
  if (payload.event === "semantic_turn" || payload.event === "semantic_cost") return true;
  if (payload.event === "semantic_skip") {
    return ["low_pressure", "cooldown", "ineligible"].includes(payload.reason);
  }
  return payload.event === "native_tool_diagnostic" && ROUTINE_STAGES.has(payload.stage)
    && (payload.outcome === undefined || payload.outcome === "ok");
}

/** Reclaim a saturated legacy day in place. Preserve recent actionable events,
 * aggregate evictions, and leave half the daily budget available for new events.
 * The replacement is atomic; a failed compaction leaves the old archive intact. */
function compactDay(destination, at, incomingBytes) {
  const old = fs.readFileSync(destination, "utf8");
  const actionable = [];
  const routine = [];
  const dropped = { droppedRoutine: 0, droppedActionable: 0, droppedInvalid: 0 };
  for (const line of old.split(/\r?\n/)) {
    if (!line) continue;
    let stored;
    try { stored = JSON.parse(line); } catch { dropped.droppedInvalid += 1; continue; }
    if (stored?.event !== "diagnostic_observation") { dropped.droppedInvalid += 1; continue; }
    const normalized = safeObservation({
      at: stored.at, event: "runtime.daemon_stdout", detail: { line: stored.detail?.line },
    });
    if (!normalized) { dropped.droppedInvalid += 1; continue; }
    const payload = JSON.parse(normalized.detail.line);
    if (payload.event === "diagnostic_archive_overflow") {
      for (const field of OVERFLOW_FIELDS.split(" ")) dropped[field] += payload[field] ?? 0;
      continue;
    }
    const item = { line: `${JSON.stringify(normalized)}\n`, index: actionable.length + routine.length };
    (routineObservation(normalized) ? routine : actionable).push(item);
  }
  const summaryAt = at;
  const summary = () => `${JSON.stringify(safeObservation({
    at: summaryAt, event: "diagnostic_archive_overflow", detail: dropped,
  }))}\n`;
  let remaining = Math.floor(MAX_DAY_BYTES / 2) - incomingBytes - 512;
  const retained = [];
  // Keep newest high-value records first, then a small sample of routine records.
  for (const group of [actionable, routine.slice(-32)]) {
    for (let index = group.length - 1; index >= 0; index -= 1) {
      const item = group[index];
      if (Buffer.byteLength(item.line) > remaining) continue;
      retained.push(item);
      remaining -= Buffer.byteLength(item.line);
    }
  }
  const saved = new Set(retained);
  dropped.droppedActionable += actionable.filter(item => !saved.has(item)).length;
  dropped.droppedRoutine += routine.filter(item => !saved.has(item)).length;
  retained.sort((a, b) => a.index - b.index);
  const content = retained.map(item => item.line).join("") + summary();
  if (Buffer.byteLength(content) + incomingBytes > MAX_DAY_BYTES) return false;
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return true;
}

function observationPaths(filePath, now = Date.now()) {
  const folder = archiveDirectory(filePath);
  const since = new Date(now - (DAYS_TO_KEEP - 1) * DAY_MS).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  let names;
  try { names = fs.readdirSync(folder); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.filter(name => DAY_FILE.test(name) && name.slice(0, 10) >= since
    && name.slice(0, 10) <= today).sort().map(name => path.join(folder, name));
}

// Serialize the whole stat -> compact/rename -> append transaction between
// launcher processes. A lock is scoped to one UTC day, and acquisition is
// bounded so diagnostics cannot indefinitely hold up normal launcher logging.
function withDayLock(destination, action) {
  const lockPath = `${destination}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, String(process.pid));
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        fs.rmSync(lockPath, { force: true });
      }
      if (error.code !== "EEXIST") throw error;
      // Recover a crashed owner's lock only after it has become stale.
      // A live writer is never preempted, even if the wall clock jumps.
      try {
        const info = fs.lstatSync(lockPath);
        if (info.isFile() && info.nlink === 1 && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          const owner = fs.readFileSync(lockPath, "utf8");
          const pid = /^(?:[1-9]\d*)$/.test(owner) ? Number(owner) : undefined;
          let dead = pid === undefined;
          if (pid !== undefined) {
            try { process.kill(pid, 0); }
            catch (cause) { dead = cause.code === "ESRCH"; }
          }
          if (dead && fs.lstatSync(lockPath).ino === info.ino) fs.rmSync(lockPath, { force: true });
        }
      } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
      }
      if (Date.now() >= deadline) return false;
      Atomics.wait(lockPause, 0, 0, LOCK_POLL_MS);
    }
  }
  try { return action(); }
  finally {
    fs.closeSync(descriptor);
    fs.rmSync(lockPath, { force: true });
  }
}

function appendObservation(filePath, record, now = Date.now()) {
  const safe = safeObservation(record);
  if (!safe) return false;
  const date = safe.at.slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  const since = new Date(now - (DAYS_TO_KEEP - 1) * DAY_MS).toISOString().slice(0, 10);
  if (date < since || date > today) return false;
  const folder = archiveDirectory(filePath);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(folder)) {
    if (DAY_FILE.test(name) && name.slice(0, 10) < since) fs.rmSync(path.join(folder, name), { force: true });
  }
  const destination = path.join(folder, `${date}.jsonl`);
  const line = `${JSON.stringify(safe)}\n`;
  const incomingBytes = Buffer.byteLength(line);
  if (incomingBytes > MAX_DAY_BYTES) return false;
  return withDayLock(destination, () => {
    const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.nlink > 1)) return false;
    const size = existing?.size ?? 0;
    if (size + incomingBytes > MAX_DAY_BYTES) {
      if (!existing || !compactDay(destination, safe.at, incomingBytes)) return false;
    }
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
      | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(destination, flags, 0o600);
    try { fs.writeFileSync(fd, line); } finally { fs.closeSync(fd); }
    return true;
  });
}

function readObservations(filePath, now = Date.now()) {
  const observations = [];
  for (const source of observationPaths(filePath, now)) {
    for (const line of fs.readFileSync(source, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      try {
        const stored = JSON.parse(line);
        if (stored?.event !== "diagnostic_observation") continue;
        const safe = safeObservation({
          at: stored.at, event: "runtime.daemon_stdout", detail: { line: stored.detail?.line },
        });
        if (safe) observations.push(safe);
      } catch { /* A partially written observation must not prevent export. */ }
    }
  }
  return observations;
}

module.exports = { appendObservation, archiveDirectory, observationPaths, readObservations, safeObservation };
