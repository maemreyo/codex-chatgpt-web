import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, fchmodSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendRoleRegistration, parseDocument, patchRoleFile, patchThreadLimit } from "./document";
import {
  AGENT_ROLES, AGENT_TEMPLATE_VERSION, AgentConfigError, WEB_AGENT_MODEL,
  validateRequest, type AgentConfigurationApplyResult, type AgentConfigurationInspection,
  type AgentConfigurationPreview, type AgentConfigurationRequest, type AgentHomeOptions,
  type AgentRole, type AgentRoleInspection,
} from "./schema";

const PRIVATE_DIR = ".zam-agent-management";
const JOURNAL_NAME = "pending-transaction.json";
const MANIFEST_NAME = "ownership.json";
const LOCK_NAME = "transaction.lock";
const DIGEST = /^[a-f0-9]{64}$/;

type NativeSnapshot = { path: string; exists: boolean; text: string; sha256: string | null; mode: number };
type PlannedWrite = { before: NativeSnapshot; after: string; changedKeys: string[] };
type JournalEntry = { path: string; beforeText: string | null; afterText: string; beforeHash: string | null; afterHash: string; mode: number };
type RecoveryJournal = { version: 1; codexHome: string; transactionId: string; entries: JournalEntry[] };
type Manifest = { version: 1; transactionId: string; files: Record<string, string>; templateVersion: number };

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
function stableJSON(value: unknown): string { return JSON.stringify(stable(value)); }
function rootFrom(options: AgentHomeOptions): string {
  if (!options || typeof options.codexHome !== "string" || !isAbsolute(options.codexHome)) {
    throw new AgentConfigError("INVALID", "A full absolute codexHome must be specified explicitly");
  }
  const requested = resolve(options.codexHome);
  if (!existsSync(requested) || !lstatSync(requested).isDirectory()) {
    throw new AgentConfigError("UNSUPPORTED", "Codex home must be an existing real directory, not a symlink");
  }
  // Canonicalize symlinked system ancestors (e.g. macOS /var -> /private/var),
  // while refusing an actual Codex-home alias as the final path component.
  return realpathSync(requested);
}
function inside(home: string, file: string): string {
  const absolute = resolve(file);
  const rel = relative(home, absolute);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new AgentConfigError("UNSUPPORTED", "Agent config path must remain inside the selected Codex home");
  }
  return absolute;
}
function safeParents(home: string, file: string): void {
  inside(home, file);
  let cursor = dirname(file);
  const chain: string[] = [];
  while (cursor !== home) {
    chain.push(cursor);
    const previous = dirname(cursor);
    if (previous === cursor) throw new AgentConfigError("UNSUPPORTED", "Agent path escaped Codex home");
    cursor = previous;
  }
  for (const directory of chain.reverse()) {
    if (existsSync(directory) && !lstatSync(directory).isDirectory()) {
      throw new AgentConfigError("UNSUPPORTED", "Agent config parent is not a real directory");
    }
    // Broken symlinks also must fail closed.
    try { if (lstatSync(directory).isSymbolicLink()) throw new AgentConfigError("UNSUPPORTED", "Agent config parent is a symlink"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function snapshot(home: string, file: string): NativeSnapshot {
  safeParents(home, file);
  let metadata;
  try { metadata = lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, exists: false, text: "", sha256: null, mode: 0o600 };
    throw error;
  }
  if (!metadata.isFile() || metadata.nlink !== 1) {
    throw new AgentConfigError("UNSUPPORTED", "Managed config must be a regular, unlinked file");
  }
  const fd = openSync(file, "r", 0o600);
  try {
    const check = fstatSync(fd);
    if (!check.isFile() || check.ino !== metadata.ino || check.dev !== metadata.dev) {
      throw new AgentConfigError("CONFLICT", "Config file changed during inspection");
    }
    const data = readFileSync(fd);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return { path: file, exists: true, text, sha256: hash(text), mode: metadata.mode & 0o777 };
  } finally { closeSync(fd); }
}
function readConfig(home: string): { source: NativeSnapshot; parsed: Record<string, unknown> } {
  const source = snapshot(home, join(home, "config.toml"));
  return { source, parsed: parseDocument(source.text) };
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function rolePath(home: string, agents: Record<string, unknown> | null, role: AgentRole): string | null {
  const record = object(agents?.[role]);
  if (!record) return null;
  if (typeof record.config_file !== "string" || !record.config_file.trim()) {
    throw new AgentConfigError("UNSUPPORTED", "Registered role has no valid config_file");
  }
  const raw = record.config_file;
  if (raw.startsWith("~/")) return inside(home, join(homedir(), raw.slice(2)));
  return inside(home, isAbsolute(raw) ? raw : join(home, raw));
}
function pathsFor(home: string, parsed: Record<string, unknown>): Map<AgentRole, string | null> {
  const agents = object(parsed.agents);
  const paths = new Map<AgentRole, string | null>();
  const unique = new Set<string>();
  for (const role of AGENT_ROLES) {
    const path = rolePath(home, agents, role);
    if (path && unique.has(path)) throw new AgentConfigError("UNSUPPORTED", "Multiple agents reference the same config file");
    if (path) unique.add(path);
    paths.set(role, path);
  }
  return paths;
}
function metadata(home: string): { dir: string; journalPath: string; manifestPath: string; lockPath: string } {
  const dir = join(home, PRIVATE_DIR);
  safeParents(home, dir);
  return { dir, journalPath: join(dir, JOURNAL_NAME), manifestPath: join(dir, MANIFEST_NAME), lockPath: join(dir, LOCK_NAME) };
}
function readJSON(path: string): unknown {
  const s = lstatSync(path);
  if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) !== 0) {
    throw new AgentConfigError("RECOVERY_REQUIRED", "Private agent manager metadata has unsafe permissions or type");
  }
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new AgentConfigError("RECOVERY_REQUIRED", "Agent manager recovery metadata is damaged"); }
}
function privateFileExists(home: string, path: string): boolean {
  const { dir } = metadata(home);
  try {
    const parent = lstatSync(dir);
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) {
      throw new AgentConfigError("RECOVERY_REQUIRED", "Private manager directory has unsafe permissions or type");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function readManifest(home: string): Manifest | null {
  const path = metadata(home).manifestPath;
  if (!privateFileExists(home, path)) return null;
  const value = readJSON(path) as Manifest;
  if (value.version !== 1 || typeof value.transactionId !== "string" || !object(value.files)) {
    throw new AgentConfigError("RECOVERY_REQUIRED", "Invalid agent ownership manifest");
  }
  return value;
}
function readJournal(home: string): RecoveryJournal | null {
  const path = metadata(home).journalPath;
  if (!privateFileExists(home, path)) return null;
  const value = readJSON(path) as RecoveryJournal;
  if (value.version !== 1 || value.codexHome !== home || typeof value.transactionId !== "string" || !Array.isArray(value.entries)) {
    throw new AgentConfigError("RECOVERY_REQUIRED", "Invalid agent recovery journal");
  }
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || typeof entry.path !== "string" || inside(home, entry.path) !== entry.path || seen.has(entry.path)
      || typeof entry.afterText !== "string" || !DIGEST.test(entry.afterHash)
      || hash(entry.afterText) !== entry.afterHash || !(entry.beforeText === null || typeof entry.beforeText === "string")
      || entry.beforeHash !== (entry.beforeText === null ? null : hash(entry.beforeText))
      || !Number.isSafeInteger(entry.mode)) {
      throw new AgentConfigError("RECOVERY_REQUIRED", "Invalid agent recovery entry");
    }
    seen.add(entry.path);
  }
  return value;
}
function makePlan(home: string, request: AgentConfigurationRequest): PlannedWrite[] {
  const changes = new Map<string, PlannedWrite>();
  const { source, parsed } = readConfig(home);
  const paths = pathsFor(home, parsed);
  let configText = source.text;
  const keys: string[] = [];
  if (request.maxConcurrentThreadsPerSession !== undefined) {
    configText = patchThreadLimit(configText, request.maxConcurrentThreadsPerSession);
    keys.push("agents.max_concurrent_threads_per_session");
  }
  for (const role of AGENT_ROLES) {
    const rolePatch = request.roles?.[role];
    if (!rolePatch) continue;
    const registered = paths.get(role);
    const path = registered ?? join(home, "agents", `${role}.toml`);
    const before = snapshot(home, path);
    if (!registered && before.exists) {
      throw new AgentConfigError("CONFLICT", "Unregistered agent config already exists; import manually before applying");
    }
    if (registered && !before.exists) throw new AgentConfigError("UNSUPPORTED", "Native registered agent file is missing");
    const after = patchRoleFile(before.exists ? before.text : null, role, rolePatch);
    if (before.text !== after) {
      changes.set(path, { before, after, changedKeys: Object.keys(rolePatch).length ? Object.keys(rolePatch) : ["template"] });
    }
    if (!registered) {
      configText = appendRoleRegistration(configText, role);
      keys.push(`agents.${role}.config_file`, `agents.${role}.description`);
    }
  }
  if (configText !== source.text) changes.set(source.path, { before: source, after: configText, changedKeys: keys });
  return [...changes.values()].sort((a, b) => a.before.path.localeCompare(b.before.path));
}
function toPreview(home: string, request: AgentConfigurationRequest, plan: PlannedWrite[]): AgentConfigurationPreview {
  const changes = plan.map(item => ({
    path: item.before.path, operation: item.before.exists ? "update" as const : "create" as const,
    expectedSha256: item.before.sha256, resultingSha256: hash(item.after), changedKeys: item.changedKeys,
  }));
  const payload = { version: 1 as const, codexHome: home, request, changes,
    templateVersion: AGENT_TEMPLATE_VERSION, warnings: ["Whitelist hook/trust and effective sandbox permissions are not verified; verify Codex native hooks before relying on runtime enforcement."],
    activation: "new-session-required" as const };
  return { ...payload, id: hash(stableJSON(payload)) };
}

export function inspectAgentConfiguration(options: AgentHomeOptions): AgentConfigurationInspection {
  const home = rootFrom(options);
  const { source, parsed } = readConfig(home);
  const agents = object(parsed.agents);
  const limit = agents?.max_concurrent_threads_per_session;
  const alias = agents?.max_threads;
  const key = limit === undefined ? (alias === undefined ? null : "max_threads") : "max_concurrent_threads_per_session";
  const paths = pathsFor(home, parsed);
  const manifest = readManifest(home);
  const roles: AgentRoleInspection[] = AGENT_ROLES.map(name => {
    const configFile = paths.get(name) ?? null;
    const base = { name, configFile, registered: configFile !== null, effectivePermissions: "unverified" as const };
    if (!configFile) return { ...base, model: null, reasoningEffort: null, sandboxMode: null, developerInstructions: null,
      status: "unregistered", policy: "unverified" };
    try {
      const state = snapshot(home, configFile);
      if (!state.exists) return { ...base, model: null, reasoningEffort: null, sandboxMode: null, developerInstructions: null,
        status: "unsupported", policy: "unverified", reason: "Registered role TOML is missing" };
      const parsedRole = parseDocument(state.text);
      const model = typeof parsedRole.model === "string" ? parsedRole.model : null;
      const policy = model === WEB_AGENT_MODEL ? "web-only" : model ? "violated" : "unverified";
      const lastApplied = manifest?.files[configFile];
      return { ...base, model,
        reasoningEffort: typeof parsedRole.model_reasoning_effort === "string" ? parsedRole.model_reasoning_effort : null,
        sandboxMode: typeof parsedRole.sandbox_mode === "string" ? parsedRole.sandbox_mode : null,
        developerInstructions: typeof parsedRole.developer_instructions === "string" ? parsedRole.developer_instructions : null,
        status: policy === "violated" ? "unsupported" : lastApplied ? lastApplied === state.sha256 ? "managed" : "externally-changed" : "imported",
        policy,
      };
    } catch (error) {
      return { ...base, model: null, reasoningEffort: null, sandboxMode: null, developerInstructions: null,
        status: "unsupported", policy: "unverified", reason: error instanceof AgentConfigError ? error.message : "Could not read role TOML" };
    }
  });
  const managedConfig = manifest?.files[source.path];
  return { codexHome: home, configPath: source.path, configExists: source.exists,
    configStatus: managedConfig ? managedConfig === source.sha256 ? "managed" : "externally-changed" : "unmanaged",
    maxConcurrentThreadsPerSession: typeof (limit ?? alias) === "number" ? (limit ?? alias) as number : null,
    threadLimitKey: key, roles, pendingRecovery: readJournal(home) !== null,
    whitelistEnforcement: "unverified", activation: "new-session-required" };
}

export function previewAgentConfiguration(options: AgentHomeOptions, request: AgentConfigurationRequest): AgentConfigurationPreview {
  const home = rootFrom(options);
  if (readJournal(home)) throw new AgentConfigError("RECOVERY_REQUIRED", "Recover the pending agent transaction before preview");
  const validated = validateRequest(request);
  return toPreview(home, validated, makePlan(home, validated));
}

function ensureMetaDir(home: string): void {
  const { dir } = metadata(home);
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  const mode = lstatSync(dir).mode;
  if (!lstatSync(dir).isDirectory() || (mode & 0o077) !== 0) {
    throw new AgentConfigError("UNSUPPORTED", "Private agent manager directory must have 0700 permissions");
  }
}
function atomicPrivate(path: string, data: string, mode: number, precondition?: { home: string; sha256: string | null }): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", mode);
    fchmodSync(fd, mode);
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    if (precondition && !compare(precondition.home, path, precondition.sha256)) {
      throw new AgentConfigError("CONFLICT", "Agent config changed externally during atomic write preparation");
    }
    renameSync(temp, path);
    const parent = openSync(dirname(path), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) rmSync(temp);
  }
}
function compare(home: string, path: string, digest: string | null): boolean {
  return snapshot(home, path).sha256 === digest;
}
function acquireLock(home: string): () => void {
  ensureMetaDir(home);
  const { lockPath } = metadata(home);
  let fd: number | undefined;
  try { fd = openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Permit recovery after a crashed process. Never unlink a lock held by a live or
    // unidentifiable process; native EEXIST remains the cross-process lock authority.
    const stat = lstatSync(lockPath);
    if (!stat.isFile() || stat.nlink !== 1) throw new AgentConfigError("RECOVERY_REQUIRED", "Unsafe agent manager lock");
    const pidText = readFileSync(lockPath, "utf8").trim();
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid < 1) throw new AgentConfigError("RECOVERY_REQUIRED", "Agent manager lock has no valid owner");
    try { process.kill(pid, 0); }
    catch (checkError) {
      if ((checkError as NodeJS.ErrnoException).code === "ESRCH") {
        const latest = lstatSync(lockPath);
        if (latest.ino !== stat.ino || latest.dev !== stat.dev) throw new AgentConfigError("CONFLICT", "Agent manager lock changed");
        rmSync(lockPath);
        try { fd = openSync(lockPath, "wx", 0o600); }
        catch { throw new AgentConfigError("RECOVERY_REQUIRED", "Agent manager lock was acquired concurrently"); }
      } else throw new AgentConfigError("RECOVERY_REQUIRED", "Agent manager transaction is locked");
    }
    if (fd === undefined) throw new AgentConfigError("RECOVERY_REQUIRED", "Agent manager transaction is locked");
  }
  if (fd === undefined) throw new AgentConfigError("RECOVERY_REQUIRED", "Agent manager transaction is locked");
  const owner = fstatSync(fd);
  try { writeFileSync(fd, `${process.pid}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  return () => {
    // Do not remove another process's lock if an external actor replaced ours.
    try {
      const now = lstatSync(lockPath);
      if (now.ino === owner.ino && now.dev === owner.dev) rmSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}
function restoreJournal(home: string, journal: RecoveryJournal): "rolled-back" | "committed" {
  const manifest = readManifest(home);
  const matchesBeforeOrAfter = journal.entries.map(entry => {
    const current = snapshot(home, entry.path).sha256;
    if (current !== entry.beforeHash && current !== entry.afterHash) {
      throw new AgentConfigError("CONFLICT", "Config changed externally during an incomplete transaction; refusing rollback");
    }
    return current === entry.afterHash;
  });
  if (manifest?.transactionId === journal.transactionId && matchesBeforeOrAfter.every(Boolean)) {
    rmSync(metadata(home).journalPath);
    return "committed";
  }
  for (let i = journal.entries.length - 1; i >= 0; i--) {
    const entry = journal.entries[i];
    if (!matchesBeforeOrAfter[i] || entry.beforeHash === entry.afterHash) continue;
    if (!compare(home, entry.path, entry.afterHash)) {
      throw new AgentConfigError("CONFLICT", "Config changed during rollback; recovery journal retained");
    }
    if (entry.beforeText === null) rmSync(entry.path);
    else atomicPrivate(entry.path, entry.beforeText, entry.mode, { home, sha256: entry.afterHash });
  }
  rmSync(metadata(home).journalPath);
  return "rolled-back";
}

/** Recovers an incomplete transaction; never restores a participant that diverged externally. */
export function recoverAgentConfiguration(options: AgentHomeOptions): "nothing-to-recover" | "rolled-back" | "committed" {
  const home = rootFrom(options);
  const release = acquireLock(home);
  try {
    const journal = readJournal(home);
    return journal ? restoreJournal(home, journal) : "nothing-to-recover";
  } finally { release(); }
}

/** Apply a portable preview across IPC/processes. The preview is advisory: all edits are reconstructed. */
export function applyAgentConfiguration(options: AgentHomeOptions, preview: AgentConfigurationPreview): AgentConfigurationApplyResult {
  const home = rootFrom(options);
  if (!preview || typeof preview !== "object" || preview.version !== 1 || preview.codexHome !== home) {
    throw new AgentConfigError("INVALID", "Invalid or cross-profile agent preview");
  }
  const release = acquireLock(home);
  let transactionId: string | null = null;
  try {
    if (readJournal(home)) throw new AgentConfigError("RECOVERY_REQUIRED", "Pending agent transaction must be recovered before Apply");
    const request = validateRequest(preview.request);
    const plan = makePlan(home, request);
    const latest = toPreview(home, request, plan);
    if (stableJSON(preview) !== stableJSON(latest) || preview.id !== latest.id) {
      throw new AgentConfigError("CONFLICT", "Agent preview is stale or modified; regenerate preview before Apply");
    }
    if (!plan.length) return { applied: false, changedFiles: [], transactionId: null, activation: "new-session-required" };
    const { manifestPath, journalPath } = metadata(home);
    const manifestBefore = snapshot(home, manifestPath);
    const previous = readManifest(home);
    if (snapshot(home, manifestPath).sha256 !== manifestBefore.sha256) {
      throw new AgentConfigError("CONFLICT", "Agent manager ownership metadata changed while preparing Apply");
    }
    transactionId = randomUUID();
    const manifest: Manifest = { version: 1, transactionId, templateVersion: AGENT_TEMPLATE_VERSION,
      files: { ...previous?.files, ...Object.fromEntries(plan.map(item => [item.before.path, hash(item.after)])) } };
    const manifestAfter = JSON.stringify(manifest);
    const journal: RecoveryJournal = { version: 1, codexHome: home, transactionId,
      entries: [
        ...plan.map(({ before, after }) => ({ path: before.path, beforeText: before.exists ? before.text : null,
          afterText: after, beforeHash: before.sha256, afterHash: hash(after), mode: before.mode })),
        { path: manifestPath, beforeText: manifestBefore.exists ? manifestBefore.text : null,
          afterText: manifestAfter, beforeHash: manifestBefore.sha256, afterHash: hash(manifestAfter), mode: 0o600 },
      ] };
    atomicPrivate(journalPath, JSON.stringify(journal), 0o600);
    try {
      for (const entry of journal.entries) {
        if (!compare(home, entry.path, entry.beforeHash)) {
          throw new AgentConfigError("CONFLICT", "Config changed externally after preview; transaction interrupted");
        }
        const parent = dirname(entry.path);
        if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
        safeParents(home, entry.path);
        atomicPrivate(entry.path, entry.afterText, entry.mode, { home, sha256: entry.beforeHash });
        if (!compare(home, entry.path, entry.afterHash)) throw new AgentConfigError("IO", "Written agent config failed hash verification");
        if (entry.path !== manifestPath) parseDocument(snapshot(home, entry.path).text);
      }
      rmSync(journalPath);
      return { applied: true, changedFiles: plan.map(e => e.before.path), transactionId, activation: "new-session-required" };
    } catch (error) {
      try { restoreJournal(home, journal); }
      catch (rollbackError) {
        throw new AgentConfigError("RECOVERY_REQUIRED", `Transaction needs recovery: ${rollbackError instanceof AgentConfigError ? rollbackError.message : "rollback failed"}`);
      }
      throw error;
    }
  } finally { release(); }
}
