import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { parseRequest } from "../src/responses/parser";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

test("SEM single-message epoch does not count multipart stages after an interrupted submission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sem-multipart-cost-"));
  const brokerSocketPath = join(dir, "broker.sock");
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `browser://cost-${dir}`,
    chatgptWeb: {
      browserHost: "launcher", browserHostDescriptorPath: join(dir, "launcher.json"),
      brokerSocketPath, localToolsEnabled: true, solAvailable: true,
      extraHighAvailable: true, proAvailable: false,
      experimentalSemanticMemory: true, experimentalBiggerContext: true,
      semanticCheckpointStatePath: join(dir, "epochs.json"),
    },
  };
  const request = (id: string, input: unknown[]): CodexParsedRequest => {
    const parsed = parseRequest({
      model: CHATGPT_WEB_MODEL_ID, stream: true, reasoning: { effort: "high" },
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: "multipart_cost_thread", turn_id: id, request_kind: "turn",
      }) }, input,
    });
    parsed._chatgptModelFamily = "6";
    return parsed;
  };
  const meta = (id: string) => ({ internal_chat_message_metadata_passthrough: { turn_id: id } });
  const environment = `<environment_context><cwd>${dir}</cwd><filesystem><workspace_roots><root>${dir}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
  const firstInput = [
    { type: "message", role: "developer", content: "Preserve exact authority" },
    { type: "message", role: "user", content: [{ type: "input_text", text: environment }], ...meta("cost_1") },
    { type: "message", role: "user", id: "cost_user_1", content: "Start", ...meta("cost_1") },
  ];
  const secondInput = [
    ...firstInput,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "First done" }] },
    // Keep the active suffix within one physical message so the cost test
    // exercises a committed SEM epoch, not canonical multipart fallback.
    ...Array.from({ length: 80 }, (_, index) => ({
      type: "message", role: "user", id: `cost_user_2_${index}`,
      content: `EXACT-${index} ${"alpha beta gamma delta ".repeat(90)}`,
      ...meta("cost_2"),
    })),
    { type: "message", role: "user", content: [{ type: "input_text", text: environment }], ...meta("cost_2") },
    { type: "message", role: "user", id: "cost_user_2_final", content: "Execute the long request", ...meta("cost_2") },
  ];
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const costs: Array<{ extraStageSubmissions: number }> = [];
  const info = spyOn(console, "info").mockImplementation((...values) => {
    for (const value of values) {
      if (typeof value === "string" && value.startsWith('{"event":"semantic_cost"')) {
        costs.push(JSON.parse(value));
      }
    }
  });
  let runs = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    runs += 1;
    const prepared = await turn.prepare();
    if (runs === 1) {
      prepared.release();
      turn.onTextDelta("First done");
      return "First done";
    }
    // An active SEM epoch is preflighted as one physical browser message.
    // Multipart staging belongs to the canonical Bigger Context fallback.
    expect(prepared.multipart).toBeUndefined();
    expect(turn.conversationKey).toBeTruthy();
    expect(turn.onMultipartStageSubmitted).toBeUndefined();
    prepared.release();
    await turn.onPreparedSelected?.(false);
    throw new Error("simulated interruption before browser acknowledgement");
  };
  try {
    const adapter = createChatGptWebAdapter(provider);
    await adapter.runTurn!(request("cost_1", firstInput), { headers: new Headers() }, () => {});
    try {
      await adapter.runTurn!(request("cost_2", secondInput), { headers: new Headers() }, () => {});
    } catch (error) {
      expect(String(error)).toContain("simulated interruption");
    }
    expect(runs).toBe(2);
    // No onSubmitted callback or completed browser response: the interrupted
    // full projection must not be counted as an accepted submission.
    expect(costs).toHaveLength(0);
  } finally {
    info.mockRestore();
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(brokerSocketPath).close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
