import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  AGENT_ROLES, AgentConfigError, applyAgentConfiguration, getAgentTemplate,
  inspectAgentConfiguration, previewAgentConfiguration, recoverAgentConfiguration,
  validateAgentSpawnRequest,
} from "../src/agent-management";
import { appendRoleRegistration, patchRoleFile, patchThreadLimit } from "../src/agent-management/document";

let codexHome: string;
const options = () => ({ codexHome });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const native = (s: string) => Bun.TOML.parse(s) as Record<string, any>;
const cfg = () => join(codexHome, "config.toml");
const manager = () => join(codexHome, ".zam-agent-management");

beforeEach(() => {
  codexHome = realpathSync(mkdtempSync(join(tmpdir(), "zam-agents-test-")));
});
afterEach(() => { rmSync(codexHome, { recursive: true, force: true }); });

test("public APIs import without writes and report legacy alias with unverified policy", () => {
  writeFileSync(cfg(), `[agents]\nmax_threads = 4 # keep me\n[agents.zam-builder]\nconfig_file = "agents/zam-builder.toml"\n`);
  mkdirSync(join(codexHome, "agents"));
  writeFileSync(join(codexHome, "agents", "zam-builder.toml"), `model = "chatgpt-web/gpt-6-sol"\ndeveloper_instructions = "custom"\n`);
  const before = readFileSync(cfg(), "utf8");
  const output = inspectAgentConfiguration(options());
  expect(output.maxConcurrentThreadsPerSession).toBe(4);
  expect(output.threadLimitKey).toBe("max_threads");
  expect(output.configStatus).toBe("unmanaged");
  expect(output.whitelistEnforcement).toBe("unverified");
  expect(output.roles.find(r => r.name === "zam-builder")?.developerInstructions).toBe("custom");
  expect(output.roles.find(r => r.name === "zam-explorer")?.registered).toBe(false);
  expect(readFileSync(cfg(), "utf8")).toBe(before);
  expect(existsSync(manager())).toBe(false);
});

test("preview is metadata-only, Apply reconstructs across JSON processes and preserves unrelated TOML", () => {
  const initial = `# user comment\nprivate_token = "do-not-echo"\n[agents]\nmax_threads = 4 # retain comment\n[another]\nfield = "manual"\n`;
  writeFileSync(cfg(), initial);
  const request = { maxConcurrentThreadsPerSession: 6, roles: { "zam-builder": { enabled: true as const } } };
  const preview = previewAgentConfiguration(options(), request);
  expect(preview.id).toMatch(/^[a-f0-9]{64}$/);
  expect(preview.changes).toHaveLength(2);
  expect(JSON.stringify(preview.changes)).not.toContain("do-not-echo");
  expect(readFileSync(cfg(), "utf8")).toBe(initial);
  expect(existsSync(manager())).toBe(false);
  const serialized = JSON.parse(JSON.stringify(preview));
  const result = applyAgentConfiguration(options(), serialized);
  expect(result.applied).toBe(true);
  expect(result.changedFiles).toHaveLength(2);
  const text = readFileSync(cfg(), "utf8");
  expect(text).toContain('# user comment\nprivate_token = "do-not-echo"');
  expect(text).toContain("max_concurrent_threads_per_session = 6 # retain comment");
  expect(native(text).another.field).toBe("manual");
  expect(native(text).agents["zam-builder"].config_file).toBe("agents/zam-builder.toml");
  const rolePath = join(codexHome, "agents", "zam-builder.toml");
  expect(native(readFileSync(rolePath, "utf8")).model).toBe("chatgpt-web/gpt-6-sol");
  expect(lstatSync(join(manager(), "ownership.json")).mode & 0o777).toBe(0o600);
  expect(lstatSync(manager()).mode & 0o777).toBe(0o700);
  expect(existsSync(join(manager(), "pending-transaction.json"))).toBe(false);
  expect(inspectAgentConfiguration(options()).configStatus).toBe("managed");
  expect(inspectAgentConfiguration(options()).roles.find(r => r.name === "zam-builder")?.status).toBe("managed");
  const again = previewAgentConfiguration(options(), request);
  expect(again.changes).toHaveLength(0);
  expect(applyAgentConfiguration(options(), again).applied).toBe(false);
  writeFileSync(cfg(), readFileSync(cfg(), "utf8") + "# config external change\n");
  expect(inspectAgentConfiguration(options()).configStatus).toBe("externally-changed");
});

