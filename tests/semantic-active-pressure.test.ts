import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultConfig } from "../src/config";
import { decodeCompactionSummary } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import { rememberResponseState } from "../src/responses/state";
import { responseRequest } from "../src/server";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const threadId = "s8_active_pressure_thread";
const sourceTurnId = "s8_active_source";
const nativeModel = "gpt-6.1-sol";
const summary = "S8 canonical summary retains both exact tool results and the active task.";
const toolNames = ["exec_command", "exec_command"] as const;

function turnMetadata(turnId: string, compaction = false) {
  return { "x-codex-turn-metadata": JSON.stringify({
    thread_id: threadId, turn_id: turnId, request_kind: compaction ? "compaction" : "turn",
  }) };
}

function sourceRequest(input: unknown[], turnId = sourceTurnId): CodexParsedRequest {
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID, stream: true,
    reasoning: { effort: "high" },
    client_metadata: turnMetadata(turnId),
    tools: [{ type: "function", name: "exec_command", description: "Fake local tool", parameters: { type: "object" } }],
    input,
  });
  parsed._chatgptModelFamily = "5.6";
  return parsed;
}

function fixture(toolsOnFirst = false) {
  const dir = mkdtempSync(join(tmpdir(), "s8-active-pressure-"));
  const socketPath = join(dir, "broker.sock");
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `browser://s8-active-${dir}`,
    chatgptWeb: {
      browserHost: "launcher", browserHostDescriptorPath: join(dir, "launcher.json"),
      brokerSocketPath: socketPath, localToolsEnabled: true,
      solAvailable: true, extraHighAvailable: true, proAvailable: true,
      experimentalSemanticMemory: true,
      semanticCheckpointStatePath: join(dir, "epochs.json"),
    },
  };
  const broker = TurnBroker.forSocket(socketPath);
  const originalComplete = broker.completeTool.bind(broker);
  const delivered: Array<{ callId: string; result: BrokerToolResult }> = [];
  broker.completeTool = (token, callId, result) => {
    delivered.push({ callId, result });
    originalComplete(token, callId, result);
  };

  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const observed: Array<{ compaction: boolean; family?: string; effort?: string }> = [];
  let retainedHandoffs = 0;
  let toolSubmissions = 0;
  let completedInvocationResults: BrokerToolResult[] = [];
  let token = "";
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    observed.push({ compaction: turn.compaction === true, family: turn.modelFamily, effort: turn.reasoning });
    if (turn.compaction) {
      expect(turn.requireRetainedConversation).toBeTrue();
      retainedHandoffs += 1;
      const prepared = await turn.prepareResume!();
      const control = prepared.text.match(/turn_token (control_[a-f0-9]{32})/)?.[1];
      const handoffId = prepared.text.match(/handoff_id (handoff_[a-f0-9]{32})/)?.[1];
      prepared.release();
      if (!control || !handoffId) throw new Error("Missing bound canonical compaction handoff");
      await callTurnBroker(socketPath, {
        method: "submit_compaction_handoff", token: control, handoffId, summary,
      });
      return "Fake retained compaction acknowledged";
    }
    toolSubmissions += 1;
    if (toolsOnFirst && toolSubmissions === 1) await turn.onPreparedSelected?.(false);
    const prepared = await turn.prepare();
    if (toolSubmissions === 1 && !toolsOnFirst) {
      prepared.release();
      const answer = "S8 seed answer";
      turn.onTextDelta(answer);
      return answer;
    }
    token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1] ?? "";
    prepared.release();
    if (!token) throw new Error("Fake browser did not receive a broker token");
    await turn.onSubmitted?.();
    const claim = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const progress = turn.externalProgress;
    if (!progress) throw new Error("Fake tool browser has no external progress boundary");
    const previousBatch = progress.snapshot().lastToolBatchRevision;
    const invocations = toolNames.map((_, index) => callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke", bindingId: claim.bindingId, wireName: "exec_command",
      arguments: { cmd: `fake-tool-${index + 1}` },
    }, null));
    let snapshot = progress.snapshot();
    while (snapshot.lastToolBatchRevision <= previousBatch) {
      snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
    }
    await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
    completedInvocationResults = await Promise.all(invocations);
    const answer = "S8 original browser turn settled after canonical tool delivery";
    turn.onTextDelta(answer);
    return answer;
  };
  return {
    dir, provider, broker, observed, delivered,
    get token() { return token; },
    get retainedHandoffs() { return retainedHandoffs; },
    get toolSubmissions() { return toolSubmissions; },
    get completedInvocationResults() { return completedInvocationResults; },
    async close() {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      broker.completeTool = originalComplete;
      chatGptTurnSessions.clear();
      await broker.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test.each(["accumulated_occupancy", "unknown_occupancy"])("SEM continues the complete batch under advisory pressure: %s", async reason => {
  const f = fixture(true);
  try {
    const environment = `<environment_context><cwd>${f.dir}</cwd><filesystem><workspace_roots><root>${f.dir}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
    const canonical: unknown[] = [
      { type: "message", role: "developer", content: "Preserve all tool results" },
      { type: "message", role: "user", content: [{ type: "input_text", text: environment }],
        internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId } },
      { type: "message", role: "user", content: "First native tool task",
        internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId } },
    ];
    const adapter = createChatGptWebAdapter(f.provider);
    const first = sourceRequest(canonical);
    const firstEvents: AdapterEvent[] = [];
    await adapter.runTurn!(first, { headers: new Headers() }, event => firstEvents.push(event));
    const ids = firstEvents.filter((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> =>
      event.type === "tool_call_start").map(event => event.id);
    expect(ids).toHaveLength(2);
    const key = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
    const source = chatGptTurnSessions.find(key);
    const ledger = source?.runtime.semanticOccupancy;
    expect(ledger).toBeDefined();
    expect(source?.outstanding()).toHaveLength(2);
    if (!ledger) throw new Error("Missing first-turn canonical occupancy guard");
    expect(ledger.confidence).toBe("known");
    ledger.record("retained-pressure", ledger.physicalLimit - 12_000);
    if (reason === "unknown_occupancy") ledger.known = false;
    const complete = ids.flatMap((id, index) => [
      { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd: `fake-tool-${index + 1}` }) },
      { type: "function_call_output", call_id: id, output: `EXACT-FIRST-TURN-RESULT-${index}` },
    ]);
    const events: AdapterEvent[] = [];
    const config = defaultConfig("full");
    const oversized = complete.map(item => item.type === "function_call_output"
      ? { ...item, output: "word ".repeat(120_000) } : item);
    const atomic = adapter.preflightTurn!(sourceRequest([...canonical, ...oversized]));
    expect(atomic).toMatchObject({ code: "semantic_atomic_result_too_large", retryable: false });
    expect(f.delivered).toHaveLength(0);
    expect(source?.outstanding()).toHaveLength(2);
    expect(adapter.preflightTurn!(sourceRequest([...canonical, ...complete]))).toBeUndefined();
    for (const stream of [true, false]) {
      const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
        method: "POST", body: JSON.stringify({
          ...sourceRequest([...canonical, ...complete])._rawBody as object,
          model: "chatgpt-web/high", stream,
        }),
      }), config, () => adapter, { rememberState: false });
      expect(response.status).toBe(200);
      const wire = await response.text();
      expect(wire).toContain('"completed"');
      expect(wire).not.toContain("chatgpt_active_turn_compaction_required");
      expect(f.delivered.map(entry => entry.callId)).toEqual(ids);
      expect(source?.outstanding()).toHaveLength(0);
      expect(f.toolSubmissions).toBe(1);
    }
    await adapter.runTurn!(sourceRequest([...canonical, ...complete]), { headers: new Headers() }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
    expect(f.delivered.map(entry => entry.callId)).toEqual(ids);
  } finally {
    await f.close();
  }
});

test("S8: advisory pressure delivers once -> explicit Web compaction -> delta-only native continuation", async () => {
  const f = fixture();
  try {
    const environment = `<environment_context><cwd>${f.dir}</cwd><filesystem><workspace_roots><root>${f.dir}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
    const firstAuthority: unknown[] = [
      { type: "message", role: "developer", content: "S8-ORIGINAL-DEVELOPER-AUTHORITY" },
      { type: "message", role: "user", content: [{ type: "input_text", text: environment }],
        internal_chat_message_metadata_passthrough: { turn_id: "s8_seed" } },
      { type: "message", role: "user", id: "s8_seed_prompt", content: "S8-SEED-TURN",
        internal_chat_message_metadata_passthrough: { turn_id: "s8_seed" } },
    ];
    const adapter = createChatGptWebAdapter(f.provider);
    const seedEvents: AdapterEvent[] = [];
    await adapter.runTurn!(sourceRequest(firstAuthority, "s8_seed"), { headers: new Headers() },
      event => seedEvents.push(event));
    expect(seedEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
    const canonical: unknown[] = [
      ...firstAuthority,
      { type: "function_call", call_id: "s8_settled_seed_call", name: "exec_command", arguments: '{"cmd":"seed"}' },
      { type: "function_call_output", call_id: "s8_settled_seed_call",
        output: `S8-SETTLED-EVIDENCE ${"alpha beta gamma delta ".repeat(36_000)}` },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "S8 seed answer" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: environment }],
        internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId } },
      { type: "message", role: "user", id: "s8_active_prompt", content: "Finish the original two-tool task",
        internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId } },
    ];
    const first = sourceRequest(canonical);
    const firstEvents: AdapterEvent[] = [];
    await adapter.runTurn!(first, { headers: new Headers() }, event => firstEvents.push(event));
    expect(firstEvents.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
    const ids = firstEvents.filter((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> =>
      event.type === "tool_call_start").map(event => event.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(f.delivered).toHaveLength(0);

    const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
    const source = chatGptTurnSessions.find(sourceKey);
    expect(source?.outstanding().map(request => request.callId)).toEqual(ids);
    // A fake browser owns no Launcher descriptor to release on epoch retirement.
    if (source) source.runtime.releaseRetainedConversation = async () => {};
    const occupancy = source?.runtime.semanticOccupancy;
    if (!occupancy) throw new Error("Expected a semantic physical occupancy guard");
    occupancy.record("fake-already-retained-browser-epoch", occupancy.physicalLimit - 12_000);
    const completeBatch = ids.flatMap((id, index) => [
      { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd: `fake-tool-${index + 1}` }) },
      { type: "function_call_output", call_id: id, output: `S8-EXACT-RESULT-${index + 1} ${"alpha beta ".repeat(500)}` },
    ]);
    const fullCanonical = [...canonical, ...completeBatch];
    const active = sourceRequest(fullCanonical);
    expect(occupancy.canFitAtomicResults(completeBatch.filter((_, i) => i % 2 === 1)
      .map(item => ({ content: (item as { output: string }).output })))).toBeTrue();
    expect(occupancy.canDeliverBatch(completeBatch.filter((_, i) => i % 2 === 1)
      .map((item, i) => ({ callId: ids[i]!, content: (item as { output: string }).output })))).toBeFalse();
    const failed: AdapterEvent[] = [];
    await adapter.runTurn!(active, { headers: new Headers() }, event => failed.push(event));
    expect(failed.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
    expect(f.delivered.map(entry => entry.callId)).toEqual(ids);
    expect(source?.outstanding()).toHaveLength(0);

    const replay: AdapterEvent[] = [];
    await adapter.runTurn!(sourceRequest(fullCanonical), { headers: new Headers() }, event => replay.push(event));
    expect(replay).toEqual(failed);
    expect(f.toolSubmissions).toBe(2);
    expect(f.delivered.map(entry => entry.callId)).toEqual(ids);

    const config = defaultConfig("full");
    config.experimentalWebCompactor = true;
    config.experimentalSemanticMemory = true;
    const pressureResponse = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({
        ...active._rawBody as object, model: "chatgpt-web/high", stream: true,
      }),
    }), config, () => adapter, { rememberState: false });
    expect(pressureResponse.status).toBe(200);
    expect(await pressureResponse.text()).not.toContain("chatgpt_active_turn_compaction_required");
    expect(f.delivered.map(entry => entry.callId)).toEqual(ids);
    expect(source?.outstanding()).toHaveLength(0);
    const compactBody = {
      model: nativeModel, stream: false, reasoning: { effort: "high" },
      client_metadata: turnMetadata("s8_active_canonical_compact", true),
      input: [...fullCanonical, { type: "compaction_trigger" }],
    };
    let upstreamCalls = 0;
    const compactResponse = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify(compactBody),
    }), config, () => createChatGptWebAdapter(f.provider), {
      fetchUpstream: async () => { upstreamCalls += 1; throw new Error("Native must not compact"); },
    });
    expect(compactResponse.status).toBe(200);
    const compact = await compactResponse.json() as {
      id: string; status: string; output: Array<{ type: string; encrypted_content?: string }>;
    };
    expect(compact.status).toBe("completed");
    expect(compact.output).toHaveLength(1);
    expect(compact.output[0]?.type).toBe("compaction");
    expect(decodeCompactionSummary(compact.output[0]!.encrypted_content!)).toContain(summary);
    expect(upstreamCalls).toBe(0);
    expect(f.retainedHandoffs).toBe(1);
    expect(f.delivered.map(entry => entry.callId)).toEqual(ids);
    expect(f.completedInvocationResults.map(result => result.content[0])).toEqual(
      completeBatch.filter((_, i) => i % 2 === 1)
        .map(item => ({ type: "text", text: (item as { output: string }).output })),
    );
    expect(f.observed.at(-1)).toMatchObject({ compaction: true, family: "5.6", effort: "medium" });

    // Model the already-local previous_response_id ledger used by the native continuation.
    rememberResponseState(compactBody, compact, { force: true });
    const delta = { model: nativeModel, stream: false, previous_response_id: compact.id,
      input: [{ type: "message", role: "user", content: "Native model: continue the original task" }] };
    let forwardedBody: { model: string; previous_response_id?: string; input: unknown[] } | undefined;
    const continued = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify(delta), headers: { authorization: "Bearer fake" },
    }), config, () => { throw new Error("Native continuation must not use Web"); }, {
      fetchUpstream: async forwarded => {
        upstreamCalls += 1;
        forwardedBody = await forwarded.json() as { model: string; previous_response_id?: string; input: unknown[] };
        return Response.json({ id: "resp_native_s8_continued", output: [] });
      },
    });
    expect(continued.status).toBe(200);
    expect(forwardedBody?.model).toBe(nativeModel);
    expect(forwardedBody?.previous_response_id).toBeUndefined();
    expect(forwardedBody?.input.at(-1)).toMatchObject(delta.input[0]!);
    const history = JSON.stringify(forwardedBody?.input);
    expect(history).toContain(summary);
    expect(history).toContain("Native model: continue the original task");
    expect(history).not.toContain("ocx1:");
    expect(upstreamCalls).toBe(1);
    expect(f.delivered.map(entry => entry.callId)).toEqual(ids);
    expect(f.toolSubmissions).toBe(2);
  } finally {
    await f.close();
  }
}, 15_000);
