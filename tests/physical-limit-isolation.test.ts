import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Browser enforcement must read the physical limits. The logical resolver is the Codex-facing seam
// and may later diverge from them, so only these consumers may call it.
const LOGICAL_RESOLVER_CALLERS = new Set([
  "src/chatgpt-web-models.ts", // definition only; asserted below
  "src/model-catalog.ts",
  "src/dev-chat/driver.ts",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

test("only Codex-facing consumers call the logical context resolver", () => {
  const root = join(import.meta.dir, "..");
  const callers = sourceFiles(join(root, "src"))
    .filter(path => /\bresolveChatGptWebContextLimits\s*\(/.test(readFileSync(path, "utf8")))
    .map(path => relative(root, path));
  expect(callers.filter(path => !LOGICAL_RESOLVER_CALLERS.has(path))).toEqual([]);
});

test("browser enforcement helpers in the models module do not call the logical resolver", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "chatgpt-web-models.ts"), "utf8");
  const calls = [...source.matchAll(/\bresolveChatGptWebContextLimits\s*\(/g)];
  // The single occurrence is the logical function's own declaration.
  expect(calls).toHaveLength(1);
  expect(source).toMatch(/export function resolveChatGptWebContextLimits\s*\(/);
});