test("manual changes after preview are never overwritten and stale previews are not accepted", () => {
  writeFileSync(cfg(), 'user = "original"\n');
  const preview = previewAgentConfiguration(options(), { maxConcurrentThreadsPerSession: 4 });
  writeFileSync(cfg(), 'user = "external-edit"\n');
  expect(() => applyAgentConfiguration(options(), preview)).toThrow("stale or modified");
  expect(readFileSync(cfg(), "utf8")).toBe('user = "external-edit"\n');
  expect(existsSync(join(manager(), "pending-transaction.json"))).toBe(false);
  const fresh = previewAgentConfiguration(options(), { maxConcurrentThreadsPerSession: 4 });
  expect(() => applyAgentConfiguration(options(), { ...fresh, id: "0".repeat(64) })).toThrow("stale or modified");
  expect(() => applyAgentConfiguration(options(), { ...fresh, changes: [] })).toThrow("stale or modified");
});

test("role patch changes only selected native scalars and keeps customized instructions", () => {
  writeFileSync(cfg(), `[agents.zam-builder]\nconfig_file = "agents/zam-builder.toml"\n`);
  mkdirSync(join(codexHome, "agents"));
  const path = join(codexHome, "agents", "zam-builder.toml");
  writeFileSync(path, `# custom instructions\nmodel = 'chatgpt-web/gpt-6-sol'\ndeveloper_instructions = "preserve this"\nmodel_reasoning_effort = "high" # comment\nextra_field = true\n`);
  const preview = previewAgentConfiguration(options(), { roles: { "zam-builder": { reasoningEffort: "medium" } } });
  expect(preview.changes).toHaveLength(1);
  applyAgentConfiguration(options(), preview);
  const text = readFileSync(path, "utf8");
  expect(text).toContain('developer_instructions = "preserve this"');
  expect(text).toContain('model_reasoning_effort = "medium" # comment');
  expect(text).toContain('extra_field = true');
  expect(inspectAgentConfiguration(options()).roles.find(r => r.name === "zam-builder")?.reasoningEffort).toBe("medium");
  writeFileSync(path, text + "# edited later\n");
  expect(inspectAgentConfiguration(options()).roles.find(r => r.name === "zam-builder")?.status).toBe("externally-changed");
});

test("rejects malformed TOML, ambiguous aliases, symlinks and unsafe policies", () => {
  writeFileSync(cfg(), '[agents\n');
  // Bun 1.3 and 1.4 can report an invalid source at different parse stages.
  expect(() => previewAgentConfiguration(options(), { maxConcurrentThreadsPerSession: 4 }))
    .toThrow(/cannot be safely edited|TOML is malformed/);
  writeFileSync(cfg(), '[agents]\nmax_threads = 2\nmax_concurrent_threads_per_session = 3\n');
  expect(() => previewAgentConfiguration(options(), { maxConcurrentThreadsPerSession: 4 })).toThrow("Both native");
  writeFileSync(cfg(), `[agents.zam-reviewer]\nconfig_file = "agents/zam-reviewer.toml"\n`);
  mkdirSync(join(codexHome, "agents"));
  symlinkSync(cfg(), join(codexHome, "agents", "zam-reviewer.toml"));
  expect(() => previewAgentConfiguration(options(), { roles: { "zam-reviewer": { model: "chatgpt-web/gpt-6-sol" } } })).toThrow("regular");
  expect(() => previewAgentConfiguration(options(), { roles: { "zam-builder": { model: "api-paid" as any } } })).toThrow("approved");
  expect(() => previewAgentConfiguration(options(), { roles: { "zam-builder": { enabled: false as any } } })).toThrow("Disabling");
  expect(() => previewAgentConfiguration(options(), { roles: { "zam-explorer": { sandboxMode: "workspace-write" as const } } })).toThrow("Only zam-builder");
  expect(() => previewAgentConfiguration(options(), { maxConcurrentThreadsPerSession: 6.5 })).toThrow("integer");
  expect(() => validateAgentSpawnRequest({ agent_type: "default" })).toThrow("whitelist");
  expect(() => validateAgentSpawnRequest({ agent_type: "zam-builder", model: "chatgpt-web/gpt-6-sol" })).toThrow("overrides");
  expect(validateAgentSpawnRequest({ agent_type: "zam-reviewer" })).toBe("zam-reviewer");
});

test("missing role registration never adopts an existing unmanaged role file", () => {
  mkdirSync(join(codexHome, "agents"));
  writeFileSync(join(codexHome, "agents", "zam-builder.toml"), 'model = "manual"\n');
  expect(() => previewAgentConfiguration(options(), { roles: { "zam-builder": { enabled: true } } })).toThrow("import manually");
});

