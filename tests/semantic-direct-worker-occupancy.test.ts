import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { semanticEpochOccupancies } from "../src/adapters/chatgpt-web/semantic-occupancy";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { parseRequest } from "../src/responses/parser";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

test("direct managed worker recreation resets only retired execution occupancy and preserves reconnects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sem-direct-worker-"));
  const socketPath = join(dir, "broker.sock");
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://semantic-direct-worker",
    chatgptWeb: {
      browserHost: "managed-chrome",
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      experimentalSemanticMemory: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  const captured: Array<{ key: string; value: number | null; confidence: string }> = [];
  const environment = `<environment_context><cwd>${dir}</cwd><filesystem><workspace_roots><root>${dir}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
  const rawInput = [
    { type: "message", role: "user", id: "direct-env", content: [{ type: "input_text", text: environment }], internal_chat_message_metadata_passthrough: { turn_id: "direct-worker-thread:turn-1" } },
    { type: "message", role: "user", id: "direct-user-1", content: "direct occupancy regression fixture", internal_chat_message_metadata_passthrough: { turn_id: "direct-worker-thread:turn-1" } },
  ];
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    input: rawInput,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: "direct-worker-thread",
      turn_id: "direct-worker-thread:turn-1",
      request_kind: "turn",
    }) },
  }) as CodexParsedRequest;
  parsed._chatgptModelFamily = "5.6";
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const ledger = semanticEpochOccupancies.forConversation(`fresh:${turn.traceId}`, true, 40_000, turn.modelId);
    captured.push({ key: `fresh:${turn.traceId}`, value: ledger.value, confidence: ledger.confidence });
    const prepared = await turn.prepare();
    prepared.release();
    await turn.onSubmitted?.();
    turn.onTextDelta("ok");
    return "ok";
  };
  const executionKey = `${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`;
  try {
    const adapter = createChatGptWebAdapter(provider);
    await adapter.runTurn!(parsed, { headers: new Headers() }, () => {});

    expect(captured).toHaveLength(1);
    expect(captured[0]!.value).toBe(0);
    const firstLedgerKey = captured[0]!.key;
    const ledger = semanticEpochOccupancies.forConversation(firstLedgerKey, true, 40_000, parsed.modelId);
    ledger.record("large-native-result", 40_000);
    ledger.markRejected();
    const priorCharge = ledger.value;
    expect(priorCharge).toBeGreaterThanOrEqual(40_000);
    expect(ledger.confidence).toBe("unknown");

    // Exact reconnects replay the same round without a new worker or ledger reset.
    await adapter.runTurn!(parsed, { headers: new Headers() }, () => {});
    expect(captured).toHaveLength(1);
    expect(ledger.value).toBe(priorCharge);
    expect(ledger.confidence).toBe("unknown");

    await chatGptTurnSessions.retireAndWait(executionKey);
    await adapter.runTurn!(parsed, { headers: new Headers() }, () => {});

    expect(captured).toHaveLength(2);
    expect(captured[1]!.key).toBe(firstLedgerKey);
    expect(captured[1]!.value).toBe(0);
    expect(captured[1]!.confidence).toBe("known");
    expect(ledger.confidence).toBe("known");
    expect(ledger.value).toBeLessThan(40_000);

    // The same result ID must charge again on the recreated physical lease.
    ledger.record("large-native-result", 40_000);
    const newCharge = ledger.value;
    expect(newCharge).toBeGreaterThanOrEqual(40_000);

    await adapter.runTurn!(parsed, { headers: new Headers() }, () => {});
    expect(captured).toHaveLength(2);
    expect(ledger.value).toBe(newCharge);
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    try {
      await chatGptTurnSessions.retireAndWait(executionKey);
    } finally {
      try {
        await TurnBroker.forSocket(socketPath).close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});
