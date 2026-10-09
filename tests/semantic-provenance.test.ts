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
  renderSemanticArtifactLedger,
  semanticCoveredHistoryDigest,
  semanticHistoryItemHash,
  semanticMaskToolResult,
  semanticMessageRefs,
  semanticPinnedMessageRefs,
} from "../src/responses/semantic-provenance";
import { buildSemanticTier0Candidate, projectSemanticEpoch } from "../src/adapters/chatgpt-web/semantic-projection";
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

test("native replay metadata cannot invalidate a verified epoch but history mutations do", () => {
  const original = [
    { type: "additional_tools", role: "developer", id: "registry_first", tools: [{ type: "function", name: "tool", description: "live spec A", parameters: {} }] },
    { type: "message", role: "developer", content: "Keep policy", ...turn("turn_1") },
    { type: "message", role: "user", id: "user_first", content: "Run check", ...turn("turn_1") },
    { type: "reasoning", id: "thought", summary: [] },
    { type: "function_call", call_id: "check", name: "tool", arguments: "{}" },
    { type: "function_call_output", call_id: "check", output: "verified result" },
    { type: "message", role: "assistant", id: "answer_first", status: "completed", content: [{ type: "output_text", text: "Check complete", annotations: [] }] },
    { type: "message", role: "user", id: "user_second", content: "Continue", ...turn("turn_2") },
  ];
  const later = structuredClone(original) as Array<Record<string, any>>;
  later[0]!.id = "registry_second";
  later[0]!.tools[0]!.description = "live spec B";
  later[3]!.content = null;
  later[3]!.encrypted_content = null;
  delete later[6]!.status;
  delete later[6]!.content[0]!.annotations;

  const makeParsed = (input: unknown[]) => {
    const parsed = parseRequest({
      ...body(input),
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_semantic", turn_id: "turn_2" }) },
    });
    parsed._chatgptModelFamily = "5.6";
    return parsed;
  };
  const initial = makeParsed(original);
  const resumed = makeParsed(later);
  const initialAnchor = initial._semanticProvenance!.items[6]!.ref;
  expect(resumed._semanticProvenance!.items[6]!.ref).toBe(initialAnchor);
  expect(semanticHistoryItemHash(initial._semanticProvenance!.items[6]!.canonicalJson))
    .toBe(semanticHistoryItemHash(resumed._semanticProvenance!.items[6]!.canonicalJson));
  const firstEpoch = buildSemanticTier0Candidate(initial, "5.6", undefined, 1000).candidate!;
  expect(firstEpoch.digestPolicyVersion).toBe(3);
  expect(firstEpoch.coveredThroughRef).toBe(initialAnchor);
  expect(buildSemanticTier0Candidate(resumed, "5.6", undefined, 1001).candidate!.coveredHistoryDigest)
    .toBe(firstEpoch.coveredHistoryDigest);
  expect(projectSemanticEpoch(resumed, firstEpoch).parsed._rawBody).toBe(resumed._rawBody);
  expect(semanticCoveredHistoryDigest(initial._semanticProvenance!, initialAnchor, 1))
    .not.toBe(semanticCoveredHistoryDigest(resumed._semanticProvenance!, initialAnchor, 1));

  // The historical result remains exact, but a live tool name reusing a
  // different argument contract must invalidate the saved epoch.
  const rebound = structuredClone(later);
  rebound[0]!.tools[0]!.parameters = {
    type: "object", properties: { destructive: { type: "boolean" } }, required: ["destructive"],
  };
  const reboundRequest = makeParsed(rebound);
  expect(semanticCoveredHistoryDigest(reboundRequest._semanticProvenance!, initialAnchor, 2))
    .toBe(semanticCoveredHistoryDigest(resumed._semanticProvenance!, initialAnchor, 2));
  expect(semanticCoveredHistoryDigest(reboundRequest._semanticProvenance!, initialAnchor, 3))
    .not.toBe(firstEpoch.coveredHistoryDigest);
  expect(() => projectSemanticEpoch(reboundRequest, firstEpoch)).toThrow("digest mismatch");

  const retyped = structuredClone(later);
  retyped[0]!.tools[0]!.type = "custom";
  expect(() => projectSemanticEpoch(makeParsed(retyped), firstEpoch)).toThrow("digest mismatch");

  const unrelated = structuredClone(later);
  unrelated[0]!.tools.push({ type: "function", name: "another_tool", parameters: { type: "object" } });
  unrelated[0]!.tools.push(structuredClone(unrelated[0]!.tools[0]!));
  expect(semanticCoveredHistoryDigest(makeParsed(unrelated)._semanticProvenance!, initialAnchor, 3))
    .toBe(firstEpoch.coveredHistoryDigest);

  // Existing V2 tool-using epochs are readable but cannot be reused when
  // their live tool execution contracts were never bound to the digest.
  const v2 = {
    ...firstEpoch,
    digestPolicyVersion: 2 as const,
    coveredHistoryDigest: semanticCoveredHistoryDigest(initial._semanticProvenance!, initialAnchor, 2),
  };
  expect(() => projectSemanticEpoch(resumed, v2)).toThrow("v2 tool registry is not bound");

  const changed = (index: number, edit: (item: Record<string, any>) => void) => {
    const copy = structuredClone(later);
    edit(copy[index]!);
    const parsed = makeParsed(copy);
    // Changing the anchor itself removes its content-based ref. Every other
    // covered mutation must preserve the ref but invalidate the prefix digest.
    if (index === 6) {
      expect(parsed._semanticProvenance!.items[6]!.ref).not.toBe(initialAnchor);
      expect(() => projectSemanticEpoch(parsed, firstEpoch)).toThrow("anchor is missing");
    } else {
      expect(semanticCoveredHistoryDigest(parsed._semanticProvenance!, initialAnchor))
        .not.toBe(firstEpoch.coveredHistoryDigest);
      expect(() => projectSemanticEpoch(parsed, firstEpoch)).toThrow("digest mismatch");
    }
  };
  changed(1, item => { item.content = "Weaken policy"; });
  changed(2, item => { item.content = "Different request"; });
  changed(4, item => { item.arguments = '{"altered":true}'; });
  changed(5, item => { item.output = "tampered result"; });
  changed(6, item => { item.content[0].text = "Different answer"; });
});

