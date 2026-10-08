# Zam Agents & Runtime — preview user guide (6.1.8-rc.1)

This feature is a preview. Agent model restrictions and effective permissions must be verified in the active Codex session before relying on them; the launcher does not establish native hook trust automatically.

## Browser sessions

Open **Zam Codex Web → Settings → Agents & Runtime**. Choose an integer capacity from **5** to **8**. The settings row shows the requested value and the capacity of the currently running launcher. Restart the launcher to activate a changed limit. Existing turns are allowed to finish at their original limit. This controls physical ChatGPT Web browser turns; Codex child threads are configured separately and account limits may be lower.

On a busy account the runtime returns a structured `browser_session_limit_exceeded` error (HTTP 409). Finish a turn or reduce the number of delegated threads before trying a new turn. The feature intentionally does not queue or replay an accepted submission.

## Native agent management

The Agents panel inspects the selected Codex profile (`CODEX_HOME`, or the corresponding production/development profile) and lists Explorer, Researcher, Builder and Reviewer. Registered agents are not silently overwritten or enrolled. To edit an existing role, expand **Edit role settings** and change reasoning effort, permitted sandbox value, or developer instructions. The only manager-approved route is `chatgpt-web/gpt-6-sol`; a role using a different model must be explicitly corrected before Apply.

Choose the desired child-thread limit or a preset: **Balanced** suggests four child threads/six browser slots; **Parallel** suggests six child threads/eight browser slots. A preset does not automatically grant more browser capacity. Select **Set suggested browser capacity** separately if wanted, then restart the launcher to activate it. Registering missing roles is opt-in.

Select **Preview changes** before **Apply preview**. The preview lists file paths, edited field names, and whether a file is created or updated; private instructions and credentials are not included in the diff metadata. Apply refuses stale previews if files were edited elsewhere. New Codex sessions are required to use updated agent settings. The panel offers **Recover unfinished changes** if a managed transaction was interrupted; it will refuse rollback if a file has diverged externally.

This manager currently handles global agents only. Project overrides, disabling a role, hook installation/trust, native whitelist enforcement, effective sandbox verification, an automated delegated workflow and fairness queues are separate tasks. Do not assume a custom model, paid-native fallback, or inherited permissions are blocked just because static role TOML passes validation.

## CLI inspection

The embedded runtime implements:

```
codex-chatgpt-web agents inspect --codex-home /absolute/path/to/profile
codex-chatgpt-web agents preview --codex-home /absolute/path/to/profile
codex-chatgpt-web agents apply --codex-home /absolute/path/to/profile
codex-chatgpt-web agents recover --codex-home /absolute/path/to/profile
```

`preview` reads a JSON configuration request on standard input; `apply` accepts the *complete JSON preview returned by that exact inspection state* on standard input. Neither operation should be used against a personal profile as a smoke test. See `src/agent-management/README.md` for the request schema and recovery contract.

## Upgrade, rollback and validation

Keep the previous app bundle/installer and any custom Codex configuration backups. This RC package is ad-hoc signed on macOS arm64, **not Apple-notarized**; Windows/Linux packages must be built and verified on the matching platform. The RC is not yet a published release.

Local/unit/package smoke tests are documented in `AGENT_RUNTIME_ACCEPTANCE.md`. Before promoting to stable, perform authenticated browser overlap at caps 5, 6 and 8, real four-role native Codex delegation, app upgrade/rollback checks, and hook trust verification. Until those gates pass, treat the RC as a test build.
