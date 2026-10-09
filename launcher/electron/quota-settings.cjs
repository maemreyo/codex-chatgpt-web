const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const DEFAULT_POLICY = Object.freeze({
  mode: "strict",
  fiveHourReservePercent: 5,
  weeklyReservePercent: 3,
  fiveHourAdmissionPercent: 20,
  weeklyAdmissionPercent: 10,
});
const POLICY_KEYS = Object.keys(DEFAULT_POLICY);
const activeSaves = new WeakSet();

function validatePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !POLICY_KEYS.includes(key))) {
    throw new Error("Invalid native quota policy");
  }
  const policy = { ...DEFAULT_POLICY, ...value };
  if (policy.mode !== "strict" && policy.mode !== "conservative") {
    throw new Error("Native quota mode must be strict or conservative");
  }
  for (const key of POLICY_KEYS.filter(key => key !== "mode")) {
    if (typeof policy[key] !== "number" || !Number.isFinite(policy[key])
      || policy[key] < 0 || policy[key] > 100) {
      throw new Error(`Native quota ${key} must be between 0 and 100`);
    }
  }
  if (policy.fiveHourAdmissionPercent <= policy.fiveHourReservePercent
    || policy.weeklyAdmissionPercent <= policy.weeklyReservePercent) {
    throw new Error("Admission thresholds must exceed their corresponding reserve targets");
  }
  return policy;
}

function readQuotaSettings(supervisor) {
  const config = supervisor.readConfig();
  if (!config || typeof config !== "object") throw new Error("Configure the bridge before editing quota reserve");
  return {
    enabled: config.nativeQuotaReserveEnabled === true,
    policy: validatePolicy(config.nativeQuotaReserve ?? {}),
  };
}

async function setQuotaSettings(supervisor, request) {
  if (activeSaves.has(supervisor)) throw new Error("A native quota settings update is already in progress");
  if (!request || typeof request.enabled !== "boolean") throw new Error("Native quota enabled must be boolean");
  const policy = validatePolicy(request.policy);
  activeSaves.add(supervisor);
  try {
    return await persistQuotaSettings(supervisor, request.enabled, policy);
  } finally {
    activeSaves.delete(supervisor);
  }
}

async function persistQuotaSettings(supervisor, enabled, policy) {
  const current = readQuotaSettings(supervisor);
  if (current.enabled === enabled && POLICY_KEYS.every(key => current.policy[key] === policy[key])) {
    return { ...current, changed: false };
  }
  const before = fs.readFileSync(supervisor.configPath, "utf8");
  const next = { ...supervisor.readConfig(), nativeQuotaReserveEnabled: enabled, nativeQuotaReserve: policy };
  writePrivateFileAtomic(supervisor.configPath, `${JSON.stringify(next, null, 2)}\n`);
  try {
    const restarted = await supervisor.restart();
    if (restarted.status !== "ready") throw new Error(`Runtime restart returned ${restarted.status}`);
    const saved = readQuotaSettings(supervisor);
    if (saved.enabled !== enabled || POLICY_KEYS.some(key => saved.policy[key] !== policy[key])) {
      throw new Error("Quota settings did not persist after restart");
    }
  } catch (error) {
    writePrivateFileAtomic(supervisor.configPath, before);
    try {
      const recovered = await supervisor.restart();
      if (recovered.status !== "ready") throw new Error(`Rollback restart returned ${recovered.status}`);
    } catch (rollbackError) {
      throw new Error(`Quota settings update failed: ${error.message}; rollback also failed: ${rollbackError.message}`);
    }
    throw new Error(`Quota settings update failed; previous settings restored: ${error.message}`);
  }
  return { enabled, policy, changed: true };
}

module.exports = { DEFAULT_POLICY, validatePolicy, readQuotaSettings, setQuotaSettings };
