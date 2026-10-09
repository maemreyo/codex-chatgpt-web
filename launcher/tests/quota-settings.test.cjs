const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_POLICY, readQuotaSettings, setQuotaSettings, validatePolicy } = require("../electron/quota-settings.cjs");

function fixture(initial = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-quota-settings-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ mode: "full", marker: { keep: true }, ...initial }));
  let restarts = 0;
  const supervisor = {
    configPath,
    readConfig: () => JSON.parse(fs.readFileSync(configPath, "utf8")),
    restart: async () => { restarts++; return { status: "ready" }; },
  };
  return { supervisor, read: supervisor.readConfig, restarts: () => restarts,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("quota protection defaults to off and strict without runtime mutation", () => {
  const f = fixture();
  try {
    assert.deepEqual(readQuotaSettings(f.supervisor), { enabled: false, policy: DEFAULT_POLICY });
    assert.equal(f.restarts(), 0);
  } finally { f.cleanup(); }
});

test("quota policy validates numeric bounds, allows only known keys and enforces admission > reserve", () => {
  assert.throws(() => validatePolicy({ mode: "conservative", fiveHourReservePercent: 30, fiveHourAdmissionPercent: 30 }), /exceed/);
  assert.throws(() => validatePolicy({ weeklyReservePercent: -1 }), /between 0 and 100/);
  assert.throws(() => validatePolicy({ fiveHourAdmissionPercent: "40" }), /between 0 and 100/);
  assert.throws(() => validatePolicy({ extra: true }), /Invalid native quota/);
  assert.throws(() => validatePolicy({ mode: "relaxed" }), /strict or conservative/);
});

test("quota preferences persist atomically, preserve other config and avoid redundant restarts", async () => {
  const f = fixture();
  try {
    const policy = { ...DEFAULT_POLICY, mode: "conservative", fiveHourAdmissionPercent: 35, weeklyAdmissionPercent: 15 };
    const result = await setQuotaSettings(f.supervisor, { enabled: true, policy });
    assert.deepEqual(result, { enabled: true, policy, changed: true });
    assert.deepEqual(readQuotaSettings(f.supervisor), { enabled: true, policy });
    assert.deepEqual(f.read().marker, { keep: true });
    assert.equal(f.restarts(), 1);
    assert.equal((await setQuotaSettings(f.supervisor, { enabled: true, policy })).changed, false);
    assert.equal(f.restarts(), 1);
  } finally { f.cleanup(); }
});

test("quota settings rejected before write when request is malformed", async () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.supervisor.configPath, "utf8");
    await assert.rejects(setQuotaSettings(f.supervisor, { enabled: "yes", policy: DEFAULT_POLICY }), /boolean/);
    await assert.rejects(setQuotaSettings(f.supervisor, { enabled: true, policy: { ...DEFAULT_POLICY, weeklyAdmissionPercent: 2 } }), /exceed/);
    assert.equal(fs.readFileSync(f.supervisor.configPath, "utf8"), before);
    assert.equal(f.restarts(), 0);
  } finally { f.cleanup(); }
});

test("quota settings roll back config and runtime when restart fails", async () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.supervisor.configPath, "utf8");
    let count = 0;
    f.supervisor.restart = async () => ++count === 1 ? { status: "failed" } : { status: "ready" };
    await assert.rejects(setQuotaSettings(f.supervisor, { enabled: true, policy: DEFAULT_POLICY }), /previous settings restored/);
    assert.equal(fs.readFileSync(f.supervisor.configPath, "utf8"), before);
    assert.equal(count, 2);
  } finally { f.cleanup(); }
});

test("overlapping saves reject the second write before it can race a restart or rollback", async () => {
  const f = fixture();
  try {
    let release;
    f.supervisor.restart = () => new Promise(resolve => { release = resolve; });
    const policy = { ...DEFAULT_POLICY, mode: "conservative", fiveHourAdmissionPercent: 35 };
    const first = setQuotaSettings(f.supervisor, { enabled: true, policy });
    assert.equal(typeof release, "function", "first save has entered its runtime restart");
    await assert.rejects(setQuotaSettings(f.supervisor, { enabled: false, policy: DEFAULT_POLICY }), /already in progress/);
    release({ status: "ready" });
    assert.equal((await first).changed, true);
    assert.deepEqual(readQuotaSettings(f.supervisor), { enabled: true, policy });
  } finally { f.cleanup(); }
});

test("quota protection is wired through IPC and launcher settings", () => {
  const root = path.join(__dirname, "..");
  const read = filename => fs.readFileSync(path.join(root, filename), "utf8");
  assert.match(read("electron/preload.cjs"), /getQuotaSettings:.*launcher:quota-guard-get/);
  assert.match(read("electron/preload.cjs"), /setQuotaSettings:.*launcher:quota-guard-save/);
  assert.match(read("electron/main.cjs"), /handle\("launcher:quota-guard-save"[\s\S]*?setQuotaSettings\(runtimeSupervisor, request\)/);
  assert.match(read("src/App.tsx"), /<QuotaProtectionPanel/);
  assert.match(read("src/QuotaProtectionPanel.tsx"), /api\.setQuotaSettings\(draft\)/);
});
