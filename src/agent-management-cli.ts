/** Safe JSON transport between the packaged runtime and Electron Agent Manager UI. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { inspectAgentConfiguration, previewAgentConfiguration, applyAgentConfiguration, recoverAgentConfiguration } from "./agent-management/manager";
import type { AgentConfigurationPreview, AgentConfigurationRequest } from "./agent-management/schema";

const MAX_INPUT_BYTES = 256_000;

async function readJsonInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_INPUT_BYTES) throw new Error("Agent configuration request exceeds the maximum size");
    chunks.push(buffer);
  }
  if (!chunks.length) throw new Error("Expected a JSON request on stdin");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function runAgentManagementCommand(args: string[]): Promise<void> {
  const action = args.shift();
  if (!action || !["inspect", "preview", "apply", "recover"].includes(action)) {
    throw new Error("Agents command must be: agents <inspect|preview|apply|recover> [--codex-home PATH]");
  }
  const index = args.indexOf("--codex-home");
  let suppliedHome: string | undefined;
  if (index >= 0) {
    suppliedHome = args[index + 1];
    if (!suppliedHome || suppliedHome.startsWith("--")) throw new Error("--codex-home requires a directory");
    args.splice(index, 2);
  }
  if (args.length) throw new Error(`Unknown agents command arguments: ${args.join(" ")}`);
  const codexHome = resolve(suppliedHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  if (action === "inspect") {
    stdout.write(`${JSON.stringify(await inspectAgentConfiguration({ codexHome }))}\n`);
  } else if (action === "preview") {
    const request = await readJsonInput() as AgentConfigurationRequest;
    stdout.write(`${JSON.stringify(await previewAgentConfiguration({ codexHome }, request))}\n`);
  } else if (action === "apply") {
    const preview = await readJsonInput() as AgentConfigurationPreview;
    stdout.write(`${JSON.stringify(await applyAgentConfiguration({ codexHome }, preview))}\n`);
  } else {
    stdout.write(`${JSON.stringify({ recovery: recoverAgentConfiguration({ codexHome }) })}\n`);
  }
}
