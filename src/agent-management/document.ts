import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";
import { AgentConfigError, WEB_AGENT_MODEL, type AgentRole, type RolePatch } from "./schema";
import { getAgentTemplate } from "./templates";

type Table = AST.TOMLTable;
type Entry = AST.TOMLKeyValue;
type Replace = { from: number; to: number; text: string };

export function parseDocument(text: string): Record<string, unknown> {
  try {
    const object = Bun.TOML.parse(text.replace(/\r\n?/g, "\n"));
    if (!object || typeof object !== "object") throw new Error("Invalid TOML");
    return object as Record<string, unknown>;
  } catch {
    // Parser exceptions may include raw secrets from the config file.
    throw new AgentConfigError("INVALID", "Codex TOML is malformed; no changes have been made");
  }
}

function syntax(text: string): AST.TOMLProgram {
  try { return parseTOML(text.replace(/\r(?!\n)/g, "\n"), { tomlVersion: "1.0" }); }
  catch { throw new AgentConfigError("INVALID", "Codex TOML syntax cannot be safely edited"); }
}
function same(parts: readonly unknown[], want: readonly string[]): boolean {
  return parts.length === want.length && parts.every((part, index) => part === want[index]);
}
function findTable(ast: AST.TOMLProgram, path: string[]): Table | undefined {
  const matches = ast.body[0].body.filter(node => node.type === "TOMLTable" && same(node.resolvedKey, path)) as Table[];
  if (matches.length > 1) throw new AgentConfigError("INVALID", "Duplicate native Codex TOML section");
  return matches[0];
}
function findEntry(entries: Entry[], key: string): Entry | undefined {
  const found = entries.filter(entry => same(getStaticTOMLValue(entry.key), [key]));
  if (found.length > 1) throw new AgentConfigError("INVALID", "Duplicate native Codex TOML assignment");
  return found[0];
}
function endOfSection(ast: AST.TOMLProgram, table: Table, text: string): number {
  const sections = ast.body[0].body.filter(node => node.type === "TOMLTable" && node.range[0] > table.range[0]);
  const next = sections[0];
  if (!next) return text.length;
  const line = text.lastIndexOf("\n", next.range[0] - 1);
  return line + 1;
}
function formatString(value: string): string { return JSON.stringify(value); }
function runEdits(text: string, edits: Replace[]): string {
  let output = text;
  const sorted = edits.sort((a, b) => b.from - a.from);
  for (const edit of sorted) {
    if (edit.from < 0 || edit.to < edit.from || edit.to > text.length) {
      throw new AgentConfigError("UNSUPPORTED", "TOML source range is unsupported");
    }
    output = output.slice(0, edit.from) + edit.text + output.slice(edit.to);
  }
  parseDocument(output);
  return output;
}
function newLine(text: string): string { return text.includes("\r\n") ? "\r\n" : "\n"; }
function insertion(text: string, at: number, line: string): string {
  const eol = newLine(text);
  return (at > 0 && !/[\r\n]/.test(text[at - 1]) ? eol : "") + line + eol;
}

/** Surgical updates only to a known scalar in a known TOML table. Other bytes stay unchanged. */
function patchScalars(text: string, tablePath: string[], fields: Record<string, string>, allowMissingTable: boolean): string {
  const ast = syntax(text);
  const table = tablePath.length ? findTable(ast, tablePath) : undefined;
  const roots = ast.body[0].body.filter(node => node.type === "TOMLKeyValue") as Entry[];
  if (tablePath.length && !table && !allowMissingTable) {
    throw new AgentConfigError("UNSUPPORTED", "Codex TOML uses an unsupported section layout");
  }
  const entries = table ? table.body : roots;
  const edits: Replace[] = [];
  const missing: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const entry = findEntry(entries, key);
    if (entry) {
      if (text.slice(...entry.value.range) !== value) {
        edits.push({ from: entry.value.range[0], to: entry.value.range[1], text: value });
      }
    } else {
      missing.push(`${key} = ${value}`);
    }
  }
  if (missing.length) {
    if (table) {
      const position = endOfSection(ast, table, text);
      edits.push({ from: position, to: position, text: insertion(text, position, missing.join(newLine(text))) });
    } else if (tablePath.length) {
      const eol = newLine(text);
      const prefix = text.length && !text.endsWith(eol) ? eol : "";
      edits.push({ from: text.length, to: text.length,
        text: `${prefix}${text.length ? eol : ""}[${tablePath.map(part => /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part)).join(".")}]${eol}${missing.join(eol)}${eol}` });
    } else {
      const firstTable = ast.body[0].body.find(node => node.type === "TOMLTable");
      const position = firstTable ? text.lastIndexOf("\n", firstTable.range[0] - 1) + 1 : text.length;
      edits.push({ from: position, to: position, text: insertion(text, position, missing.join(newLine(text))) });
    }
  }
  return runEdits(text, edits);
}

