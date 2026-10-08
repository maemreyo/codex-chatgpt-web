# Zam agents and runtime acceptance record

Worktree: `feat/zam-agent-runtime-settings`, created from `5893e12` (2026-10-08). This branch intentionally excludes in-progress Semantic Epoch Memory and native quota work in the source checkout. Deployment and changes to the user's existing `~/.codex` profile are separate acceptance steps.

## Runtime and release gates

| Gate | Local evidence | Real-account evidence | Current status |
| --- | --- | --- | --- |
| Legacy cap remains 5 | PASS: config migration and contract tests | Existing sessions continue on upgraded app | LOCAL PASS / LIVE NOT_RUN |
| Configured cap is 5–8 integer | PASS: invalid 4/9/fraction/string, launcher state and IPC tests | Settings and effective daemon/BrowserHost on account | LOCAL PASS / LIVE NOT_RUN |
| Exactly N active browser turns | PASS: 5–8 admission, N+1 typed overflow, bootstrap slot release tests | Controlled 5, 6, 8 simultaneous real turns | LOCAL PASS / LIVE NOT_RUN |
| Dynamic cap activation | PASS: launcher pending restart and browser cap tests | Change while active turn runs and verify activation | LOCAL PARTIAL / LIVE NOT_RUN |
| Native config manager | PASS: 15 native tests, 3 Electron IPC tests, CLI inspect from packaged bundle | Apply to selected personal profile and verify fresh Codex session | LOCAL PASS / LIVE NOT_RUN |
| Agent model policy | PASS: allowed model and override rejection in local preview; hook/trust **not enforced by manager** | Spawn all roles and verify no paid-route fallback | POLICY PARTIAL / LIVE NOT_RUN |
| Agent workflow | Four templates exist; configurable thread limit, manual preview/apply; no enforced reviewer gate | Explorer → Researcher → Builder → Reviewer independent workflow | PARTIAL / LIVE NOT_RUN |
| Multi-root admission | Single-process reservation tests pass; fairness/dependency queue not enabled | Real multi-root saturation/no orphan work | PARTIAL / LIVE NOT_RUN |
| Packaged app | PASS: ARM64 DMG and ZIP, integrity verification and `PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64` | Live-account run, version upgrade and rollback smoke | PACKAGE SMOKE PASS / LIVE NOT_RUN |

`NOT_RUN` means the result has not been established. Do not use source tests as evidence of real-account throughput. A browser task may carry a retained tab beyond active turn completion, and launcher task slots must never be confused with Codex thread count. ChatGPT may impose independent account limits below this application's configured cap. Browser cap changes activate on launcher restart; the UI must not imply hot activation.

## 2026-10-08 candidate build evidence

- Source checkout: `feat/zam-agent-runtime-settings` based on `5893e12`; **working tree uncommitted**, outside Semantic Epoch Memory and native quota changes. Runtime source and Launcher report version `6.1.7`; this candidate uses the same numeric version as the installed application and must not be mistaken for a published stable upgrade. No push, release tag, or installation performed.
- macOS ARM64 candidate files in `launcher/artifacts/`: `zam-codex-web-6.1.7-mac-arm64.dmg`, `.zip`, and `SHA256SUMS.txt`. DMG SHA256 `7b4b136aebca66817e4fd1aa5c899e614f15934341f0f021f5724728e2e89650`; ZIP SHA256 `3a657d1c6eecff0d027f221ddc3a4183c920efd8079c5bef3a1db1e9f0dcf47c`.
- Bundled Bun `1.4.0`, macOS `arm64`. Electron packaged smoke PASS; Electron ad-hoc-signed, not notarized. Real installed application was not replaced.
- Focused tests with bundled Bun `1.4.0`: 27 pass, 0 fail. Launcher suite: 389 pass, 2 skip, 0 fail. Launcher renderer typecheck/build and runtime TypeScript typecheck PASS. Cross-process Electron agent preview/apply tests: 3 pass.
- Full-suite comparison with the same Bun `1.4.0`: separate clean source checkout `5893e12` had **882 pass / 40 skip / 17 fail** (939 tests), while the final candidate has **906 pass / 40 skip / 14 fail** (960 tests). All 14 remaining failing test names were also present in the baseline failing set. Existing failures affect Bigger Context/Zero Risk/model routing and other older contract fixtures. The candidate is **not** labeled full-suite PASS; full failure logs are retained in `/tmp/zam-agent-runtime-final-tests.log` and `/tmp/zam-agent-runtime-baseline-tests.log` on the development machine.
- Read-only inspection of the selected personal Codex home reported four registered Web-only Zam roles; their static config does not prove native hook trust or effective sandbox permissions. No changes were made to the existing Codex configuration.
- The current UI provides browser cap setting, role inspect, missing-role enrollment, preview metadata, thread limit, Apply and explicit Recovery. Full role instructions/permission editor, native whitelist install/trust enforcement, queue and advanced settings remain out of the shipped feature set. No claim of full M0–M8 completion.

## Safety and ownership

All configuration mutations require a preview tied to the bytes read, private recovery records, and a scoped Apply action. File changes by editors outside the launcher invalidate the preview. Reject unsupported TOML formatting where preserving user fields cannot be shown. Keep unknown keys, custom agent instructions, hook trust boundaries, and personal credential paths intact. After applying a native configuration change, fresh Codex sessions may be required. Do not automatically promote new model routes or agent capability claims from a schema test.

## Test profile

Use temporary `CODEX_HOME` and `CODEX_CHATGPT_WEB_HOME` directories for automated config and smoke tests; never patch the owner's live profile as a test fixture. Real-account tests should use small useful prompts and stop on account rate-limit signals. Capture version, effective cap, role, model, test result, and cleanup disposition without raw conversations or credentials. Queue and additional advanced settings remain off until their specific progress, cancellation, authorization, and recovery gates pass.
