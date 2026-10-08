export type AgentManagerRole = {
  name: string;
  scope: string;
  model: string;
  reasoningEffort: string | null;
  sandboxMode: string | null;
  developerInstructions: string | null;
  policy: "web-only" | "violated" | "unverified";
  effectivePermissions: "unverified";
  configPath: string;
  managed: boolean;
  status: string;
};

export type AgentRoleEdit = {
  model?: "chatgpt-web/gpt-6-sol";
  reasoningEffort?: "medium" | "high";
  sandboxMode?: "read-only" | "workspace-write";
  developerInstructions?: string;
};

export type AgentWorkflowPreset = "balanced" | "parallel" | "custom";

export type AgentManagerInspection = {
  codexHome: string;
  maxConcurrentThreads: number | null;
  roles: AgentManagerRole[];
  warnings: string[];
  pendingRecovery: boolean;
};

export type AgentManagerPreview = {
  id: string;
  preset: AgentWorkflowPreset;
  maxConcurrentThreads: number;
  changes: Array<{ path: string; operation: "create" | "update"; changedKeys: string[] }>;
  warnings: string[];
  requiresRestart: boolean;
};

export type AgentManagerApi = {
  inspect(): Promise<AgentManagerInspection>;
  preview(request: { preset: AgentWorkflowPreset; maxConcurrentThreads: number; enrollMissingRoles: boolean; roles?: Record<string, AgentRoleEdit> }): Promise<AgentManagerPreview>;
  apply(id: string): Promise<{ requiresRestart: boolean; applied: boolean; changedFiles: number }>;
  recover(): Promise<{ recovery: "nothing-to-recover" | "rolled-back" | "committed" }>;
};
