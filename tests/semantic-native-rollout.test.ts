import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { verifiedCodexSemanticUserTurns } from "../src/adapters/chatgpt-web/codex-rollout-environment";
import { buildSemanticTier0Candidate } from "../src/adapters/chatgpt-web/semantic-projection";
import { parseRequest } from "../src/responses/parser";

const threadId = "01a12020-bbe6-7d00-9be9-21d8ca34c904";
const priorTurn = "01a12021-bbe6-7d00-9be9-21d8ca34c904";
const currentTurn = "01a12022-bbe6-7d00-9be9-21d8ca34c904";
const cwd = resolve(process.cwd());
const lineage = { threadId, sandboxType: "dangerFullAccess" as const, workspaceRoots: [cwd] };
const user = (id: string, text: string) => ({ type: "message", role: "user", id, content: [{ type: "input_text", text }] });
const original = user("msg_original", "Original instruction");
const current = user("msg_current", "Continue after the previous answer");
const previousAnswer = { type: "message", role: "assistant", id: "msg_answer", content: [{ type: "output_text", text: "Previous answer" }] };
const homes: string[] = [];

afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const codexHome = mkdtempSync(join(tmpdir(), "semantic-rollout-"));
  homes.push(codexHome);
  const path = join(codexHome, "sessions", "2026", "10", "09", `rollout-2026-10-09T17-06-18-${threadId}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  const stamped = (item: Record<string, unknown>, turnId: string) => ({
    type: "response_item", payload: { ...item, internal_chat_message_metadata_passthrough: { turn_id: turnId } },
  });
  const events = [
    { type: "session_meta", payload: { id: threadId, source: "vscode" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: priorTurn } },
    stamped(original, priorTurn),
    stamped(previousAnswer, priorTurn),
    { type: "event_msg", payload: { type: "task_complete", turn_id: priorTurn } },
    { type: "event_msg", payload: { type: "task_started", turn_id: currentTurn } },
    { type: "turn_context", payload: {
      turn_id: currentTurn, cwd, workspace_roots: [cwd],
      permission_profile: { type: "disabled" }, sandbox_policy: { type: "danger-full-access" },
    } },
    stamped(current, currentTurn),
  ];
  const write = (records: unknown[]) => writeFileSync(path, records.map(row => JSON.stringify(row)).join("\n") + "\n");
  write(events);
  const body = {
    model: "chatgpt-web/gpt-6-sol", stream: true,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: threadId, turn_id: currentTurn, request_kind: "turn",
    }) },
    input: [original, previousAnswer, current],
  };
  const parsed = parseRequest(body);
  parsed._chatgptModelFamily = "6";
  const items = parsed._semanticProvenance!.items
    .filter(item => item.role === "user" && item.itemId)
    .map(item => ({ itemId: item.itemId!, canonicalJson: item.canonicalJson }));
  return { codexHome, events, write, parsed, items };
}

test("exact native user records restore turn attribution while leaving canonical history intact", () => {
  const { codexHome, parsed, items } = fixture();
  const owners = verifiedCodexSemanticUserTurns({ codexHome, lineage, turnId: currentTurn, items });
  expect(owners?.get("msg_original")).toBe(priorTurn);
  expect(owners?.get("msg_current")).toBe(currentTurn);
  const before = JSON.stringify(parsed._rawBody);
  parsed._semanticProvenance!.items = parsed._semanticProvenance!.items.map(item => ({
    ...item, ...(item.itemId && owners?.has(item.itemId) ? { turnId: owners.get(item.itemId) } : {}),
  }));
  const result = buildSemanticTier0Candidate(parsed, "6", undefined);
  expect(result.candidate?.sourceTurnId).toBe(priorTurn);
  expect(result.candidate?.sourceAnswerHash).toBeDefined();
  expect(JSON.stringify(parsed._rawBody)).toBe(before);
});

test("a tampered or duplicated user message cannot receive native turn attribution", () => {
  const { codexHome, parsed, items } = fixture();
  expect(verifiedCodexSemanticUserTurns({ codexHome, lineage, turnId: currentTurn,
    items: [{ ...items[0]!, canonicalJson: items[0]!.canonicalJson.replace("Original", "Changed") }, items[1]!] })).toBeUndefined();
  expect(verifiedCodexSemanticUserTurns({ codexHome, lineage, turnId: currentTurn,
    items: [items[0]!, items[0]!] })).toBeUndefined();
  expect(verifiedCodexSemanticUserTurns({ codexHome, lineage, turnId: currentTurn,
    items: [items[1]!, items[0]!] })).toBeUndefined();
  expect(buildSemanticTier0Candidate(parsed, "6", undefined).reason).toBe("missing_turn_provenance");
});

test("incorrect native task ownership and missing records fail closed", () => {
  const { codexHome, events, write, items } = fixture();
  const altered = structuredClone(events);
  (altered[2] as { payload: { internal_chat_message_metadata_passthrough: { turn_id: string } } })
    .payload.internal_chat_message_metadata_passthrough.turn_id = currentTurn;
  write(altered);
  expect(verifiedCodexSemanticUserTurns({ codexHome, lineage, turnId: currentTurn, items })).toBeUndefined();
  write(events.filter(row => row.type !== "response_item"));
  expect(verifiedCodexSemanticUserTurns({ codexHome, lineage, turnId: currentTurn, items })).toBeUndefined();
});
