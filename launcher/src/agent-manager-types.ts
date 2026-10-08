export type AgentManagerRole = {
  name: string;
  scope: string;
  model: string;
  reasoningEffort: string | null;
  configPath: string;
  managed: boolean;
  status: string;
};

export type AgentManagerInspection = {
  codexHome: string;
  maxConcurrentThreads: number | null;
  roles: AgentManagerRole[];
  warnings: string[];
  pendingRecovery: boolean;
};

export type AgentManagerPreview = {
  id: string;
  preset: "balanced" | "parallel";
  maxConcurrentThreads: number;
  changes: Array<{ path: string; operation: "create" | "update"; changedKeys: string[] }>;
  warnings: string[];
  requiresRestart: boolean;
};

export type AgentManagerApi = {
  inspect(): Promise<AgentManagerInspection>;
  preview(request: { preset: "balanced" | "parallel"; maxConcurrentThreads: number; enrollMissingRoles: boolean }): Promise<AgentManagerPreview>;
  apply(id: string): Promise<{ requiresRestart: boolean; applied: boolean; changedFiles: number }>;
  recover(): Promise<{ recovery: "nothing-to-recover" | "rolled-back" | "committed" }>;
};
