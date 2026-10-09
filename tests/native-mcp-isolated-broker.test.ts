import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

// This exercises the real MCP stdio implementation, its turn-token claim,
// isolation by explicit broker socket, and result relay. The native Codex
// dispatcher is simulated by the test, not by an authenticated browser turn.
test.skipIf(process.platform === "win32")("native MCP routes a read-only command through its own isolated broker", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-native-mcp-isolated-"));
  const socket = join(root, "broker.sock");
  const broker = TurnBroker.forSocket(socket);
  const env: ChatGptTurnEnvironment = {
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: [{ name: "exec_command", description: "Native command", parameters: {
      type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"],
    } }],
  };
  let token: string | undefined;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--contract", "native", "--broker-socket", socket],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "isolated-native-test", version: "1" });
  try {
    token = await broker.register(env, 60_000, "isolated-native-smoke");
    await client.connect(transport);
    const call = client.callTool({
      name: "codex_exec",
      arguments: { turn_token: token, cmd: "pwd", workdir: root, yield_time_ms: 1000 },
    });
    const [queued] = await broker.nextToolBatch(token);
    expect(queued).toMatchObject({ wireName: "exec_command", arguments: {
      cmd: "pwd", workdir: root, yield_time_ms: 1000,
    } });
    const child = Bun.spawn(["/bin/pwd"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(), child.exited,
    ]);
    expect(exitCode).toBe(0);
    broker.completeTool(token, queued!.callId, {
      content: [{ type: "text", text: `${stdout}Process exited with code ${exitCode}` }],
    });
    const response = await call;
    expect(response.isError).not.toBe(true);
    expect(JSON.stringify(response.content)).toContain(root);
    expect(JSON.stringify(response.content)).toContain("Process exited with code 0");

    // Rebinding the MCP child to a second broker cannot claim A's token.
    // This is the failure mode of an isolated source runtime using the
    // launcher's production tunnel instead of its own MCP socket.
    const other = TurnBroker.forSocket(join(root, "wrong-broker.sock"));
    const otherClient = new Client({ name: "wrong-broker-test", version: "1" });
    try {
      await other.listen();
      await otherClient.connect(new StdioClientTransport({
        command: process.execPath,
        args: ["src/cli.ts", "mcp", "--contract", "native", "--broker-socket", other.socketPath],
        cwd: process.cwd(),
        stderr: "pipe",
      }));
      const rejected = await otherClient.callTool({
        name: "codex_exec", arguments: { turn_token: token, cmd: "pwd", workdir: root },
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected.content)).toMatch(/invalid|expired|revoked/i);
    } finally {
      await otherClient.close().catch(() => {});
      await other.close();
    }
  } finally {
    await client.close().catch(() => {});
    if (token) broker.revoke(token);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
