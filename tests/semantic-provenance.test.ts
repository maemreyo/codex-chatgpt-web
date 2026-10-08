import { expect, test } from "bun:test";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { parseRequest } from "../src/responses/parser";
import {
  expandPreviousResponseInput,
  rememberResponseState,
} from "../src/responses/state";
import {
  classifySemanticArtifactToolCall,
  extractSemanticArtifactLedger,
  semanticCoveredHistoryDigest,
  semanticMaskToolResult,
  semanticMessageRefs,
  semanticPinnedMessageRefs,
} from "../src/responses/semantic-provenance";
import type { CodexAssistantMessage, CodexToolResultMessage } from "../src/types";

const turn = (turnId: string) => ({ internal_chat_message_metadata_passthrough: { turn_id: turnId } });

function body(input: unknown[]) {
  return { model: CHATGPT_WEB_MODEL_ID, input, reasoning: { effort: "high" } };
}

test("semantic provenance maps zero/one/many raw items without text-based identity", () => {
  const parsed = parseRequest(body([
    { type: "message", role: "developer", content: "same text", ...turn("turn_old") },
    { type: "additional_tools", tools: [] },
    { type: "reasoning", id: "rs_1", summary: [{ text: "thinking" }], ...turn("turn_old") },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "codex_exec", arguments: "{\"cmd\":\"bun test unit\"}", ...turn("turn_old") },
    { type: "function_call_output", call_id: "call_1", output: "ok", ...turn("turn_old") },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "duplicate" }], ...turn("turn_old") },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "duplicate" }], ...turn("turn_old") },
    { type: "tool_search_call", call_id: "search_1", arguments: { query: "agents" }, ...turn("turn_old") },
    { type: "tool_search_output", call_id: "search_1", status: "completed", tools: [], ...turn("turn_old") },
    { type: "agent_message", id: "amsg_1", author: "/root", recipient: "/root/reviewer", content: "review", ...turn("turn_old") },
    {
      type: "message", role: "user", content: "skill body",
      internal_chat_message_metadata_passthrough: {
        turn_id: "turn_old",
        content_item_kinds: ["skills.selected_skill_instructions"],
      },
    },
    { type: "message", role: "user", content: "continue", ...turn("turn_now") },
  ]));

  const provenance = parsed._semanticProvenance!;
  expect(provenance.items).toHaveLength(12);
  expect(provenance.messageSourceRefs.flat()).not.toContain(provenance.items[1]!.ref);

  const toolAssistantIndex = parsed.context.messages.findIndex(message =>
    message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === "call_1")
  );
  expect(semanticMessageRefs(parsed, toolAssistantIndex)).toEqual([
    provenance.items[2]!.ref,
    provenance.items[3]!.ref,
  ]);

  const duplicateAssistantIndices = parsed.context.messages.flatMap((message, index) =>
    message.role === "assistant" && message.content.some(part => part.type === "text" && part.text === "duplicate")
      ? [index] : []
  );
  expect(duplicateAssistantIndices).toHaveLength(2);
  expect(semanticMessageRefs(parsed, duplicateAssistantIndices[0]!)[0])
    .not.toBe(semanticMessageRefs(parsed, duplicateAssistantIndices[1]!)[0]);

  const searchAssistantIndex = parsed.context.messages.findIndex(message =>
    message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === "search_1")
  );
  expect(semanticMessageRefs(parsed, searchAssistantIndex)).toContain(provenance.items[7]!.ref);
  const agentIndex = parsed.context.messages.findIndex(message => message.role === "agentMessage");
  expect(semanticMessageRefs(parsed, agentIndex)).toEqual([provenance.items[9]!.ref]);

  const pins = semanticPinnedMessageRefs(parsed);
  expect(pins).toContain(provenance.items[0]!.ref);
  expect(pins).toContain(provenance.items[10]!.ref);
  expect(parsed.context.messages.find(message => message.role === "user" && message.origin === "codex_skill"))
    .toBeDefined();
});

