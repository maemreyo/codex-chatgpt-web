import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { responseRequest, compactRequest } from "../src/server";
import { rememberResponseState } from "../src/responses/state";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import type { CodexProviderConfig } from "../src/types";
import type { ProviderAdapter } from "../src/adapters/base";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

test("typed message-size throws retain their code instead of becoming native context exhaustion", async () => {
  for (const stream of [false, true]) {
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "chatgpt-web/high", stream, input: "Fixture" }),
    }), defaultConfig("full"), () => ({
      name: "typed-transport-error",
      async runTurn() {
        throw new ChatGptWebAdapterError("Message transport exceeded; model context window remains available.", {
          status: 400, errorType: "invalid_request_error", code: "chatgpt_message_too_large", retryable: false,
        });
      },
    }), { rememberState: false });
    const wire = await response.text();
    const failed = stream
      ? JSON.parse(wire.split("\n").find(line => line.startsWith('data: {"type":"response.failed"'))!.slice(6)).response
      : JSON.parse(wire);
    expect(failed).toMatchObject({ status: "failed", retryable: false,
      error: { code: "chatgpt_message_too_large" } });
    expect(failed.error.code).not.toBe("context_length_exceeded");
  }
});

const nativeModel = "gpt-6.1-sol";
const expectedSummary = "Verified compaction summary.";
const metadata = { thread_id: "s5_native_thread", turn_id: "s5_native_turn", request_kind: "compaction" };

function canonicalBody(protocol: "v1" | "v2" | "memento", stream = false) {
  const tagged = protocol === "memento"
    ? { ...metadata, compaction: { implementation: "responses", strategy: "memento" } }
    : metadata;
  return {
    model: nativeModel, stream, reasoning: { effort: "high" },
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(tagged) },
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Carry this exact task." }],
        internal_chat_message_metadata_passthrough: { turn_id: metadata.turn_id } },
      ...(protocol === "v2" ? [{ type: "compaction_trigger" }] : []),
    ],
  };
}

function browserFactory(providers: CodexProviderConfig[], observed: Array<{ family?: string; effort?: string; compact?: boolean }>) {
  return (provider: CodexProviderConfig): ProviderAdapter => {
    providers.push(provider);
    return {
      name: "s5-compaction-test",
      async runTurn(parsed, _incoming, emit) {
        observed.push({ family: parsed._chatgptModelFamily, effort: parsed.options.reasoning, compact: parsed._compactionRequest });
        expect(parsed.context.tools).toBeUndefined();
        expect(parsed.context.messages.at(-1)).toMatchObject({ role: "user" });
        emit({ type: "text_delta", text: expectedSummary, phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    };
  };
}

test("independently enabled Web compactor handles native v1, v2 and memento without native fetch", async () => {
  const config = defaultConfig("full");
  config.experimentalWebCompactor = true;
  config.experimentalSemanticMemory = false;
  const providers: CodexProviderConfig[] = [];
  const observed: Array<{ family?: string; effort?: string; compact?: boolean }> = [];
  let nativeCalls = 0;
  const options = { rememberState: false, fetchUpstream: async () => { nativeCalls += 1; throw new Error("native fetch must not run"); } };
  for (const protocol of ["v1", "v2", "memento"] as const) {
    for (const stream of protocol === "v1" ? [false] : [false, true]) {
      const body = canonicalBody(protocol, stream);
      const request = new Request(`http://127.0.0.1/v1/${protocol === "v1" ? "responses/compact" : "responses"}`, {
        method: "POST", body: JSON.stringify(body),
        headers: protocol === "v1" ? { "x-codex-turn-metadata": JSON.stringify(metadata) } : undefined,
      });
      const response = protocol === "v1"
        ? await compactRequest(request, config, browserFactory(providers, observed), options)
        : await responseRequest(request, config, browserFactory(providers, observed), options);
      expect(response.status).toBe(200);
      const wire = await response.text();
      const result = stream
        ? JSON.parse(wire.split("\n").find(line => line.startsWith('data: {"type":"response.completed"'))!.slice(6)).response
        : JSON.parse(wire);
      expect(result.output).toHaveLength(protocol === "v1" ? 2 : 1);
      if (protocol === "v1") expect(result.output.at(-1).content[0].text).toBe(`${SUMMARY_PREFIX}\n${expectedSummary}`);
      if (protocol === "v2") expect(result.output[0]).toMatchObject({ type: "compaction", encrypted_content: expect.stringMatching(/^ocx1:/) });
      if (protocol === "memento") expect(result.output[0]).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: expectedSummary }] });
    }
  }
  expect(nativeCalls).toBe(0);
  expect(providers).toHaveLength(5);
  expect(observed).toEqual(Array.from({ length: 5 }, () => ({ family: "5.6", effort: "medium", compact: true })));
});

