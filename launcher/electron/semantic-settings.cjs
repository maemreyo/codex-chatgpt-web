const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

// SEM is a projection over canonical history. The larger logical window remains
// an independently gated experiment, even when SEM itself is enabled.
function semanticMemoryConfig(config, enabled) {
  if (typeof enabled !== "boolean") throw new Error("Semantic memory preference must be a boolean");
  if (!config || config.browserHost !== "launcher" || config.browserInteractionMode !== "automatic") {
    throw new Error("Semantic memory requires a configured launcher-owned automatic browser runtime");
  }
  return {
    ...config,
    experimentalSemanticMemory: enabled,
    // Do not leave a logical window enabled after its required SEM dependency is disabled.
    ...(enabled ? {} : { experimentalSemanticLogicalWindow: false }),
  };
}

async function setSemanticMemoryPreference(supervisor, enabled) {
  const current = supervisor.readConfig();
  const next = semanticMemoryConfig(current, enabled);
  const changed = next.experimentalSemanticMemory !== current.experimentalSemanticMemory
    || next.experimentalSemanticLogicalWindow !== current.experimentalSemanticLogicalWindow;
  if (!changed) return { enabled, changed: false };
  const before = fs.readFileSync(supervisor.configPath, "utf8");
  writePrivateFileAtomic(supervisor.configPath, `${JSON.stringify(next, null, 2)}\n`);
  try {
    const restarted = await supervisor.restart();
    if (restarted.status !== "ready") throw new Error(`Runtime restart returned ${restarted.status}`);
    if (supervisor.readConfig()?.experimentalSemanticMemory !== enabled) {
      throw new Error("Semantic memory preference did not persist after restart");
    }
  } catch (error) {
    writePrivateFileAtomic(supervisor.configPath, before);
    try {
      const restored = await supervisor.restart();
      if (restored.status !== "ready") throw new Error(`Rollback restart returned ${restored.status}`);
    } catch (rollbackError) {
      throw new Error(`Semantic memory update failed: ${error.message}; rollback also failed: ${rollbackError.message}`);
    }
    throw new Error(`Semantic memory update failed and previous configuration was restored: ${error.message}`);
  }
  return { enabled, changed: true };
}

module.exports = { semanticMemoryConfig, setSemanticMemoryPreference };
