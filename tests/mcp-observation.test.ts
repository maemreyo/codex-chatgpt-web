import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as z from "zod/v4";
import { emitNativeToolDiagnostic, mcpDiagnosticId, nativeToolRequestShape, nativeToolSafetyFailure, nativeToolSafetyMessage, observeMcpToolCalls, subagentModelObservation } from "../src/adapters/chatgpt-web/mcp-observation";
import { chatGptSafetyStatusTextVisible } from "../src/adapters/chatgpt-web/safety-status-observation";

test("subagent diagnostics distinguish an explicit model without exposing task arguments", () => {
  const privateText = "private task /Users/example/work sk-not-a-model";
  const args = { model: "chatgpt-web/gpt-5.6-sol", message: privateText, items: [{ text: privateText }] };
  const before = structuredClone(args);
  expect(subagentModelObservation("multi_agent_v1__spawn_agent", args)).toEqual({
    modelOverride: "explicit", requestedModel: "chatgpt-web/gpt-5.6-sol",
  });
  expect(args).toEqual(before);
  expect(subagentModelObservation("multi_agent_v1__spawn_agent", { message: privateText })).toEqual({ modelOverride: "omitted" });
  expect(subagentModelObservation("multi_agent_v2__spawn_agent", { model: "gpt-6-luna" })).toEqual({
    modelOverride: "explicit", requestedModel: "gpt-6-luna",
  });
  for (const model of [privateText, "https://private.test/key", "sk-private-key", null, {}, "gpt-" + "a".repeat(100)]) {
    expect(subagentModelObservation("multi_agent_v1__spawn_agent", { model })).toEqual({ modelOverride: "unrecognized" });
  }
  expect(subagentModelObservation("other__spawn_agent", args)).toBeUndefined();
  expect(subagentModelObservation("exec_command", args)).toBeUndefined();
  expect(JSON.stringify(subagentModelObservation("multi_agent_v1__spawn_agent", args))).not.toContain(privateText);
});

test("tool request shape and safety signals are useful without logging payload contents", () => {
  const sensitive = "PRIVATE_USER_PROMPT_AND_KEY_123";
  const shell = nativeToolRequestShape({
    wireName: "exec_command", freeform: false,
    arguments: { cmd: `python3 - <<'PY'\nprint('${sensitive}')\nPY`, workdir: "/Users/private" },
  });
  expect(shell).toEqual({
    requestKind: "shell", requestArgCount: 2,
    requestChars: expect.any(Number), requestStructure: "inline_script",
  });
  expect(nativeToolRequestShape({ wireName: "apply_patch", freeform: false, arguments: { patch: sensitive } }))
    .toEqual({ requestKind: "patch", requestArgCount: 1, requestChars: sensitive.length, requestStructure: "single" });
  expect(nativeToolRequestShape({ wireName: "other", freeform: false, arguments: { privateKey: sensitive } }))
    .toEqual({ requestKind: "structured", requestArgCount: 1 });
  const safety = { isError: true, content: [{ type: "text", text: `This tool call was blocked by OpenAI because we couldn't determine the safety status of the request. ${sensitive}` }] };
  expect(nativeToolSafetyFailure(safety)).toBe("safety_status_unknown");
  expect(nativeToolSafetyFailure({ isError: true, content: [{ type: "text", text: "This tool call was blocked by OpenAI's safety checks." }] }))
    .toBe("openai_safety_block");
  expect(nativeToolSafetyFailure({ isError: false, content: safety.content })).toBeUndefined();
  expect(nativeToolSafetyMessage(new Error("We couldn't determine the safety status of the request.")))
    .toBe("safety_status_unknown");
  expect(nativeToolSafetyMessage(new Error("normal tool rejection"))).toBeUndefined();
  expect(JSON.stringify({ shell, safetyClass: nativeToolSafetyFailure(safety) })).not.toContain(sensitive);
});