test("new template versions include shared safety and remain Web-only", () => {
  expect(AGENT_ROLES).toHaveLength(4);
  for (const role of AGENT_ROLES) {
    const template = getAgentTemplate(role);
    expect(template.version).toBe(1);
    expect(template.model).toBe("chatgpt-web/gpt-6-sol");
    expect(template.reasoningEffort).toBe(role === "zam-researcher" ? "medium" : "high");
    expect(template.developerInstructions).toContain("at most three attempts");
    expect(patchRoleFile(null, role, {})).toContain("# Zam managed role template v1;");
    expect(native(patchRoleFile(null, role, {})).model).toBe(template.model);
  }
});

test("crash during manifest commit restores manifest and native files as one transaction", () => {
  const original = 'original = "source"\n';
  const changed = patchThreadLimit(original, 6);
  const originalManifest = JSON.stringify({ version: 1, transactionId: "old-transaction", files: {}, templateVersion: 1 });
  const newManifest = JSON.stringify({ version: 1, transactionId: "new-transaction", files: { [cfg()]: digest(changed) }, templateVersion: 1 });
  writeFileSync(cfg(), changed);
  mkdirSync(manager(), { mode: 0o700 });
  const manifestPath = join(manager(), "ownership.json");
  writeFileSync(manifestPath, originalManifest, { mode: 0o600 });
  const journalPath = join(manager(), "pending-transaction.json");
  const journal = { version: 1, codexHome, transactionId: "new-transaction", entries: [
    { path: cfg(), beforeText: original, afterText: changed, beforeHash: digest(original), afterHash: digest(changed), mode: 0o600 },
    { path: manifestPath, beforeText: originalManifest, afterText: newManifest,
      beforeHash: digest(originalManifest), afterHash: digest(newManifest), mode: 0o600 },
  ] };
  writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 });
  expect(recoverAgentConfiguration(options())).toBe("rolled-back");
  expect(readFileSync(cfg(), "utf8")).toBe(original);
  expect(readFileSync(manifestPath, "utf8")).toBe(originalManifest);
  expect(existsSync(journalPath)).toBe(false);
});

test("crash after manifest commit is finalized and preserves the new transaction", () => {
  const original = 'original = "source"\n';
  const changed = patchThreadLimit(original, 6);
  const nextManifest = JSON.stringify({ version: 1, transactionId: "just-committed", files: { [cfg()]: digest(changed) }, templateVersion: 1 });
  writeFileSync(cfg(), changed);
  mkdirSync(manager(), { mode: 0o700 });
  const manifestPath = join(manager(), "ownership.json");
  writeFileSync(manifestPath, nextManifest, { mode: 0o600 });
  writeFileSync(join(manager(), "pending-transaction.json"), JSON.stringify({
    version: 1, codexHome, transactionId: "just-committed", entries: [
      { path: cfg(), beforeText: original, afterText: changed, beforeHash: digest(original), afterHash: digest(changed), mode: 0o600 },
      { path: manifestPath, beforeText: null, afterText: nextManifest, beforeHash: null, afterHash: digest(nextManifest), mode: 0o600 },
    ],
  }), { mode: 0o600 });
  expect(recoverAgentConfiguration(options())).toBe("committed");
  expect(readFileSync(cfg(), "utf8")).toBe(changed);
  expect(readFileSync(manifestPath, "utf8")).toBe(nextManifest);
});

test("conflicting registered role files and external role paths fail closed", () => {
  writeFileSync(cfg(), '[agents.zam-builder]\nconfig_file = "agents/common.toml"\n[agents.zam-reviewer]\nconfig_file = "agents/common.toml"\n');
  expect(() => inspectAgentConfiguration(options())).toThrow("same config file");
  expect(() => previewAgentConfiguration(options(), { maxConcurrentThreadsPerSession: 5 })).toThrow("same config file");
  writeFileSync(cfg(), '[agents.zam-builder]\nconfig_file = "../outside.toml"\n');
  expect(() => previewAgentConfiguration(options(), { roles: { "zam-builder": { enabled: true } } })).toThrow("inside the selected Codex home");
});

