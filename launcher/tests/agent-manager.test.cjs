const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createAgentManager } = require("../electron/agent-manager.cjs");

const sourceRoot = path.resolve(__dirname, "../..");

function temporaryHome(t) {
  const parent = mkdtempSync(path.join(tmpdir(), "zam-agent-ui-test-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const codexHome = path.join(parent, "codex");
  mkdirSync(codexHome);
  writeFileSync(path.join(codexHome, "config.toml"), 'model = "chatgpt-web/gpt-6-sol"\n# Preserve personal settings\n');
  return codexHome;
}

function manager(codexHome, now) {
  return createAgentManager({
    codexHome, now,
    runtimeCommand: args => ({ executable: "bun", args: ["run", path.join(sourceRoot, "src/cli.ts"), ...args], cwd: sourceRoot }),
  });
}

test("Electron agent bridge inspects and previews metadata without modifying native config", async t => {
  const codexHome = temporaryHome(t);
  const native = manager(codexHome);
  const original = readFileSync(path.join(codexHome, "config.toml"), "utf8");
  const inspection = await native.inspect();
  assert.equal(inspection.roles.length, 4);
  assert.equal(inspection.pendingRecovery, false);
  assert.match(inspection.warnings.join(" "), /not verified/);

  const preview = await native.preview({ preset: "balanced", maxConcurrentThreads: 3, enrollMissingRoles: false });
  assert.match(preview.id, /^[a-f0-9]{64}$/);
  assert.equal(preview.changes.length, 1);
  assert.deepEqual(preview.changes[0].changedKeys, ["agents.max_concurrent_threads_per_session"]);
  assert.equal(Object.hasOwn(preview, "request"), false);
  assert.equal(Object.hasOwn(preview.changes[0], "resultingSha256"), false);
  assert.equal(readFileSync(path.join(codexHome, "config.toml"), "utf8"), original);
  const result = await native.apply(preview.id);
  assert.equal(result.applied, true);
  assert.equal(result.requiresRestart, true);
  assert.match(readFileSync(path.join(codexHome, "config.toml"), "utf8"), /max_concurrent_threads_per_session = 3/);
  const custom = await native.preview({ preset: "custom", maxConcurrentThreads: 5, enrollMissingRoles: false });
  assert.equal(custom.changes.length, 1);
  assert.equal((await native.apply(custom.id)).applied, true);
  assert.equal((await native.inspect()).maxConcurrentThreads, 5);
  assert.match(readFileSync(path.join(codexHome, "config.toml"), "utf8"), /Preserve personal settings/);
  await assert.rejects(() => native.apply(preview.id), /missing or expired/);
});

test("Electron bridge preserves external edits and requires a fresh preview", async t => {
  const codexHome = temporaryHome(t);
  const native = manager(codexHome);
  const preview = await native.preview({ preset: "balanced", maxConcurrentThreads: 3, enrollMissingRoles: false });
  writeFileSync(path.join(codexHome, "config.toml"), 'model = "chatgpt-web/gpt-6-sol"\n# Modified externally\n');
  await assert.rejects(() => native.apply(preview.id), /stale|modified/);
  assert.match(readFileSync(path.join(codexHome, "config.toml"), "utf8"), /Modified externally/);
  await assert.rejects(() => native.preview({ preset: "parallel", maxConcurrentThreads: 9, enrollMissingRoles: false }), /Unsupported agent preset/);
  await assert.rejects(() => native.apply("unsafe"), /Invalid agent preview ID/);
});

test("Electron agent bridge can explicitly enroll missing roles without leaking instruction text to UI", async t => {
  const codexHome = temporaryHome(t);
  const native = manager(codexHome);
  const preview = await native.preview({ preset: "balanced", maxConcurrentThreads: 3, enrollMissingRoles: true });
  assert.equal(preview.changes.length, 5);
  assert.equal(JSON.stringify(preview).includes("For tool errors"), false);
  assert.equal((await native.apply(preview.id)).applied, true);
  const inspection = await native.inspect();
  assert.equal(inspection.roles.filter(role => role.managed).length, 4);
  assert.equal(inspection.maxConcurrentThreads, 3);
  assert.deepEqual(await native.recover(), { recovery: "nothing-to-recover" });
});

test("Electron agent editor previews and applies scoped role edits without changing other roles", async t => {
  const codexHome = temporaryHome(t);
  const native = manager(codexHome);
  const enrollment = await native.preview({ preset: "balanced", maxConcurrentThreads: 4, enrollMissingRoles: true });
  await native.apply(enrollment.id);
  const previous = await native.inspect();
  assert.equal(previous.roles.find(role => role.name === "zam-explorer").policy, "web-only");
  assert.match(previous.roles.find(role => role.name === "zam-explorer").developerInstructions, /Map repository authority/);
  const reviewerPath = path.join(codexHome, "agents", "zam-reviewer.toml");
  const untouched = readFileSync(reviewerPath, "utf8");
  const preview = await native.preview({
    preset: "parallel", maxConcurrentThreads: 6, enrollMissingRoles: false,
    roles: { "zam-builder": { reasoningEffort: "medium", sandboxMode: "workspace-write",
      developerInstructions: "Implement bounded changes with explicit review." } },
  });
  assert.equal(JSON.stringify(preview).includes("Implement bounded changes"), false);
  assert.equal(preview.changes.length, 2);
  assert.equal((await native.apply(preview.id)).applied, true);
  const result = await native.inspect();
  assert.equal(result.maxConcurrentThreads, 6);
  const balanced = await native.preview({ preset: "balanced", maxConcurrentThreads: 4, enrollMissingRoles: false });
  assert.equal(balanced.changes.length, 1);
  assert.equal((await native.apply(balanced.id)).applied, true);
  assert.equal((await native.inspect()).maxConcurrentThreads, 4);
  const builder = result.roles.find(role => role.name === "zam-builder");
  assert.equal(builder.reasoningEffort, "medium");
  assert.equal(builder.developerInstructions, "Implement bounded changes with explicit review.");
  assert.equal(readFileSync(reviewerPath, "utf8"), untouched);
  await assert.rejects(() => native.preview({
    preset: "parallel", maxConcurrentThreads: 6, enrollMissingRoles: false,
    roles: { "zam-reviewer": { sandboxMode: "workspace-write" } },
  }), /Only zam-builder/);
  await assert.rejects(() => native.preview({
    preset: "parallel", maxConcurrentThreads: 6, enrollMissingRoles: false,
    roles: { "zam-builder": { model: "gpt-6" } },
  }), /approved ChatGPT Web route/);
});
