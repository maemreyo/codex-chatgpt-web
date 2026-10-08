# Agents & Runtime: pull request acceptance record

Scope: branch `feat/zam-agent-runtime-pr-main` targets **the owner's fork** `maemreyo/codex-chatgpt-web:main` at `b6ca2d3`. It merges the full committed `feat/semantic-epoch-memory` history through `5893e12` (Bigger Context, semantic epochs, diagnostic logging, upstream 6.1.5/6.1.6, and Web model changes) alongside the Agents & Runtime changes. Version: **6.1.8-rc.1**, an unpublished release candidate. The unrelated **uncommitted** Semantic Epoch Memory/native quota changes in the original source worktree are excluded and untouched. The existing installed 6.1.7 application has not been overwritten.

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
| Focused agent/browser tests | `bun test tests/{agent-management,browser-session-cap,launcher-helper-client}.test.ts` | **27 passed / 0 failed** |
| Runtime suite on merged 6.1.7 lineage | `bun test ./tests` | **906 passed / 40 skipped / 14 failed**, 960 tests |
| Electron/Launcher suite | `bun run launcher:test` | **390 passed / 2 skipped / 0 failed**, 392 tests |
| Packaged macOS arm64 | `bun run --cwd launcher package:mac`, signed-bundle verification | PASS |
| Packaged launcher/embedded runtime | `bun run --cwd launcher smoke:package` | **PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64** |
| Packaged CLI with temporary Codex profile | `launcher/build/runtime/runtime/bun launcher/build/runtime/app/cli.js agents inspect --codex-home <temp>` | **PACKAGED_AGENT_CLI_INSPECT_OK**, four roles |

Only macOS arm64 is packaged here; Windows/Linux must be built on matching host operating systems.

The full runtime suite is **not green**. All 14 failing test names exactly match the previously captured baseline at `5893e12`, which had 17 failing tests under Bun 1.4.0. The failures concern older GPT-6/Plus context, Zero Risk, DEV routing, model catalogs, and Responses Lite contracts. This is a known inherited source-test gap, not proof of correct real-account behavior. The fork-main-only integration, before merging the committed 6.1.7 lineage, passed 850/28/0; the merged runtime suite must not be presented as all-pass.

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

This record supports code review of the integration candidate, not promoting a stable release. The maintainer explicitly deferred E2E and requested **Ready for Review**. Release requirements in `docs/release-validation.md` still apply to all supported platforms; merging/publishing as stable should be gated separately on the outstanding acceptance and baseline test policy.

## Package artifacts

- macOS arm64; embedded Bun 1.4.0; ad-hoc signed with hardened runtime; **not notarized**.
- Version 6.1.8-rc.1, **rebuilt after merging all committed 6.1.7 changes**, generated locally: `launcher/artifacts/zam-codex-web-6.1.8-rc.1-mac-arm64.dmg` and `zam-codex-web-6.1.8-rc.1-mac-arm64.zip` (excluded from Git).
- DMG SHA-256: `58dee340107f3f69a44a6008aac8762a9404c886dcc786fa0c9f21940a4f61f4` (~157 MiB).
- ZIP SHA-256: `dbaed977b18fcb01e2a9e522c138f3cf6220f171981ba0a07f182ca27e11ac0d` (~161 MiB).
- The RC tag/release is not published. The stable README links continue to point to the previously published stable version rather than to nonexistent RC downloads.

## Safety and ownership

Preview IDs bind expected input hashes. External edits invalidate Apply, and recovery never overwrites divergent external modifications. Tests use temporary Codex profiles; no personal `~/.codex` files were modified. Installed software, native hooks, saved sessions and credentials were not changed as part of the build.