test("digest v3 binds the schema of a historical namespaced tool call", () => {
  const input = (parameters: object) => [
    { type: "additional_tools", tools: [{ type: "namespace", name: "ops", tools: [
      { type: "function", name: "run", parameters },
    ] }] },
    { type: "function_call", call_id: "call_ops", namespace: "ops", name: "run", arguments: "{}" },
    { type: "function_call_output", call_id: "call_ops", output: "ok" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ];
  const original = parseRequest(body(input({ type: "object", properties: {} })));
  const changed = parseRequest(body(input({ type: "object", properties: { unsafe: { type: "boolean" } } })));
  const anchor = original._semanticProvenance!.items.at(-1)!.ref;
  expect(changed._semanticProvenance!.items.at(-1)!.ref).toBe(anchor);
  expect(semanticCoveredHistoryDigest(changed._semanticProvenance!, anchor))
    .not.toBe(semanticCoveredHistoryDigest(original._semanticProvenance!, anchor));
});

test("digest v3 binds top-level tool declarations used by covered history", () => {
  const input = [
    { type: "function_call", call_id: "call_top", name: "run", arguments: "{}" },
    { type: "function_call_output", call_id: "call_top", output: "ok" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ];
  const request = (parameters: object) => parseRequest({
    ...body(input),
    tools: [{ type: "function", name: "run", parameters }],
  });
  const original = request({ type: "object", properties: {} });
  const changed = request({ type: "object", properties: { newField: { type: "string" } } });
  const anchor = original._semanticProvenance!.items.at(-1)!.ref;
  expect(changed._semanticProvenance!.items.at(-1)!.ref).toBe(anchor);
  expect(semanticCoveredHistoryDigest(changed._semanticProvenance!, anchor))
    .not.toBe(semanticCoveredHistoryDigest(original._semanticProvenance!, anchor));
});

test("digest v3 retains schema properties named id when ignoring registry IDs", () => {
  const request = (property: object) => parseRequest(body([
    { type: "additional_tools", id: "volatile-registry-id", tools: [
      { type: "function", name: "run", parameters: { type: "object", properties: { id: property } } },
    ] },
    { type: "function_call", call_id: "call_id_field", name: "run", arguments: "{}" },
    { type: "function_call_output", call_id: "call_id_field", output: "ok" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ]));
  const original = request({ type: "string" });
  const changed = request({ type: "integer" });
  const anchor = original._semanticProvenance!.items.at(-1)!.ref;
  expect(semanticCoveredHistoryDigest(changed._semanticProvenance!, anchor))
    .not.toBe(semanticCoveredHistoryDigest(original._semanticProvenance!, anchor));
});

test("digest v3 binds an argument named description but ignores descriptive metadata", () => {
  const request = (property: object, humanDescription: string) => parseRequest(body([
    { type: "additional_tools", tools: [
      { type: "function", name: "run", description: humanDescription,
        parameters: { type: "object", description: humanDescription,
          properties: { description: property } } },
    ] },
    { type: "function_call", call_id: "call_description_field", name: "run", arguments: "{}" },
    { type: "function_call_output", call_id: "call_description_field", output: "ok" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ]));
  const original = request({ type: "string", description: "human guidance" }, "first wording");
  const changedType = request({ type: "integer", description: "different guidance" }, "other wording");
  const changedWords = request({ type: "string", description: "different guidance" }, "other wording");
  const anchor = original._semanticProvenance!.items.at(-1)!.ref;
  const digest = semanticCoveredHistoryDigest(original._semanticProvenance!, anchor);
  expect(semanticCoveredHistoryDigest(changedType._semanticProvenance!, anchor)).not.toBe(digest);
  expect(semanticCoveredHistoryDigest(changedWords._semanticProvenance!, anchor)).toBe(digest);
});

test("Tier 0 masking is deterministic and retains only bounded failure evidence", () => {
  const success: CodexToolResultMessage = {
    role: "toolResult", toolCallId: "ok", toolName: "codex_exec",
    content: `secret-success-body ${"x".repeat(2000)}`, isError: false, timestamp: 1,
  };
  const maskedSuccess = semanticMaskToolResult(success, "ci1_success_1");
  expect(maskedSuccess.message.content).not.toContain("secret-success-body");
  expect(maskedSuccess.message.content).toContain("excerpt=none");
  expect(maskedSuccess.message.content).toContain("outcome=unknown");
  expect(maskedSuccess.status).toBe("unknown");
  expect(semanticMaskToolResult(success, "ci1_success_1")).toEqual(maskedSuccess);

  const failure: CodexToolResultMessage = {
    role: "toolResult", toolCallId: "bad", toolName: "codex_exec",
    content: `HEAD-MARKER ${"y".repeat(500)} Process exited with code 1 FAIL test_x ${"z".repeat(500)} TAIL-MARKER`,
    isError: false, timestamp: 1,
  };
  const maskedFailure = semanticMaskToolResult(failure, "ci1_failure_1");
  expect(maskedFailure.failed).toBe(true);
  expect(maskedFailure.status).toBe("failure");
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
  expect(ledger.commands[0]).toMatchObject({ exit: 1, failed: true, status: "failure" });
  expect(ledger.commands[0]!.commandDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(ledger.testOutcomes).toEqual([{ ref: parsed._semanticProvenance!.items[0]!.ref, failed: true, status: "failure", excerptRef: parsed._semanticProvenance!.items[1]!.ref }]);
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

test("ledger never interprets missing or ambiguous command results as confirmed success", () => {
  const parsed = parseRequest(body([
    { type: "function_call", call_id: "missing", name: "codex_exec", arguments: '{"cmd":"bun test tests/missing.test.ts"}', ...turn("turn_1") },
    { type: "function_call", call_id: "unclear", name: "codex_exec", arguments: '{"cmd":"bun test tests/unclear.test.ts"}', ...turn("turn_1") },
    { type: "function_call_output", call_id: "unclear", output: "No terminal exit information", ...turn("turn_1") },
    { type: "function_call", call_id: "success", name: "codex_exec", arguments: '{"cmd":"bun test tests/success.test.ts"}', ...turn("turn_1") },
    { type: "function_call_output", call_id: "success", output: "Process exited with code 0", ...turn("turn_1") },
  ]));
  const ledger = extractSemanticArtifactLedger(parsed, parsed._semanticProvenance!.items.at(-1)!.ref);
  expect(ledger.commands.map(command => command.status)).toEqual(["unknown", "unknown", "success"]);
  expect(ledger.testOutcomes.map(test => test.status)).toEqual(["unknown", "unknown", "success"]);
  expect(ledger.testOutcomes.map(test => test.failed)).toEqual([false, false, false]);
  expect(renderSemanticArtifactLedger(ledger)).toContain("failed=false field alone does not prove success");
});

test("zero-failure summaries do not become false negative ledger outcomes", () => {
  const base: CodexToolResultMessage = {
    role: "toolResult", toolName: "codex_exec", toolCallId: "test_zero", timestamp: 0, isError: false,
    content: "22 pass\n0 fail\nProcess exited with code 0",
  };
  const success = semanticMaskToolResult(base, "ci1_zero_1");
  expect(success.status).toBe("success");
  expect(success.failed).toBeFalse();
  expect(success.message.content).toContain("outcome=exit 0");
  expect(semanticMaskToolResult({ ...base, content: "22 pass\n0 failed" }, "ci1_zero_2").status).toBe("unknown");
  expect(semanticMaskToolResult({ ...base, content: "1 failed, 21 passed" }, "ci1_failed_1").status).toBe("failure");
  expect(semanticMaskToolResult({ ...base, content: "(fail) test assertion" }, "ci1_failed_2").status).toBe("failure");
});