test("MCP observations separate pre-handler validation and returned tool errors without recording content", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const events: Array<Record<string, unknown>> = [];
  const secret = "fixture-private-path-token-and-command";
  let invoked = 0;
  const server = new McpServer({ name: "observation-test", version: "1" });
  server.registerTool("codex_exec", { inputSchema: { cmd: z.string() } }, async () => {
    invoked += 1;
    return { isError: invoked === 1, content: [{ type: "text", text: secret }] };
  });
  observeMcpToolCalls(serverTransport, new Set(["codex_exec"]), event => events.push(event));
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1" });
  try {
    await client.connect(clientTransport);
    const invalid = await client.callTool({ name: "codex_exec", arguments: { private_key: secret } });
    expect(invalid.isError).toBeTrue();
    expect(invoked).toBe(0);
    const refused = await client.callTool({ name: "codex_exec", arguments: { cmd: secret } });
    const accepted = await client.callTool({ name: "codex_exec", arguments: { cmd: secret } });
    expect(refused.isError).toBeTrue();
    expect(accepted.isError).toBeFalse();
    expect(refused.content).toEqual(accepted.content);
    expect(invoked).toBe(2);
    expect(events.map(event => event.event)).toEqual(Array(3).fill(["call_received", "reply_sent"]).flat());
    expect(events.filter(event => event.event === "reply_sent").map(event => event.is_error)).toEqual([true, true, false]);
    expect(events.map(event => event.call)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(events.filter(event => event.event === "call_received").map(event => event.requestKind))
      .toEqual(["structured", "shell", "shell"]);
    for (let index = 0; index < events.length; index += 2) {
      expect(events[index]?.diagnosticId).toBe(events[index + 1]?.diagnosticId);
      expect(events[index]?.diagnosticId).toMatch(/^diag_[a-f0-9]{16}$/);
    }
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain("private_key");
    expect(JSON.stringify(events)).not.toContain("content");
  } finally {
    await client.close();
    await server.close();
  }
});

test("diagnostic correlation is local, deterministic, and does not expose MCP request IDs", () => {
  const requestId = "private-sequential-request-123";
  expect(mcpDiagnosticId(requestId)).toBe(mcpDiagnosticId(requestId));
  expect(mcpDiagnosticId(requestId)).not.toBe(mcpDiagnosticId(requestId + "-next"));
  expect(mcpDiagnosticId(requestId)).not.toContain(requestId);
});

test("safety-status text is only a visible browser signal", () => {
  expect(chatGptSafetyStatusTextVisible("This tool call was blocked by OpenAI because we couldn't determine the safety status of the request.")).toBeTrue();
  expect(chatGptSafetyStatusTextVisible("Operation blocked by a Codex hook")).toBeFalse();
  expect(chatGptSafetyStatusTextVisible("Tool request failed with isError")).toBeFalse();
});

test("failed diagnostic sink cannot interrupt the tool lifecycle", () => {
  const original = console.error;
  try {
    console.error = () => { throw new Error("diagnostic sink unavailable"); };
    expect(() => emitNativeToolDiagnostic({ stage: "handler_entered", diagnosticId: mcpDiagnosticId(42) })).not.toThrow();
  } finally {
    console.error = original;
  }
});

test("MCP observation failures, arbitrary IDs and unknown names never alter transport behavior", async () => {
  const events: Array<Record<string, unknown>> = [];
  const secret = "private-id-and-tool-name";
  const originalError = new Error("private transport failure");
  let received = 0;
  let closed = false;
  const transport: Transport = {
    start: async () => {}, close: async () => {},
    onmessage: () => { received += 1; }, onclose: () => { closed = true; },
    send: async () => { throw originalError; },
  };
  observeMcpToolCalls(transport, new Set(["codex_exec"]), event => {
    events.push(event);
    throw new Error("sink unavailable");
  });
  transport.onmessage?.({ jsonrpc: "2.0", id: secret, method: "tools/call", params: { name: secret } });
  expect(received).toBe(1);
  await expect(transport.send({ jsonrpc: "2.0", id: secret, result: {} })).rejects.toBe(originalError);
  expect(events.at(-1)).toMatchObject({ event: "reply_send_failed", tool: "unknown" });
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(JSON.stringify(events)).not.toContain(originalError.message);
  const duplicate = { jsonrpc: "2.0" as const, id: 7, method: "tools/call", params: { name: "codex_exec" } };
  transport.onmessage?.(duplicate);
  transport.onmessage?.(duplicate);
  expect(events.at(-1)).toMatchObject({ event: "uncorrelated_call", reason: "duplicate_id" });
  const count = events.length;
  await expect(transport.send({ jsonrpc: "2.0", id: 7, result: {} })).rejects.toBe(originalError);
  expect(events).toHaveLength(count);
  transport.onclose?.();
  expect(closed).toBeTrue();
});
