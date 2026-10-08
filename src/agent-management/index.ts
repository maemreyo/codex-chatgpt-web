/** Public native-agent configuration API for CLI and Electron IPC. All calls require an explicit Codex home. */
export { inspectAgentConfiguration, previewAgentConfiguration, applyAgentConfiguration, recoverAgentConfiguration } from "./manager";
export { AGENT_ROLES, AGENT_TEMPLATE_VERSION, WEB_AGENT_MODEL, AgentConfigError, validateAgentSpawnRequest } from "./schema";
export { getAgentTemplate } from "./templates";
export type {
  AgentRole, RolePatch, AgentHomeOptions, AgentConfigurationRequest, AgentConfigurationInspection,
  AgentRoleInspection, AgentConfigFileChange, AgentConfigurationPreview, AgentConfigurationApplyResult,
} from "./schema";