test("covered refs and digest are replay-stable but bind every earlier canonical item", () => {
  const prefix = [
    { type: "message", role: "developer", content: "policy", ...turn("turn_1") },
    { type: "function_call", call_id: "call_a", name: "codex_exec", arguments: "{\"cmd\":\"echo ok\"}", ...turn("turn_1") },
  ];
  const output = [
    { type: "function_call_output", call_id: "call_a", output: "first result", ...turn("turn_1") },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }], ...turn("turn_1") },
  ];
  const suffix = [{ type: "message", role: "user", content: "next", ...turn("turn_2") }];
  const base = body(prefix);
  rememberResponseState(base, { id: "resp_semantic_replay", output, status: "completed" });
  const replayBody = expandPreviousResponseInput({
    model: CHATGPT_WEB_MODEL_ID,
    previous_response_id: "resp_semantic_replay",
    input: suffix,
  });
  const replay = parseRequest(replayBody);
  const full = parseRequest(body([...prefix, ...output, ...suffix]));

  expect(replay._replayPrefixLen).toBe(prefix.length + output.length);
  expect(replay._semanticProvenance!.items.map(item => item.ref))
    .toEqual(full._semanticProvenance!.items.map(item => item.ref));
  const anchor = full._semanticProvenance!.items[3]!.ref;
  expect(semanticCoveredHistoryDigest(replay._semanticProvenance!, anchor))
    .toBe(semanticCoveredHistoryDigest(full._semanticProvenance!, anchor));

  const changed = parseRequest(body([
    ...prefix,
    { ...output[0] as Record<string, unknown>, output: "changed result" },
    output[1],
    ...suffix,
  ]));
  expect(changed._semanticProvenance!.items[3]!.ref).toBe(anchor);
  expect(semanticCoveredHistoryDigest(changed._semanticProvenance!, anchor))
    .not.toBe(semanticCoveredHistoryDigest(full._semanticProvenance!, anchor));
});

test("Tier 0 masking is deterministic and retains only bounded failure evidence", () => {
  const success: CodexToolResultMessage = {
    role: "toolResult", toolCallId: "ok", toolName: "codex_exec",
    content: `secret-success-body ${"x".repeat(2000)}`, isError: false, timestamp: 1,
  };
  const maskedSuccess = semanticMaskToolResult(success, "ci1_success_1");
  expect(maskedSuccess.message.content).not.toContain("secret-success-body");
  expect(maskedSuccess.message.content).toContain("excerpt=none");
  expect(semanticMaskToolResult(success, "ci1_success_1")).toEqual(maskedSuccess);

  const failure: CodexToolResultMessage = {
    role: "toolResult", toolCallId: "bad", toolName: "codex_exec",
    content: `HEAD-MARKER ${"y".repeat(500)} Process exited with code 1 FAIL test_x ${"z".repeat(500)} TAIL-MARKER`,
    isError: false, timestamp: 1,
  };
  const maskedFailure = semanticMaskToolResult(failure, "ci1_failure_1");
  expect(maskedFailure.failed).toBe(true);
  expect(maskedFailure.exit).toBe(1);
  expect(maskedFailure.message.content).toContain("HEAD-MARKER");
  expect(maskedFailure.message.content).toContain("TAIL-MARKER");
  expect((maskedFailure.message.content as string).length).toBeLessThan(700);
});

test("artifact ledger records digests/paths/outcomes without storing command or output bodies", () => {
  const parsed = parseRequest(body([
    { type: "function_call", call_id: "test_call", name: "codex_exec", arguments: "{\"cmd\":\"bun test tests/a.test.ts\"}", ...turn("turn_1") },
    { type: "function_call_output", call_id: "test_call", output: "Process exited with code 1\nFAIL secret-output", ...turn("turn_1") },
    { type: "function_call", call_id: "patch_call", name: "codex_apply_patch", arguments: JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" }), ...turn("turn_1") },
    { type: "function_call_output", call_id: "patch_call", output: "patched", ...turn("turn_1") },
    { type: "function_call", call_id: "unknown_call", name: "mystery_tool", arguments: "{\"path\":\"/tmp/maybe\"}", ...turn("turn_1") },
    { type: "function_call_output", call_id: "unknown_call", output: "mystery-output", ...turn("turn_1") },
  ]));
  const anchor = parsed._semanticProvenance!.items.at(-1)!.ref;
  const ledger = extractSemanticArtifactLedger(parsed, anchor);
  expect(ledger.commands).toHaveLength(1);
  expect(ledger.commands[0]).toMatchObject({ exit: 1, failed: true });
  expect(ledger.commands[0]!.commandDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(ledger.testOutcomes).toEqual([{ ref: parsed._semanticProvenance!.items[0]!.ref, failed: true, excerptRef: parsed._semanticProvenance!.items[1]!.ref }]);
  expect(ledger.filesTouched).toContainEqual({ path: "src/a.ts", op: "write", ref: parsed._semanticProvenance!.items[2]!.ref });
  expect(ledger.filesTouched).toContainEqual({ path: "/tmp/maybe", op: "unknown", ref: parsed._semanticProvenance!.items[4]!.ref });
  expect(JSON.stringify(ledger)).not.toContain("bun test tests/a.test.ts");
  expect(JSON.stringify(ledger)).not.toContain("secret-output");
  expect(JSON.stringify(ledger)).not.toContain("mystery-output");

  const assistant = parsed.context.messages.find(message =>
    message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === "unknown_call")
  ) as CodexAssistantMessage;
  const unknown = assistant.content.find(part => part.type === "toolCall" && part.id === "unknown_call");
  expect(unknown && unknown.type === "toolCall" ? classifySemanticArtifactToolCall(unknown) : undefined)
    .toMatchObject({ kind: "file", op: "unknown" });
});