test("incomplete multi-file write after a crash rolls back only still-owned participants", () => {
  const initial = 'token = "private-original"\n';
  writeFileSync(cfg(), initial);
  const changed = patchThreadLimit(initial, 6);
  const rolePath = join(codexHome, "agents", "zam-builder.toml");
  const role = patchRoleFile(null, "zam-builder", {});
  const journal = { version: 1, codexHome, transactionId: "crash-1", entries: [
    { path: rolePath, beforeText: null, afterText: role, beforeHash: null, afterHash: digest(role), mode: 0o600 },
    { path: cfg(), beforeText: initial, afterText: changed, beforeHash: digest(initial), afterHash: digest(changed), mode: 0o600 },
  ] };
  mkdirSync(manager(), { mode: 0o700 });
  mkdirSync(join(codexHome, "agents"));
  writeFileSync(rolePath, role);
  writeFileSync(join(manager(), "pending-transaction.json"), JSON.stringify(journal), { mode: 0o600 });
  expect(inspectAgentConfiguration(options()).pendingRecovery).toBe(true);
  expect(() => previewAgentConfiguration(options(), { maxConcurrentThreadsPerSession: 6 })).toThrow("Recover");
  expect(recoverAgentConfiguration(options())).toBe("rolled-back");
  expect(readFileSync(cfg(), "utf8")).toBe(initial);
  expect(existsSync(rolePath)).toBe(false);
  expect(existsSync(join(manager(), "pending-transaction.json"))).toBe(false);
  expect(recoverAgentConfiguration(options())).toBe("nothing-to-recover");
});

test("external modification during recovery never gets overwritten", () => {
  const original = 'owner = "before"\n';
  const after = 'owner = "after"\n';
  const edited = 'owner = "outside"\n';
  writeFileSync(cfg(), edited);
  mkdirSync(manager(), { mode: 0o700 });
  writeFileSync(join(manager(), "pending-transaction.json"), JSON.stringify({ version: 1, codexHome, transactionId: "crash-2", entries: [
    { path: cfg(), beforeText: original, afterText: after, beforeHash: digest(original), afterHash: digest(after), mode: 0o600 },
  ] }), { mode: 0o600 });
  expect(() => recoverAgentConfiguration(options())).toThrow("externally");
  expect(readFileSync(cfg(), "utf8")).toBe(edited);
  expect(existsSync(join(manager(), "pending-transaction.json"))).toBe(true);
});

test("committed journal after crash is finalized without rollback", () => {
  const original = 'limit = 1\n';
  const after = 'limit = 3\n';
  writeFileSync(cfg(), after);
  mkdirSync(manager(), { mode: 0o700 });
  writeFileSync(join(manager(), "pending-transaction.json"), JSON.stringify({ version: 1, codexHome, transactionId: "crash-3", entries: [
    { path: cfg(), beforeText: original, afterText: after, beforeHash: digest(original), afterHash: digest(after), mode: 0o600 },
  ] }), { mode: 0o600 });
  writeFileSync(join(manager(), "ownership.json"), JSON.stringify({ version: 1, transactionId: "crash-3", files: { [cfg()]: digest(after) }, templateVersion: 1 }), { mode: 0o600 });
  expect(recoverAgentConfiguration(options())).toBe("committed");
  expect(readFileSync(cfg(), "utf8")).toBe(after);
});

test("stale crash lock from dead PID permits recovery; active lock rejects concurrent Apply", () => {
  writeFileSync(cfg(), 'ok = true\n');
  mkdirSync(manager(), { mode: 0o700 });
  writeFileSync(join(manager(), "transaction.lock"), `${process.pid}\n`, { mode: 0o600 });
  const preview = previewAgentConfiguration(options(), { maxConcurrentThreadsPerSession: 5 });
  expect(() => applyAgentConfiguration(options(), preview)).toThrow("locked");
  rmSync(join(manager(), "transaction.lock"));
  writeFileSync(join(manager(), "transaction.lock"), '999999999\n', { mode: 0o600 });
  expect(recoverAgentConfiguration(options())).toBe("nothing-to-recover");
  expect(existsSync(join(manager(), "transaction.lock"))).toBe(false);
});

test("CLI JSON preview and Apply survive separate processes without a process-local preview cache", () => {
  writeFileSync(cfg(), 'existing = "preserved"\n');
  const invoke = (action: "preview" | "apply", input: unknown) => {
    const child = spawnSync(process.execPath, ["run", "src/cli.ts", "agents", action, "--codex-home", codexHome], {
      cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(input), env: { ...process.env, CODEX_HOME: codexHome },
      timeout: 10_000,
    });
    expect(child.status).toBe(0);
    return JSON.parse(child.stdout);
  };
  const preview = invoke("preview", { maxConcurrentThreadsPerSession: 4 });
  expect(preview.changes).toHaveLength(1);
  expect(JSON.stringify(preview)).not.toContain("preserved");
  const applied = invoke("apply", preview);
  expect(applied.applied).toBe(true);
  expect(native(readFileSync(cfg(), "utf8")).agents.max_concurrent_threads_per_session).toBe(4);
  expect(readFileSync(cfg(), "utf8")).toContain('existing = "preserved"');
});
