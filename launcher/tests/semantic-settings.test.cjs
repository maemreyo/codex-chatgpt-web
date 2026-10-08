const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { semanticMemoryConfig, setSemanticMemoryPreference } = require("../electron/semantic-settings.cjs");

function fixture(initial = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sem-settings-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify({
    browserHost: "launcher", browserInteractionMode: "automatic",
    experimentalSemanticMemory: false, experimentalSemanticLogicalWindow: false,
    experimentalBiggerContext: true, retained: { sentinel: "preserve" }, ...initial,
  })}\n`);
  let restarts = 0;
  const supervisor = {
    configPath,
    readConfig: () => JSON.parse(fs.readFileSync(configPath, "utf8")),
    restart: async () => { restarts++; return { status: "ready" }; },
  };
  return {
    supervisor,
    read: supervisor.readConfig,
    restarts: () => restarts,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test("SEM persists atomically, survives runtime restart and is idempotent", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await setSemanticMemoryPreference(f.supervisor, true), { enabled: true, changed: true });
    assert.equal(f.read().experimentalSemanticMemory, true);
    assert.equal(f.read().experimentalBiggerContext, true);
    assert.equal(f.read().retained.sentinel, "preserve");
    assert.equal(f.restarts(), 1);
    assert.deepEqual(await setSemanticMemoryPreference(f.supervisor, true), { enabled: true, changed: false });
    assert.equal(f.restarts(), 1);
    await setSemanticMemoryPreference(f.supervisor, false);
    assert.equal(f.read().experimentalSemanticMemory, false);
    assert.equal(f.restarts(), 2);
  } finally { f.cleanup(); }
});

test("SEM prevents unsupported modes and clears logical-window dependency on disable", () => {
  assert.throws(() => semanticMemoryConfig({ browserHost: "launcher", browserInteractionMode: "manual" }, true), /automatic/);
  assert.throws(() => semanticMemoryConfig({ browserHost: "external", browserInteractionMode: "automatic" }, true), /launcher-owned/);
  assert.throws(() => semanticMemoryConfig({ browserHost: "launcher", browserInteractionMode: "automatic" }, "true"), /boolean/);
  const off = semanticMemoryConfig({ browserHost: "launcher", browserInteractionMode: "automatic", experimentalSemanticLogicalWindow: true }, false);
  assert.equal(off.experimentalSemanticLogicalWindow, false);
});

test("SEM rolls back persisted config when runtime restart fails", async () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.supervisor.configPath, "utf8");
    let n = 0;
    f.supervisor.restart = async () => ++n === 1 ? { status: "needs-setup" } : { status: "ready" };
    await assert.rejects(setSemanticMemoryPreference(f.supervisor, true), /previous configuration was restored/);
    assert.equal(fs.readFileSync(f.supervisor.configPath, "utf8"), before);
    assert.equal(n, 2);
  } finally { f.cleanup(); }
});

test("SEM control is connected through preload, IPC, state hydration and Settings", () => {
  const root = path.join(__dirname, "..");
  const read = file => fs.readFileSync(path.join(root, file), "utf8");
  assert.match(read("electron/preload.cjs"), /setSemanticMemory:.*launcher:semantic-memory/);
  const main = read("electron/main.cjs");
  assert.match(main, /handle\("launcher:semantic-memory"[\s\S]*?setSemanticMemoryPreference\(runtimeSupervisor, enabled\)/);
  assert.match(main, /experimentalSemanticMemory: config\.experimentalSemanticMemory === true/);
  const ui = read("src/App.tsx");
  assert.match(ui, /<SectionHeading label=\{copy\.experimentalFeatures\}/);
  assert.match(ui, /checked=\{snapshot\.state\.experimentalSemanticMemory\}/);
  assert.match(ui, /api!\.setSemanticMemory\(enabled\)/);
});
