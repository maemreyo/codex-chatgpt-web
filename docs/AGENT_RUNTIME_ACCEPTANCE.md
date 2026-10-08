# Agents & Runtime: pull request acceptance record

Scope: branch `feat/zam-agent-runtime-pr-main`, based directly on **the owner's fork** `maemreyo/codex-chatgpt-web:main` at `b6ca2d3`. Version: **6.1.8-rc.1**, an unpublished release candidate. The fork's main branch was at 6.1.4 when this PR was prepared. This branch excludes unrelated Semantic Epoch Memory/native quota work. The existing 6.1.7 installation has not been overwritten.

## Delivered

- Browser-session capacity configurable from **5 to 8**, with legacy default 5, launcher/runtime validation, helper compatibility checks, reservations, and structured HTTP 409 capacity errors.
- Electron settings expose requested/effective capacity. Restart activation is explicit; in-flight turns are not interrupted to change capacity.
- Native Zam agent manager discovers four role registrations and supports Web-only model policy, role effort/sandbox/instructions editing, child-thread presets, missing-role enrollment, metadata previews, conflict detection, cross-process Apply, transaction journal, and explicit recovery. Custom TOML/comments are preserved.
- CLI `agents inspect|preview|apply|recover --codex-home /absolute/path` invokes the same packaged implementation used by Electron.
- Presets suggest browser capacity and child-thread limits independently; changes are not atomic across these separate configuration authorities.

## Verification

| Gate | Evidence | Result |
| --- | --- | --- |
| Runtime TypeScript | `bun run typecheck` (Bun 1.4.0) | PASS |
| Version consistency | `bun run check-version` | PASS |
| Runtime suite from fork-main base | `bun test ./tests` | **850 passed / 28 skipped / 0 failed**, 878 tests |
| Electron/Launcher suite | `bun run --cwd launcher test` | **379 passed / 2 skipped / 0 failed**, 381 tests |
| Packaged macOS arm64 | `bun run --cwd launcher package:mac`, signed-bundle verification | RC artifact metadata below |
| Packaged launcher/embedded runtime | `bun run --cwd launcher smoke:package` | RC smoke result below |

Only macOS arm64 is packaged here; Windows/Linux must be built on matching host operating systems.

## Account-bound acceptance gates (not yet satisfied)

| Live gate | State |
| --- | --- |
| Authenticated ChatGPT overlap at capacity 5, 6 and 8, plus N+1 rejection, abort and cleanup | **NOT_RUN** |
| Launcher settings interaction and restart/upgrade from installed 6.1.7 | **NOT_RUN** |
| Native Codex spawn of Explorer, Researcher, Builder and Reviewer in a fresh session | **NOT_RUN** |
| Native hook trust, whitelist enforcement, inherited permissions and absence of paid-route fallback | **NOT_RUN** |
| Explorer/Researcher → Builder → Reviewer delegated workflow | **NOT_RUN** |
| Multiple roots saturating a shared account with no deadlock or orphaned work | **NOT_RUN** |

The manager explicitly labels hook/sandbox enforcement **unverified**. It does **not** install or authorize a whitelist hook; model checks in source and templates alone cannot prove a no-paid-delegation guarantee. Disabling existing role registrations, project agent-file edits, workflow orchestration, fairness queues and advanced agent settings are not implemented. The optional queue stays off pending safe progress/cancellation acceptance. Agent configuration changes need a new Codex session.

This record supports reviewing a candidate PR, not promoting a stable release. Release requirements in `docs/release-validation.md` still apply to all supported platforms. Keep PR in draft while account-bound acceptance is outstanding.

## Package artifacts

- macOS arm64; embedded Bun 1.4.0; ad-hoc signed with hardened runtime; **not notarized**.
- Version 6.1.8-rc.1, generated locally: `launcher/artifacts/codex-web-gpt-6.1.8-rc.1-mac-arm64.dmg` and `.zip` (excluded from Git).
- The RC tag/release is not published. The stable README links continue to point to the previously published stable version rather than to nonexistent RC downloads.

## Safety and ownership

Preview IDs bind expected input hashes. External edits invalidate Apply, and recovery never overwrites divergent external modifications. Tests use temporary Codex profiles; no personal `~/.codex` files were modified. Installed software, native hooks, saved sessions and credentials were not changed as part of the build.
