import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactionTransactionStore } from "../src/adapters/chatgpt-web/compaction-transaction";
import { settleActiveZeroRiskCompactionSource } from "../src/adapters/chatgpt-web/compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker, type TurnBrokerOwner, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { parseRequest } from "../src/responses/parser";

test("checkpoint can read canonical source evidence after the native source is revoked", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-compaction-evidence-"));
  const broker = TurnBroker.forSocket(join(root, "broker.sock"));
  try {
    const turnToken = await broker.register({ cwd: root, roots: [root], writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" }, tools: [] });
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(broker.socketPath,
      { method: "claim", token: turnToken });
    const invoke = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke", bindingId, wireName: "exec_command", arguments: { cmd: "fixture" },
    }, null);
    void invoke.catch(() => {});
    const [call] = await broker.nextToolBatch(turnToken);
    const canonical = JSON.stringify([{ type: "text", text: "canonical content ".repeat(2_000) }]);
    broker.storeOversizedResult(turnToken, call!.callId, canonical);
    broker.completeTool(turnToken, call!.callId, { content: [{ type: "text", text: "reference" }] });
    await invoke;
    const saved = broker.snapshotOversizedResults(turnToken);
    expect(saved).toEqual([{ callId: call!.callId, canonical }]);
    broker.revoke(turnToken);
    await expect(callTurnBroker(broker.socketPath, {
      method: "read_oversized_result", bindingId, reference: call!.callId, offset: 0, length: 32,
    })).rejects.toThrow();

    const tx = await broker.beginCompactionTransaction("trace_compaction_evidence", 10_000);
    broker.attachCompactionEvidence(tx.token, tx.handoffId, saved);
    const chunk = await callTurnBroker<{ text: string; nextOffset: number; totalChars: number; sha256: string }>(
      broker.socketPath, { method: "read_compaction_evidence", token: tx.token,
        handoffId: tx.handoffId, reference: call!.callId, offset: 0, length: 8192 });
    expect(chunk.text).toBe(canonical.slice(0, 8192));
    expect(chunk.nextOffset).toBe(8192);
    expect(chunk.totalChars).toBe(canonical.length);
    expect(chunk.sha256).toHaveLength(64);
    await expect(callTurnBroker(broker.socketPath, {
      method: "read_compaction_evidence", token: tx.token, handoffId: "handoff_wrong",
      reference: call!.callId, offset: 0, length: 64,
    })).rejects.toThrow("invalid, expired, or consumed");
    await expect(callTurnBroker(broker.socketPath, {
      method: "read_compaction_evidence", token: tx.token, handoffId: tx.handoffId,
      reference: call!.callId, offset: 0, length: 8193,
    })).rejects.toThrow("range is invalid");
    broker.abortCompactionTransaction(tx.token);
    await expect(callTurnBroker(broker.socketPath, {
      method: "read_compaction_evidence", token: tx.token, handoffId: tx.handoffId,
      reference: call!.callId, offset: 0, length: 64,
    })).rejects.toThrow("invalid, expired, or consumed");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint evidence is rejected after summary acceptance", () => {
  const txs = new CompactionTransactionStore();
  const tx = txs.begin("trace", 10_000);
  txs.attachEvidence(tx.token, tx.handoffId, [{ callId: "call_one", canonical: "canonical" }]);
  expect(txs.readEvidence(tx.token, tx.handoffId, "call_one", 0, 9).text).toBe("canonical");
  txs.submit(tx.token, tx.handoffId, "summary");
  expect(() => txs.readEvidence(tx.token, tx.handoffId, "call_one", 0, 8))
    .toThrow("invalid, expired, or consumed");
  txs.close();
});

test("Zero Risk references a large canonical result without changing its request id or replaying tools", async () => {
  const requestId = "request_zero_risk_compaction";
  const original = "large canonical data ".repeat(2_000);
  const completed: Array<{ token: string; callId: string; result: BrokerToolResult }> = [];
  let reserved: Array<{ callId: string; canonical: string }> = [];
  let stores = 0;
  const broker = {
    async reserveOversizedResults(token: string, entries: Array<{ callId: string; canonical: string }>) {
      expect(token).toBe(requestId);
      reserved = entries;
    },
    async storeOversizedResult(token: string, callId: string, canonical: string) {
      expect(token).toBe(requestId);
      expect(reserved).toContainEqual({ callId, canonical });
      stores += 1;
      return callId;
    },
    async requestCompaction(token: string) { expect(token).toBe(requestId); return 0; },
    async completeTool(token: string, callId: string, result: BrokerToolResult) {
      completed.push({ token, callId, result });
    },
    revoke() {},
  } as unknown as TurnBrokerOwner;
  const source = new ChatGptTurnSession({
    mode: "tools", token: Promise.resolve(requestId),
    browser: Promise.resolve("checkpoint text"), physicalSettlement: Promise.resolve(),
    manualControl: { surfaceNonce: "nonce" },
    externalProgress: { recordToolResult() {} } as never,
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {},
  });
  source.setOutstanding([{ callId: "call_one", wireName: "exec_command", freeform: false }]);
  const parsed = parseRequest({
    model: "chatgpt-web/gpt-5.6-sol",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread", turn_id: "turn" }) },
    input: [
      { type: "message", role: "user", id: "message", content: "run", internal_chat_message_metadata_passthrough: { turn_id: "turn" } },
      { type: "function_call_output", call_id: "call_one", output: original },
      { type: "compaction_trigger" },
    ],
  });
  expect(await settleActiveZeroRiskCompactionSource(parsed, source, broker)).toBe("checkpoint text");
  expect(stores).toBe(1);
  expect(reserved).toEqual([{ callId: "call_one", canonical: JSON.stringify(original) }]);
  expect(completed).toHaveLength(1);
  expect(completed[0]!.token).toBe(requestId);
  expect(completed[0]!.callId).toBe("call_one");
  expect(JSON.stringify(completed[0]!.result)).toContain("codex_result_chunk");
  expect(JSON.stringify(completed[0]!.result)).toContain("same request_id");
  expect(JSON.stringify(completed[0]!.result)).not.toContain(original);
  expect(source.outstanding()).toHaveLength(0);
});