export function patchThreadLimit(text: string, max: number): string {
  const ast = syntax(text);
  const table = findTable(ast, ["agents"]);
  const alias = table ? findEntry(table.body, "max_threads") : undefined;
  const canonical = table ? findEntry(table.body, "max_concurrent_threads_per_session") : undefined;
  if (alias && canonical) throw new AgentConfigError("UNSUPPORTED", "Both native child-thread keys are present; resolve ambiguity before Apply");
  if (alias) {
    const value = text.slice(...alias.value.range);
    const keyRange = alias.key.range;
    return runEdits(text, [
      { from: keyRange[0], to: keyRange[1], text: "max_concurrent_threads_per_session" },
      ...(value === String(max) ? [] : [{ from: alias.value.range[0], to: alias.value.range[1], text: String(max) }]),
    ]);
  }
  if (!table) {
    const document = parseDocument(text);
    if (Object.hasOwn(document, "agents")) throw new AgentConfigError("UNSUPPORTED", "Inline agents table cannot be safely patched");
  }
  return patchScalars(text, ["agents"], { max_concurrent_threads_per_session: String(max) }, true);
}

export function appendRoleRegistration(text: string, role: AgentRole): string {
  const parsed = parseDocument(text);
  const agents = parsed.agents as Record<string, unknown> | undefined;
  if (agents && Object.hasOwn(agents, role)) throw new AgentConfigError("CONFLICT", "Role was registered externally");
  return patchScalars(text, ["agents", role], {
    description: formatString(getAgentTemplate(role).description),
    config_file: formatString(`agents/${role}.toml`),
  }, true);
}

/** Modifies only requested role fields; preserves other TOML entries and comments. */
export function patchRoleFile(text: string | null, role: AgentRole, patch: RolePatch): string {
  const template = getAgentTemplate(role);
  const existing = text === null ? null : parseDocument(text);
  if (existing && existing.model !== undefined && existing.model !== WEB_AGENT_MODEL && patch.model === undefined) {
    throw new AgentConfigError("UNSUPPORTED", "Existing role uses a nonapproved model; explicitly choose the Web model to migrate");
  }
  if (existing && existing.sandbox_mode === "danger-full-access" && patch.sandboxMode === undefined) {
    throw new AgentConfigError("UNSUPPORTED", "Existing role sandbox is broader than managed policy");
  }
  const keys: Record<string, string> = {};
  if (text === null) {
    keys.name = formatString(role);
    keys.description = formatString(template.description);
    keys.model = formatString(WEB_AGENT_MODEL);
    keys.model_reasoning_effort = formatString(patch.reasoningEffort ?? template.reasoningEffort);
    keys.sandbox_mode = formatString(patch.sandboxMode ?? template.sandboxMode);
    keys.approval_policy = formatString("never");
    keys.developer_instructions = formatString(patch.developerInstructions ?? template.developerInstructions);
  } else {
    if (patch.model) keys.model = formatString(WEB_AGENT_MODEL);
    if (patch.reasoningEffort) keys.model_reasoning_effort = formatString(patch.reasoningEffort);
    if (patch.sandboxMode) keys.sandbox_mode = formatString(patch.sandboxMode);
    if (patch.developerInstructions) keys.developer_instructions = formatString(patch.developerInstructions);
  }
  const output = text === null
    ? `# Zam managed role template v${template.version}; edits require explicit preview/apply.\n${patchScalars("", [], keys, true)}`
    : Object.keys(keys).length ? patchScalars(text, [], keys, true) : text;
  const value = parseDocument(output);
  if (value.model !== WEB_AGENT_MODEL) throw new AgentConfigError("UNSUPPORTED", "Managed role must use ChatGPT Web model");
  if (value.sandbox_mode !== undefined
    && !["read-only", role === "zam-builder" ? "workspace-write" : "read-only"].includes(value.sandbox_mode as string)) {
    throw new AgentConfigError("UNSUPPORTED", "Managed role sandbox exceeds role policy");
  }
  if (value.model_reasoning_effort !== undefined && !["medium", "high"].includes(value.model_reasoning_effort as string)) {
    throw new AgentConfigError("UNSUPPORTED", "Unsupported managed role reasoning effort");
  }
  return output;
}
