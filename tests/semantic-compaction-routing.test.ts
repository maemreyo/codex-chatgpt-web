import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { responseRequest, compactRequest } from "../src/server";
import { rememberResponseState } from "../src/responses/state";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import type { CodexProviderConfig } from "../src/types";
import type { ProviderAdapter } from "../src/adapters/base";

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
