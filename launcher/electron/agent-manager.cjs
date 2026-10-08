const { spawn } = require("node:child_process");

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const ALL_ROLES = ["zam-explorer", "zam-researcher", "zam-builder", "zam-reviewer"];

// Run the same bundled native configuration implementation used by the CLI.
// Commands are argument vectors, with no shell interpolation or raw TOML in the renderer.
function invokeAgentRuntime(runtimeCommand, codexHome, action, input) {
  const serialized = input === undefined ? null : JSON.stringify(input);
  if (serialized !== null && Buffer.byteLength(serialized) > MAX_INPUT_BYTES) {
    return Promise.reject(new Error("Agent configuration request is too large"));
  }
  let invocation;
  try { invocation = runtimeCommand(["agents", action, "--codex-home", codexHome]); }
  catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "", stderr = "", length = 0, settled = false;
    const end = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      end(new Error("Agent configuration command timed out"));
    }, 30_000);
    child.stdout.on("data", chunk => {
      length += chunk.byteLength;
      if (length > MAX_OUTPUT_BYTES) { child.kill(); end(new Error("Agent configuration output exceeds the limit")); }
      else stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", chunk => {
      length += chunk.byteLength;
      if (length > MAX_OUTPUT_BYTES) { child.kill(); end(new Error("Agent configuration output exceeds the limit")); }
      else stderr += chunk.toString("utf8");
    });
    child.once("error", error => end(error));
    child.once("close", code => {
      if (settled) return;
      if (code !== 0) {
        // Runtime errors are designed to contain sanitized error messages; never
        // expose a raw config dump or credentials to renderer/UI logging.
        const message = stderr.trim().replace(/^codex-chatgpt-web:\s*/, "");
        end(new Error(message.slice(0, 500) || "Native agent configuration command failed"));
        return;
      }
      try { end(null, JSON.parse(stdout)); }
      catch { end(new Error("Native agent configuration returned invalid JSON")); }
    });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") end(error); });
    child.stdin.end(serialized ?? "");
  });
}

function createAgentManager({ runtimeCommand, codexHome, now = Date.now }) {
  if (typeof runtimeCommand !== "function" || typeof codexHome !== "string") {
    throw new Error("Native agent manager requires a runtime and selected Codex profile");
  }
  const previews = new Map();
  const invoke = (action, value) => invokeAgentRuntime(runtimeCommand, codexHome, action, value);
  function trimPreviews() {
    for (const [id, record] of previews) if (now() - record.createdAt > PREVIEW_TTL_MS) previews.delete(id);
    while (previews.size > 8) previews.delete(previews.keys().next().value);
  }
  return {
    async inspect() {
      const data = await invoke("inspect");
      return {
        codexHome: data.codexHome,
        maxConcurrentThreads: data.maxConcurrentThreadsPerSession,
        roles: data.roles.map(role => ({
          name: role.name, scope: "global", model: role.model ?? "—",
          reasoningEffort: role.reasoningEffort, configPath: role.configFile ?? "—",
          managed: role.status === "managed", status: role.status,
        })),
        warnings: [
          ...(data.configStatus === "externally-changed" ? ["Native config was edited outside Zam; preview before applying."] : []),
          ...(data.whitelistEnforcement === "unverified" ? ["Native whitelist and sandbox enforcement are not verified by this inspection."] : []),
        ],
        pendingRecovery: data.pendingRecovery,
      };
    },
    async preview(request) {
      if (!request || !["balanced", "parallel"].includes(request.preset)
        || !Number.isInteger(request.maxConcurrentThreads) || request.maxConcurrentThreads < 1 || request.maxConcurrentThreads > 8
        || typeof request.enrollMissingRoles !== "boolean") {
        throw new Error("Unsupported agent preset or child-thread count");
      }
      const nativeRequest = { maxConcurrentThreadsPerSession: request.maxConcurrentThreads };
      if (request.enrollMissingRoles) {
        const inspection = await invoke("inspect");
        nativeRequest.roles = Object.fromEntries(ALL_ROLES.filter(name =>
          inspection.roles.some(role => role.name === name && !role.registered)
        ).map(name => [name, { enabled: true }]));
      }
      const full = await invoke("preview", nativeRequest);
      trimPreviews();
      previews.set(full.id, { full, createdAt: now() });
      return {
        id: full.id, preset: request.preset, maxConcurrentThreads: request.maxConcurrentThreads,
        changes: full.changes.map(change => ({ path: change.path, operation: change.operation, changedKeys: change.changedKeys })),
        warnings: full.warnings, requiresRestart: full.activation === "new-session-required",
      };
    },
    async apply(id) {
      if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid agent preview ID");
      trimPreviews();
      const record = previews.get(id);
      if (!record) throw new Error("Agent preview is missing or expired; refresh it before applying");
      previews.delete(id);
      const result = await invoke("apply", record.full);
      return { applied: result.applied, changedFiles: result.changedFiles.length,
        requiresRestart: result.activation === "new-session-required" && result.applied };
    },
    async recover() {
      previews.clear();
      return invoke("recover");
    },
  };
}

module.exports = { createAgentManager, invokeAgentRuntime };
