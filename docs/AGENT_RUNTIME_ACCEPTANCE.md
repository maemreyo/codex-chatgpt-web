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

## Follow-up: 2026-10-08 local RC pilot

This is a later checkpoint; the verification table above remains the historical PR-candidate result. The current local checkout is `main` at `4c71485` (PR #7 merged), with `/Applications/Codex Web GPT.app` reporting `6.1.8-rc.1` and a packaged runtime process observed running. No production setting was changed in this checkpoint.

| Local check | Result |
| --- | --- |
| `bun test tests/agent-management.test.ts tests/browser-session-cap.test.ts tests/launcher-helper-client.test.ts` (global Bun 1.4.2) | **27 pass / 0 fail / 199 assertions**; exercises capacity N, exhaustion and slot release with fakes |
| `launcher/build/runtime/runtime/bun scripts/check-version.ts` (packaged Bun 1.4.0) | **PASS** (`VERSION_SYNC_OK 6.1.8-rc.1 bun@1.4.0`) |
| `launcher/build/runtime/runtime/bun run typecheck` | **PASS** |
| `node launcher/scripts/smoke-package.cjs` | **PASS** (`PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64`) |
| `bun run check-version` (global Bun 1.4.2) | **EXPECTED ENVIRONMENT FAILURE**: repository pins Bun 1.4.0; direct packaged-Bun check above passes |

The owner reported a previous full runtime suite result of **988 pass / 40 skip / 0 fail** after fixing stale fixtures. This checkpoint did **not** re-run the full suite. Local fake-harness and packaged-smoke success do **not** establish authenticated acceptance. All six account-bound gates in the table above remain **NOT_RUN** until observed with live evidence. The SEM logical 240k window remains default-off and S9 is gated separately.

An initial read-only follow-up observed bundle ID `dev.zam.codexweb`, a running app and local listeners, but had no rendered Settings screenshot or interactive evidence. DevTools returned targets without a Settings-labelled target. A separate read-only configuration-metadata listing was refused by the tool with `We couldn't determine the safety status of the request.` Its result was initially unknown.

**Later same-day GUI observation (read-only configuration):** The installed `6.1.8-rc.1` Electron UI was opened to **Settings → Agents & Runtime** and visually inspected via a window-only screenshot. Four role rows (`zam-explorer`, `zam-researcher`, `zam-builder`, `zam-reviewer`) render without visible overlap, each showing `chatgpt-web/gpt-6-sol`, editable role settings, and an imported/external status. The Balanced workflow shows **4 child threads** and **suggested capacity 6**. The configured capacity is **8**, but the visible runtime indicator states **`Effective: 5`** and **`Pending: 8`**: a launcher restart is required to activate 8. This is a **PASS for the narrow rendered-panel observation**, not for upgrade/restart, authenticated capacity, role spawn, or native whitelist enforcement. The UI was navigated only; no setting was applied, no account submission was made, and the launcher was not restarted.

Expanded-role GUI observation: opening the first **Edit role settings** section displayed reasoning effort, requested sandbox and developer instructions without visible overlap or clipping at the current 1680 × 1020 window size. A local-only screenshot was inspected; it was not copied into the repository because it includes user configuration text.

Additional targeted validation: `node --test launcher/tests/renderer-wiring.test.cjs launcher/tests/agent-manager.test.cjs` **34 pass / 0 fail**; `bun test tests/runtime-layout.test.ts` (global Bun 1.4.2) **21 pass / 0 fail**. These are isolated test fixtures, not live role delegation or authenticated capacity tests. The in-use runtime remains at effective capacity **5** and must not be described as supporting eight concurrent browser turns until restart and live verification.

Follow-up after the owner reported that selecting Balanced did not persist: the native Codex profile still contained `agents.max_concurrent_threads_per_session = 6` (Parallel). The preset dropdown previously initialized to Balanced on every mount without reconciling the inspected native value, and selecting a preset only prepared an unapplied draft. The source UI now restores the selected preset from the inspected thread limit on mount/refresh/Apply/recovery and explains the required Preview changes → Apply preview step. Fake-profile verification covers applying Parallel (6) and subsequently Balanced (4). No real Codex profile write or installed-app replacement was performed by this fix; the new UI behavior is pending a new build.

Targeted source verification: `bun test tests/agent-preset-display.test.ts` **1 pass**; `node --test launcher/tests/agent-manager.test.cjs launcher/tests/localization.test.cjs` **15 pass**; `launcher/build/runtime/runtime/bun run --cwd launcher typecheck` **PASS**; `launcher/build/runtime/runtime/bun run --cwd launcher build:renderer` **PASS**; `git diff --check` **PASS**. The renderer build output is local only; installed 6.1.8-rc.1 was not replaced or relaunched.

Follow-up UI/UX redesign (source candidate only): workflow controls now precede role details; mutually exclusive preset cards show their native child-thread limit and browser-capacity suggestion, with custom native limits labeled explicitly. Saved vs. draft state, Discard changes, Review → Apply actions, inline validation and the requested/effective browser-session distinction are visible together. The existing transaction and explicit owner Apply gate remain intact. Reference rationale and scope: `docs/AGENT_RUNTIME_UI_UX_REVIEW.md`.

Verification: `node --test launcher/tests/agent-manager.test.cjs launcher/tests/localization.test.cjs launcher/tests/renderer-wiring.test.cjs` **45 passed / 0 failed**; `bun test tests/agent-preset-display.test.ts` **1 passed / 0 failed**; `launcher/build/runtime/runtime/bun run --cwd launcher build` **PASS**; `git diff --check` **PASS**. An isolated Chrome fake-API UI preview confirmed a saved Parallel/6 state, switching to unsaved Balanced/4, Preview → Apply completion and correct saved-state refresh. Screenshots were inspected at 1060px and 480px widths without horizontal overflow. Temporary preview source/server were cleaned up. No real ChatGPT turn, profile write, application installation or live-capacity acceptance was performed.

## 2026-10-09 installed dashboard and read-only runtime checkpoint

This supplements the historical pilot above; its earlier `effective: 5` observation was made **before** the subsequent launcher restart. The installed `/Applications/Codex Web GPT.app` has the same `Contents/Resources/app.asar` SHA-256 (`65e91c2b6de74164d930621ba1eaf017058e4334b6db116bee5e867588573fb3`) as the locally packaged Settings Dashboard, and differs from the pre-dashboard backup (`732c3b0a2eca8c65b06b9776baa4a1f2013cdfd89bccef3cd5ddfb2879899b93`). The updated launcher and bridge are running; read-only `/healthz` returned `status=ok`, `version=6.1.8-rc.1`, `mode=full`, `accepting_turns=true`. The production launcher state persisted `maxBrowserSessions=8` before the installed launcher restarted. Source construction of `BrowserHost` consumes that setting on startup. This establishes installation/restart and configured-capacity evidence; it is not a synthetic proof of eight simultaneous successful authenticated responses.

The owner additionally **reported observing eight simultaneous sessions** in the updated application. Mark this **OWNER_OBSERVED** rather than automated capacity acceptance: the ninth simultaneous request, 409 rejection, cancellation/release, and tests at capacities 5 and 6 remain unverified against the authenticated account. Automated test fixtures exercising those paths are recorded above.

Read-only native `agents inspect` on the real Codex profile returned `maxConcurrentThreadsPerSession=6` (**Parallel**), `pendingRecovery=false`, and four registered/imported roles all configured with `chatgpt-web/gpt-6-sol`; Explorer/Builder/Reviewer have `high` effort and Researcher has `medium`. **Balanced/4 is not the currently saved live profile**. Static inspection still returns `whitelistEnforcement=unverified`, and does not prove live inherited sandbox permissions, paid-routing enforcement, or a multi-agent delegated workflow.

For release gating, keep authenticated ninth-slot rejection/cleanup, four-role completion, paid-model routing, native hook/sandbox enforcement, multi-root saturation and rollback tests explicitly unresolved until evidence is recorded. Local installed success is not stable-release acceptance.

Follow-up focused acceptance (same date): `node --test launcher/tests/browser-host.test.cjs` **119/119 PASS**; launcher/agent regression **45/45 PASS**, Bun 1.4.0 native agent/preset/capacity/helper fixtures **28/28 PASS**, launcher TypeScript typecheck **PASS**. The real connected Codex subagent tool successfully spawned and completed bounded read-only repository checks in each of the four named roles (Explorer, Researcher, Builder, Reviewer). This confirms role dispatch and simple completion in this session, without proving a fresh native Codex session, inherited tool/sandbox enforcement, account-wide quotas, or a chained delegated workflow.

The local native Codex subagent lifecycle harness passed **V1 and V2** with `CODEX_SUBAGENT_V1_LIFECYCLE_SMOKE_OK` and `CODEX_SUBAGENT_V2_LIFECYCLE_SMOKE_OK`. V2 initially failed when the root completed before a child follow-up was observed; the fixture now keeps the parent alive for a bounded poll until the follow-up actually arrives. These use a local stubbed Responses server and do not consume authenticated Web model turns. Independent review confirmed a key limitation: browser reservations are process-local, so concurrent separate runtimes sharing an account are not yet covered by an account-global cap. The authenticated multi-root saturation gate remains open.
