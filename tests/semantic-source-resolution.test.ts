import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import {
  ChatGptTurnSessions, ChatGptTextFeed, ChatGptTraceFeed,
  chatGptInstructionLineage, chatGptCompactionSourceExecutionKey,
} from "../src/adapters/chatgpt-web/turn-execution";
import type { ChatGptTurnRuntime } from "../src/adapters/chatgpt-web/turn-execution";

test("canonical source lookup uses instruction identity when compactor effort differs", () => {
  const input = [
    { type: "message", role: "user", id: "source_message", content: "Verify source", internal_chat_message_metadata_passthrough: { turn_id: "source_turn" } },
  ];
  const base = {
    model: "chatgpt-web/gpt-5.6-sol", stream: true,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "source_thread", turn_id: "source_turn" }) },
    input,
  };
  const normal = parseRequest({ ...base, reasoning: { effort: "high" } });
  const compact = parseRequest({ ...base, reasoning: { effort: "medium" }, input: [...input, { type: "compaction_trigger" }] });
  expect(compact._compactionRequest).toBe(true);
  const sessions = new ChatGptTurnSessions();
  const runtime: ChatGptTurnRuntime = {
    mode: "read-only", browser: Promise.resolve("done"), physicalSettlement: Promise.resolve(),
    text: new ChatGptTextFeed(), trace: new ChatGptTraceFeed(),
    conversationKey: "exact_semantic_epoch_key", cancel() {},
  } as ChatGptTurnRuntime;
  const source = sessions.getOrCreate("source-key", () => runtime, "source-trace", "owner", "source_turn", "source_thread", chatGptInstructionLineage(normal).current);
  expect(sessions.find(chatGptCompactionSourceExecutionKey(compact))).toBeUndefined();
  expect(sessions.findExactCompactionSource(compact)).toBe(source);
  expect(sessions.findExactCompactionSource(compact)?.conversationKey()).toBe("exact_semantic_epoch_key");
  sessions.clear();
});

test("exact canonical compaction source remains identifiable after a newer retained head", () => {
  const identity = { thread_id: "shared-thread", turn_id: "original-turn" };
  const input = [{ type: "message", role: "user", id: "original-user", content: "Original task", internal_chat_message_metadata_passthrough: { turn_id: "original-turn" } }];
  const parsed = parseRequest({
    model: "chatgpt-web/gpt-5.6-sol",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(identity) },
    input: [...input, { type: "compaction_trigger" }],
  });
  const normal = parseRequest({
    model: "chatgpt-web/gpt-5.6-sol",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(identity) },
    input,
  });
  const sessions = new ChatGptTurnSessions();
  const runtime = (): ChatGptTurnRuntime => ({
    mode: "read-only", browser: new Promise<string>(() => {}),
    physicalSettlement: new Promise<void>(() => {}),
    text: new ChatGptTextFeed(), trace: new ChatGptTraceFeed(),
    conversationKey: "shared-epoch", cancel() {},
  });
  const original = sessions.getOrCreate("original-key", runtime, "trace-original", "owner", "original-turn", "shared-thread", chatGptInstructionLineage(normal).current);
  const newer = sessions.getOrCreate("newer-key", runtime, "trace-new", "owner", "next-turn", "shared-thread", "new-instruction");
  expect(sessions.findConversationHead("shared-epoch")).toBe(newer);
  expect(sessions.findExactCompactionSource(parsed)).toBe(original);
  sessions.getOrCreate("ambiguous-key", runtime, "trace-ambiguous", "owner", "original-turn", "shared-thread", chatGptInstructionLineage(normal).current);
  expect(() => sessions.findExactCompactionSource(parsed)).toThrow("multiple browser sessions");
  sessions.clear();
});
