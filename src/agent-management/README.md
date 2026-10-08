# Native Codex agent configuration API (v1)

Import from `src/agent-management` (`index.ts`), or from `src/agent-management/manager.ts` for the three main functions. All three functions are **synchronous** and require an explicit absolute `codexHome`. No operation implicitly chooses the application's real `~/.codex` directory.

```ts
import {
  inspectAgentConfiguration,
  previewAgentConfiguration,
  applyAgentConfiguration,
  recoverAgentConfiguration,
} from "./agent-management";

const target = { codexHome: "/absolute/path/to/selected/codex-home" };
const inspection = inspectAgentConfiguration(target);
const preview = previewAgentConfiguration(target, {
  maxConcurrentThreadsPerSession: 4, // optional integer 1–32
  roles: {
    "zam-builder": { enabled: true, reasoningEffort: "high" },
  },
});
// Display preview.changes (keys, paths, expected/result hashes), preview.warnings,
// preview.activation; do not show a textual config diff.
const result = applyAgentConfiguration(target, JSON.parse(JSON.stringify(preview)));
```

Exact signatures:

- `inspectAgentConfiguration(options: { codexHome: string }): AgentConfigurationInspection`
- `previewAgentConfiguration(options: { codexHome: string }, request: AgentConfigurationRequest): AgentConfigurationPreview`
- `applyAgentConfiguration(options: { codexHome: string }, preview: AgentConfigurationPreview): AgentConfigurationApplyResult`
- `recoverAgentConfiguration(options: { codexHome: string }): "nothing-to-recover" | "rolled-back" | "committed"`

`AgentConfigurationRequest` has optional `maxConcurrentThreadsPerSession` and `roles`. Roles are only `zam-explorer`, `zam-researcher`, `zam-builder`, `zam-reviewer`. Each role patch supports `enabled?: true`, `model?: "chatgpt-web/gpt-6-sol"`, `reasoningEffort?: "medium" | "high"`, `sandboxMode?: "read-only" | "workspace-write"` (write only for Builder), and `developerInstructions?: string` (1–24,000 chars). Disable is currently **unsupported** because native whitelist removal cannot yet be guaranteed; previews fail closed for unsupported requests. Existing role TOMLs are patched surgically; newly registered roles get version 1 instructions. Explorer remains `high` pending benchmark; Researcher uses `medium`, and Builder/Reviewer use `high`. Unknown TOML keys and comments remain in place.

Inspect returns the selected config path and `configStatus` (`unmanaged`/`managed`/`externally-changed`), thread setting/key, the four role snapshots (`model`, `reasoningEffort`, `sandboxMode`, `developerInstructions`, source path and status), `pendingRecovery`, `whitelistEnforcement: "unverified"`, and `activation: "new-session-required"`. Role statuses include `unregistered`, `imported`, `managed`, `externally-changed`, and `unsupported`. Do not advertise native sandbox or hook policy as actually enforced from this static inspection.

Preview returns `{version:1, codexHome, request, id, changes, templateVersion, warnings, activation}`. Each change is `{path, operation, expectedSha256, resultingSha256, changedKeys}`. `changes` contains **metadata only**, never original or edited TOML and never a textual diff. **`request` can include caller-supplied `developerInstructions`; do not log or render the entire preview object**. Restrict it to local IPC with normal auth/permissions. Do not send it to telemetry or an external service. The `id` is a deterministic SHA-256 of the structured preview (not a signature or access token).

Apply reconstructs every edit from the current files and the supplied request, then recomputes the entire preview and ID. It rejects altered previews or changes to any selected input file. A private cross-process lock and 0600 recovery journal protect a multi-file transaction. Each write uses a same-directory temporary file, fsync, an additional hash precondition before rename, and a verify step; partial failures trigger conditional rollback, preserving outside edits. Since an uncooperative editor can write in the final filesystem instruction between hash check and rename, no ordinary file-based lock can provide absolute compare-and-swap semantics across all OSes. Ask users to stop editing native config during Apply. Incomplete recovery is explicit and cannot overwrite externally changed participants. `recoverAgentConfiguration` is a separate, effectful API and should require a deliberate UI action.

`applyAgentConfiguration` returns `{ applied, changedFiles, transactionId, activation: "new-session-required" }`. `AgentConfigError` provides `code` (`INVALID`, `UNSUPPORTED`, `CONFLICT`, `RECOVERY_REQUIRED`, `IO`) and a safe explanatory message. No API here installs or trusts a native whitelist hook, changes the active Codex process, proves project/profile overrides, or verifies live model routing; those are separate integration/acceptance gates. `validateAgentSpawnRequest` implements a pure four-name/no-caller-overrides guard for use at a genuinely enforced runtime boundary.

Tests use separate temporary Codex homes; they never modify a user's actual `~/.codex`.