test("compact endpoint owns canonical v1 classification even from v2 trigger and caller override fields", async () => {
  const config = defaultConfig("full");
  config.experimentalWebCompactor = true;
  const providers: CodexProviderConfig[] = [];
  const observed: Array<{ protocol?: string; compact?: boolean }> = [];
  const response = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST",
    body: JSON.stringify({
      ...canonicalBody("v2"),
      _canonicalCompactionProtocol: "memento",
    }),
  }), config, browserFactory(providers, observed as never));
  expect(response.status).toBe(200);
  const body = await response.json() as { output: Array<{ type: string }> };
  expect(body.output).toHaveLength(2);
  expect(body.output[1]?.type).toBe("message");
  expect(providers).toHaveLength(1);
});

test("native ordinary turns retain passthrough when dedicated compaction is enabled", async () => {
  const config = defaultConfig("full");
  config.experimentalWebCompactor = true;
  let fetches = 0;
  const original = { ...canonicalBody("v1"), client_metadata: {}, input: [{ role: "user", content: "Ordinary request" }] };
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify(original), headers: { authorization: "Bearer test-token" },
  });
  const response = await responseRequest(request, config, () => { throw new Error("browser must not run"); }, {
    fetchUpstream: async forwarded => {
      fetches += 1;
      expect(await forwarded.json()).toEqual(original);
      return Response.json({ output: [] });
    },
  });
  expect(response.status).toBe(200);
  expect(fetches).toBe(1);
});

test("local previous_response_id expands before native routing and strips Web-owned artifacts", async () => {
  const id = `resp_s5_local_${process.pid}_${Date.now()}`;
  rememberResponseState({ input: [{ type: "message", role: "user", content: "Prior source" }] }, {
    id, status: "completed",
    output: [{ type: "compaction", encrypted_content: encodeCompactionSummary("Earlier decision") }],
  }, { force: true });
  const raw = {
    model: nativeModel, previous_response_id: id,
    input: [{ type: "message", role: "user", content: "Follow up" }],
  };
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify(raw), headers: { authorization: "Bearer test-token" },
  }), defaultConfig("full"), undefined, {
    fetchUpstream: async forwarded => {
      const body = await forwarded.json() as { previous_response_id?: string; input: unknown[] };
      expect(body.previous_response_id).toBeUndefined();
      expect(body.input).toHaveLength(3);
      expect(JSON.stringify(body.input)).not.toContain("ocx1:");
      expect(JSON.stringify(body.input)).toContain("Earlier decision");
      expect(JSON.stringify(body.input)).toContain("Another language model started");
      return Response.json({ output: [] });
    },
  });
  expect(response.status).toBe(200);
});

test("unknown native previous_response_id remains upstream-owned", async () => {
  const raw = { model: nativeModel, previous_response_id: "resp_not_owned_by_bridge", input: "Native delta" };
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify(raw), headers: { authorization: "Bearer test-token" },
  }), defaultConfig("full"), undefined, { fetchUpstream: async forwarded => {
    expect(await forwarded.json()).toEqual(raw);
    return Response.json({ output: [] });
  } });
  expect(response.status).toBe(200);
});

test("terminal SEM recovery codes produce HTTP 409 for non-streaming clients", async () => {
  const config = defaultConfig("full");
  config.experimentalWebCompactor = true;
  for (const code of ["semantic_epoch_recovery_required", "semantic_atomic_result_too_large"] as const) {
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "chatgpt-web/high", stream: false,
        input: [{ role: "user", content: "Preserve this request" }],
      }),
    }), config, () => ({
      name: "terminal-recovery-fixture",
      async runTurn(_parsed, _incoming, emit) {
        emit({ type: "error", status: 409, errorType: "invalid_request_error", code,
          retryable: false, message: "Terminal physical recovery" });
      },
    }), { rememberState: false });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "failed", error: { code } });
  }
});

