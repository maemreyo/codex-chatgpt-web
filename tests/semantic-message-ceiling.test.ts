import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemanticMessageCeilings } from "../src/adapters/chatgpt-web/semantic-message-ceiling";

const root = mkdtempSync(join(tmpdir(), "semantic-ceiling-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("rejection ceiling is durable, keyed by tier/effort and never automatically relaxed", () => {
  const path = join(root, "observations.json");
  const first = new SemanticMessageCeilings(path, "account-one");
  expect(first.observeRejection("sol", "high", "plus", 25_000)).toBe(20_904);
  expect(first.observeRejection("sol", "high", "plus", 30_000)).toBe(20_904);
  expect(first.observeRejection("sol", "high", "plus", 18_000)).toBe(13_904);
  const second = new SemanticMessageCeilings(path, "account-one");
  expect(second.ceiling("sol", "high", "plus")).toBe(13_904);
  expect(second.ceiling("sol", "medium", "plus")).toBeUndefined();
  expect(second.ceiling("sol", "high", "pro")).toBeUndefined();
  expect(new SemanticMessageCeilings(path, "account-two").ceiling("sol", "high", "plus")).toBeUndefined();
  expect(() => second.assertWithin("sol", "high", "plus", 13_905)).toThrow("observed");
  expect(() => second.assertWithin("sol", "high", "plus", 13_904)).not.toThrow();
  expect(JSON.stringify(JSON.parse(readFileSync(path, "utf8")))).not.toContain("account-one");
});

test("corrupt ceiling state fails closed without overwriting evidence", () => {
  const path = join(root, "corrupt.json");
  writeFileSync(path, "invalid-before-restart");
  const ceilings = new SemanticMessageCeilings(path, "account");
  expect(() => ceilings.ceiling("sol", "high", "plus")).toThrow("invalid");
  expect(readFileSync(path, "utf8")).toBe("invalid-before-restart");
});

test("failed durable rejection write poisons later semantic preflights", () => {
  const parent = join(root, "not-a-directory");
  writeFileSync(parent, "keep-existing-file");
  const ceilings = new SemanticMessageCeilings(join(parent, "ceilings.json"), "account");
  expect(() => ceilings.observeRejection("sol", "high", "plus", 25_000)).toThrow();
  expect(() => ceilings.assertWithin("sol", "high", "plus", 100)).toThrow(
    "could not be persisted",
  );
  expect(readFileSync(parent, "utf8")).toBe("keep-existing-file");
});
