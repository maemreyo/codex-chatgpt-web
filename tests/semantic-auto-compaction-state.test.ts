import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { decodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { compactRequest, responseRequest } from "../src/server";

const nativeModel = "gpt-6.1-sol";
const summary = "S8 checkpoint: keep the original user decision and verified tool evidence.";

type Protocol = "v1" | "v2" | "memento";

function canonicalRequest(protocol: Protocol, stream: boolean) {
  const metadata = {
    thread_id: `s8_auto_${protocol}_${stream ? "sse" : "json"}`,
    turn_id: `s8_compact_${protocol}_${stream ? "sse" : "json"}`,
    request_kind: "compaction",
    ...(protocol === "memento" ? { compaction: { implementation: "responses", strategy: "memento" } } : {}),
  };
  return {
    body: {
      model: nativeModel,
      stream,
      store: false,
      reasoning: { effort: "high" },
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
      input: [
        { type: "message", role: "user", id: "s8_original_instruction",
          content: [{ type: "input_text", text: "S8-ORIGINAL-DECISION" }],
          internal_chat_message_metadata_passthrough: { turn_id: metadata.turn_id } },
        { type: "function_call_output", call_id: "s8_verified_tool", output: "S8-VERIFIED-TOOL-EVIDENCE" },
        ...(protocol === "v2" ? [{ type: "compaction_trigger" }] : []),
      ],
    },
    metadata,
  };
}

function fakeCompactor(observed: Array<{ model: string; effort?: string; compaction?: boolean }>): ProviderAdapter {
  return {
    name: "s8-fake-compactor",
    async runTurn(parsed, _incoming, emit) {
      observed.push({ model: parsed.modelId, effort: parsed.options.reasoning, compaction: parsed._compactionRequest });
      expect(parsed._chatgptModelFamily).toBe("5.6");
      expect(parsed.options.reasoning).toBe("medium");
      expect(parsed._compactionRequest).toBeTrue();
      expect(parsed.context.tools).toBeUndefined();
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  };
}

function completedSseResponse(wire: string): Record<string, unknown> {
  const line = wire.split("\n").find(part => part.startsWith('data: {"type":"response.completed"'));
  expect(line).toBeDefined();
  return (JSON.parse(line!.slice(6)) as { response: Record<string, unknown> }).response;
}

for (const protocol of ["v2", "memento"] as const) {
  for (const stream of [false, true]) {
    test(`S8 ${protocol} ${stream ? "SSE" : "JSON"}: server persists canonical compact response for native delta replay`, async () => {
      const config = defaultConfig("full");
      config.experimentalWebCompactor = true;
      const { body } = canonicalRequest(protocol, stream);
      const observed: Array<{ model: string; effort?: string; compaction?: boolean }> = [];
      let nativeFetches = 0;
      const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
        method: "POST", body: JSON.stringify(body),
      }), config, () => fakeCompactor(observed), {
        fetchUpstream: async () => { nativeFetches++; throw new Error("compaction must stay on Web"); },
      });
      expect(response.status).toBe(200);
      const completed = (stream ? completedSseResponse(await response.text()) : await response.json()) as {
        id?: string; status?: string; model?: string;
        output?: Array<{ type: string; role?: string; encrypted_content?: string; content?: Array<{ text: string }> }>;
      };
      expect(completed.id).toStartWith("resp_");
      expect(completed.status).toBe("completed");
      expect(completed.model).toBe(nativeModel);
      expect(completed.output).toHaveLength(1);
      if (protocol === "v2") {
        expect(completed.output![0]!.type).toBe("compaction");
        expect(decodeCompactionSummary(completed.output![0]!.encrypted_content!)).toBe(summary);
      } else {
        expect(completed.output![0]).toMatchObject({
          type: "message", role: "assistant", content: [{ type: "output_text", text: summary }],
        });
      }
      expect(nativeFetches).toBe(0);
      expect(observed).toHaveLength(1);

      const delta = {
        model: nativeModel, stream: false, store: false, previous_response_id: completed.id,
        input: [{ type: "message", role: "user", content: "S8-NATIVE-DELTA" }],
      };
      let forwarded: Record<string, unknown> | undefined;
      const continuation = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
        method: "POST", body: JSON.stringify(delta), headers: { authorization: "Bearer local-fixture" },
      }), config, () => { throw new Error("native continuation must not run Web"); }, {
        fetchUpstream: async request => {
          nativeFetches++;
          forwarded = await request.json() as Record<string, unknown>;
          return Response.json({ id: "resp_native_completed", status: "completed", output: [] });
        },
      });
      expect(continuation.status).toBe(200);
      expect(nativeFetches).toBe(1);
      expect(forwarded?.model).toBe(nativeModel);
      expect(forwarded?.previous_response_id).toBeUndefined();
      const replay = JSON.stringify(forwarded?.input);
      expect(replay).toContain("S8-ORIGINAL-DECISION");
      expect(replay).toContain("S8-VERIFIED-TOOL-EVIDENCE");
      expect(replay).toContain(summary);
      expect(replay).toContain("S8-NATIVE-DELTA");
      expect(replay).not.toContain("ocx1:");
      expect(replay).not.toContain("compaction_trigger");
      expect((forwarded?.input as unknown[]).at(-1)).toEqual(delta.input[0]);
    });
  }
}

test("S8 v1 compact preserves replacement-history shape and routes its next native turn unchanged", async () => {
  const config = defaultConfig("full");
  config.experimentalWebCompactor = true;
  const { body, metadata } = canonicalRequest("v1", false);
  const observed: Array<{ model: string; effort?: string; compaction?: boolean }> = [];
  const response = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST", body: JSON.stringify(body),
    headers: { "x-codex-turn-metadata": JSON.stringify(metadata) },
  }), config, () => fakeCompactor(observed), {
    fetchUpstream: async () => { throw new Error("native must not compact"); },
  });
  expect(response.status).toBe(200);
  const compact = await response.json() as { output: unknown[]; id?: string; status?: string };
  expect(Object.keys(compact)).toEqual(["output"]);
  expect(compact.output).toHaveLength(2);
  expect(compact.output.at(-1)).toMatchObject({
    type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }],
  });
  expect(observed).toHaveLength(1);

  // V1 returns replacement history instead of a response id; Codex resends that history.
  const nativeRequest = { model: nativeModel, input: [
    ...compact.output, { type: "message", role: "user", content: "S8-NATIVE-DELTA" },
  ] };
  let forwarded: unknown;
  const continued = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify(nativeRequest), headers: { authorization: "Bearer local-fixture" },
  }), config, () => { throw new Error("native turn must not run Web"); }, {
    fetchUpstream: async request => {
      forwarded = await request.json();
      return Response.json({ id: "resp_native_v1", output: [] });
    },
  });
  expect(continued.status).toBe(200);
  expect(forwarded).toEqual(nativeRequest);
});