test("terminal SEM recovery codes propagate as failed SSE turns without a synthetic compaction", async () => {
  const config = defaultConfig("full");
  config.experimentalWebCompactor = true;
  for (const code of ["semantic_epoch_recovery_required", "semantic_atomic_result_too_large"] as const) {
    let calls = 0;
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "chatgpt-web/high", stream: true,
        input: [{ role: "user", content: "Do not replay the original tool result" }],
      }),
    }), config, () => ({
      name: "terminal-recovery-sse-fixture",
      async runTurn(_parsed, _incoming, emit) {
        calls++;
        emit({ type: "error", status: 409, errorType: "invalid_request_error", code,
          retryable: false, message: "Terminal physical recovery" });
      },
    }), { rememberState: false });
    expect(response.status).toBe(200); // Headers are already committed for SSE.
    const wire = await response.text();
    const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    expect(events.find(event => event.type === "response.failed")?.response).toMatchObject({
      status: "failed", retryable: false, error: { code, type: "invalid_request_error" },
    });
    expect(events.some(event => event.type === "response.completed" || event.type === "response.incomplete")).toBeFalse();
    expect(calls).toBe(1);
  }
});

for (const stream of [false, true]) {
  test(`active-turn tool-result pressure ${stream ? "SSE" : "JSON"} fails closed until explicit canonical compaction`, async () => {
    const config = defaultConfig("full");
    config.experimentalWebCompactor = true;
    config.experimentalSemanticMemory = true;
    const source = [
      { type: "message", role: "developer", content: "Preserve the original instructions." },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Finish the existing task." }],
        internal_chat_message_metadata_passthrough: { turn_id: "pressure_source_turn" } },
      { type: "function_call", call_id: "pressure_call_a", name: "exec_command", arguments: '{"cmd":"a"}' },
      { type: "function_call_output", call_id: "pressure_call_a", output: "Exact pending A" },
      { type: "function_call", call_id: "pressure_call_b", name: "exec_command", arguments: '{"cmd":"b"}' },
      { type: "function_call_output", call_id: "pressure_call_b", output: "Exact pending B" },
    ];
    const metadataFor = (turnId: string, kind: "turn" | "compaction") => ({
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "pressure_server_thread", turn_id: turnId, request_kind: kind }),
    });
    const ordinary = {
      model: "chatgpt-web/high", stream, input: source,
      client_metadata: metadataFor("pressure_source_turn", "turn"),
    };
    const observed: Array<{ compaction: boolean; input: unknown[]; model: string }> = [];
    let nativeCalls = 0;
    const adapter: ProviderAdapter = {
      name: "pressure-server-fixture",
      async runTurn(parsed, _incoming, emit) {
        const body = parsed._rawBody as { input: unknown[] };
        observed.push({ compaction: parsed._compactionRequest === true, input: structuredClone(body.input), model: parsed.modelId });
        if (!parsed._compactionRequest) {
          emit({ type: "error", status: 409, errorType: "invalid_request_error",
            code: "chatgpt_active_turn_compaction_required", retryable: false,
            message: "Canonical compaction is required before pending tool delivery." });
          return;
        }
        expect(parsed.context.tools).toBeUndefined();
        emit({ type: "text_delta", text: expectedSummary, phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    };
    const options = {
      rememberState: false,
      fetchUpstream: async () => { nativeCalls++; throw new Error("Unexpected native request"); },
    };
    const send = (body: unknown) => responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify(body),
    }), config, () => adapter, options);

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await send(ordinary);
      const wire = await response.text();
      if (stream) {
        expect(response.status).toBe(200); // SSE headers were already sent.
        const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
        const failure = events.find(event => event.type === "response.failed");
        expect(failure?.response).toMatchObject({ status: "failed", retryable: false,
          error: { type: "invalid_request_error", code: "chatgpt_active_turn_compaction_required" } });
        expect(events.some(event => event.type === "response.completed")).toBe(false);
      } else {
        expect(response.status).toBe(409);
        expect(JSON.parse(wire)).toMatchObject({ status: "failed",
          error: { type: "invalid_request_error", code: "chatgpt_active_turn_compaction_required" } });
      }
      expect(observed).toHaveLength(attempt + 1); // The server did not retry or compact itself.
      expect(observed.at(-1)).toMatchObject({ compaction: false, input: source });
      expect(ordinary.input).toEqual(source);
      expect(nativeCalls).toBe(0);
    }

    // Only a distinct Codex-issued compaction request may authorize settlement of this batch.
    const compact = await send({
      model: nativeModel, stream: false, reasoning: { effort: "high" },
      client_metadata: metadataFor("pressure_compaction_turn", "compaction"),
      input: [...source, { type: "compaction_trigger" }],
    });
    expect(compact.status).toBe(200);
    expect(await compact.json()).toMatchObject({ status: "completed", output: [{ type: "compaction" }] });
    expect(observed).toHaveLength(3);
    expect(observed[2]).toMatchObject({ compaction: true, model: "gpt-5.6-sol",
      input: [...source, { type: "compaction_trigger" }] });
    expect(nativeCalls).toBe(0);
  });
}
