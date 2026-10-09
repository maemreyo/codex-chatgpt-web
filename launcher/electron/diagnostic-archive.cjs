const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

// Durable, content-free observations, independent from the launcher's small
// rolling activity log. Maximum retained size is 14 * 4 MiB.
const DAYS_TO_KEEP = 14;
const MAX_DAY_BYTES = 4 * 1024 * 1024;
const DAY_MS = 86_400_000;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const THREAD = /^[a-f0-9]{16}$/;
const DIAGNOSTIC_ID = /^diag_[a-f0-9]{16}$/;
const TRACE_ID = /^[a-zA-Z0-9_-]{6,128}$/;

const SEMANTIC = {
  semantic_turn: "threadHash epoch tier canonicalTokens nextWireTokens estimatedEpochOccupancy occupancyConfidence physicalLimit",
  semantic_rotation: "threadHash fromEpoch toEpoch reason firstMessageTokens firstMessageChars fitsSingleMessage maskedResults maskedTokensEst ledgerFiles ledgerCommands windowSize",
  semantic_skip: "threadHash reason detail",
  semantic_validation_failed: "threadHash reason fellBackTo",
  semantic_reject: "threadHash kind mode effort estimatedMessageTokens messageChars ledgerValue class",
  semantic_fallback: "threadHash to reason",
  semantic_cost: "threadHash epoch checkpointTailRequests checkpointTailTokensEst epochRotations reseedInputTokensEst webCompactionSubmissions extraStageSubmissions maskedResults maskedTokensEst discardedTails legacyEquivalentSubmissions",
};
const ENUMS = {
  detail: new Set([
    "manual_interaction", "compaction", "model_mismatch", "model_family_missing",
    "local_tools_disabled", "trusted_environment_missing", "launcher_missing",
    "fresh_conversation", "thread_missing", "missing_turn_provenance",
    "no_completed_turn", "missing_source_revision",
  ]),
  reason: new Set([
    "ineligible", "no_fit", "cooldown", "cap_hit", "outstanding_tools", "unknown_occupancy",
    "low_pressure", "model_family_change", "digest_mismatch", "anchor_missing", "schema", "corrupt_store",
    "web_compaction_cap_hit", "compaction_view_unavailable", "active_epoch_validation_failed",
    "retained_epoch_preflight_failed", "rotation_cap_hit_epoch_no_fit", "rotation_cap_hit",
    "rotation_first_message_no_fit", "rotation_cap_changed_before_commit",
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

function archiveDirectory(filePath) {
  return path.join(path.dirname(filePath), "diagnostic-observations");
}

function safeField(field, value) {
  if (field === "threadHash") return typeof value === "string" && THREAD.test(value) ? value : undefined;
  if (field === "diagnosticId") return typeof value === "string" && DIAGNOSTIC_ID.test(value) ? value : undefined;
  if (field === "traceId") return typeof value === "string" && TRACE_ID.test(value)
    ? /^trace_[a-f0-9]{24}$/.test(value) ? value
      : `trace_${createHash("sha256").update(value).digest("hex").slice(0, 24)}` : undefined;
  if (field === "fitsSingleMessage") return value === true ? true : undefined;
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
  if (Object.hasOwn(SEMANTIC, record.event) || record.event === "native_tool_diagnostic") {
    payload = { event: record.event, ...record.detail };
  } else if (/^runtime\.[a-z_]+_(?:stdout|stderr)$/.test(record.event)
    || record.event === "runtime.stdout" || record.event === "runtime.stderr") {
    const line = record.detail?.line;
    if (typeof line !== "string" || line.length > 16 * 1024) return undefined;
    try { payload = JSON.parse(line); } catch { return undefined; }
  } else return undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const fields = payload.event === "native_tool_diagnostic"
    ? "stage diagnosticId traceId tool outcome elapsedMs requestKind requestStructure requestChars requestArgCount failureKind" : SEMANTIC[payload.event];
  if (!fields) return undefined;
  const detail = {};
  for (const field of fields.split(" ")) {
    const safe = safeField(field, payload[field]);
    if (safe !== undefined) detail[field] = safe;
  }
  if (payload.event === "native_tool_diagnostic" ? !detail.stage : !detail.threadHash) return undefined;
  // Preserve the existing report scripts' expected nested JSON-line format.
  return {
    at: record.at, level: "info", event: "diagnostic_observation",
    detail: { line: JSON.stringify({ event: payload.event, ...detail }) },
  };
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
  const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.nlink > 1)) return false;
  const size = existing?.size ?? 0;
  if (size + Buffer.byteLength(line) > MAX_DAY_BYTES) return false;
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
    | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(destination, flags, 0o600);
  try { fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
  return true;
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
