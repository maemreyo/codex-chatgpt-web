/** Native Codex agent configuration contract. Explicit codexHome is required for every operation. */
export const AGENT_ROLES = ["zam-explorer", "zam-researcher", "zam-builder", "zam-reviewer"] as const;
export type AgentRole = typeof AGENT_ROLES[number];
export const AGENT_TEMPLATE_VERSION = 1;
export const WEB_AGENT_MODEL = "chatgpt-web/gpt-6-sol";

export type RolePatch = {
  /** Enroll an absent role, using the versioned template for its new role file. */
  enabled?: true;
  model?: typeof WEB_AGENT_MODEL;
  reasoningEffort?: "medium" | "high";
  sandboxMode?: "read-only" | "workspace-write";
  developerInstructions?: string;
};
export type AgentConfigurationRequest = {
  maxConcurrentThreadsPerSession?: number;
  roles?: Partial<Record<AgentRole, RolePatch>>;
};
export type AgentHomeOptions = { codexHome: string };
export type AgentRoleInspection = {
  name: AgentRole;
  registered: boolean;
  configFile: string | null;
  model: string | null;
  reasoningEffort: string | null;
  sandboxMode: string | null;
  developerInstructions: string | null;
  status: "unregistered" | "imported" | "managed" | "unsupported" | "externally-changed";
  policy: "web-only" | "unverified" | "violated";
  effectivePermissions: "unverified";
  reason?: string;
};
export type AgentConfigurationInspection = {
  codexHome: string;
  configPath: string;
  configExists: boolean;
  configStatus: "unmanaged" | "managed" | "externally-changed";
  maxConcurrentThreadsPerSession: number | null;
  threadLimitKey: "max_concurrent_threads_per_session" | "max_threads" | null;
  roles: AgentRoleInspection[];
  pendingRecovery: boolean;
  whitelistEnforcement: "unverified";
  activation: "new-session-required";
};
export type AgentConfigFileChange = {
  /** Absolute path; compare only within local IPC, do not render raw config text. */
  path: string;
  operation: "create" | "update";
  expectedSha256: string | null;
  resultingSha256: string;
  changedKeys: string[];
};
export type AgentConfigurationPreview = {
  version: 1;
  codexHome: string;
  request: AgentConfigurationRequest;
  id: string;
  changes: AgentConfigFileChange[];
  templateVersion: number;
  warnings: string[];
  activation: "new-session-required";
};
export type AgentConfigurationApplyResult = {
  applied: boolean;
  changedFiles: string[];
  transactionId: string | null;
  activation: "new-session-required";
};

export class AgentConfigError extends Error {
  constructor(readonly code: "INVALID" | "UNSUPPORTED" | "CONFLICT" | "RECOVERY_REQUIRED" | "IO", message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

export function validateRequest(value: AgentConfigurationRequest): AgentConfigurationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentConfigError("INVALID", "Request must be an object");
  const known = ["maxConcurrentThreadsPerSession", "roles"];
  if (Object.keys(value).some(key => !known.includes(key))) throw new AgentConfigError("INVALID", "Unsupported configuration request field");
  const threads = value.maxConcurrentThreadsPerSession;
  if (threads !== undefined && (!Number.isSafeInteger(threads) || threads < 1 || threads > 32)) {
    throw new AgentConfigError("INVALID", "Child thread limit must be an integer from 1 through 32");
  }
  const roles = value.roles;
  if (roles !== undefined && (!roles || typeof roles !== "object" || Array.isArray(roles))) {
    throw new AgentConfigError("INVALID", "roles must be an object");
  }
  for (const [name, patch] of Object.entries(roles ?? {})) {
    if (!AGENT_ROLES.includes(name as AgentRole) || !patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new AgentConfigError("INVALID", "Only the four registered Zam roles can be managed");
    }
    if (Object.keys(patch).some(key => !["enabled", "model", "reasoningEffort", "sandboxMode", "developerInstructions"].includes(key))) {
      throw new AgentConfigError("INVALID", "Unsupported role setting");
    }
    if (patch.enabled !== undefined && patch.enabled !== true) {
      throw new AgentConfigError("UNSUPPORTED", "Disabling a role requires an enforceable whitelist transaction, which is not available yet");
    }
    if (patch.model !== undefined && patch.model !== WEB_AGENT_MODEL) {
      throw new AgentConfigError("INVALID", "Agent models must use the approved ChatGPT Web route");
    }
    if (patch.reasoningEffort !== undefined && !["medium", "high"].includes(patch.reasoningEffort)) {
      throw new AgentConfigError("INVALID", "Unsupported agent reasoning effort");
    }
    if (patch.sandboxMode !== undefined && !["read-only", "workspace-write"].includes(patch.sandboxMode)) {
      throw new AgentConfigError("INVALID", "Unsupported agent sandbox mode");
    }
    if (patch.sandboxMode === "workspace-write" && name !== "zam-builder") {
      throw new AgentConfigError("INVALID", "Only zam-builder may request workspace-write");
    }
    if (patch.developerInstructions !== undefined
      && (typeof patch.developerInstructions !== "string" || patch.developerInstructions.length < 1 || patch.developerInstructions.length > 24_000 || patch.developerInstructions.includes("\0"))) {
      throw new AgentConfigError("INVALID", "Invalid agent instructions length/content");
    }
  }
  return structuredClone(value);
}

/** Pure policy check for parent IPC and supported native spawn hooks. Does not claim hook installation. */
export function validateAgentSpawnRequest(value: { agent_type?: unknown; model?: unknown; reasoning_effort?: unknown }): AgentRole {
  if (!value || !AGENT_ROLES.includes(value.agent_type as AgentRole)) {
    throw new AgentConfigError("INVALID", "Agent type is outside the Zam whitelist");
  }
  if (value.model !== undefined || value.reasoning_effort !== undefined) {
    throw new AgentConfigError("INVALID", "Caller model and reasoning overrides are forbidden");
  }
  return value.agent_type as AgentRole;
}
