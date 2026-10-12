# Zam Codex Web — rebrand audit

Status: research only. No runtime, installer, package, update channel, or user profile has been migrated.

## Snapshot and scope

- Repository: `maemreyo/codex-chatgpt-web`, with `miuuyy/codex-chatgpt-web` configured as upstream.
- Worktree branch: `codex/zam-codex-web-rebrand-audit` from local `main`, commit `0ab071eb8e7135adb58740edb4beb0c036bdd225` (2026-10-09).
- Proposed product: **Zam Codex Web**; proposed repository/CLI spelling: `zam-codex-web`.
- Initial tracked/untracked source search found **121 files** referencing legacy/new brand spellings or repository owners (broad case-insensitive pattern; includes docs and tests). This is a discovery count, not a count of required edits.

## Critical decision boundaries

1. **Update source:** choose and verify an independently owned GitHub release channel before enabling any updater or installer pointing to a new repository. Avoid an application branded Zam automatically downloading upstream releases.
2. **Installed identity:** decide whether this is an in-place upgrade or a side-by-side product on each OS. `launcher/package.json` already uses `dev.zam.codexweb` for `appId`, while the current `productName` and release artifact use `Codex Web GPT` / `codex-web-gpt-*`.
3. **State and secrets:** preserve existing config, tunnel credentials, Codex route journals, browser profiles and sign-in state. Do not replace every legacy home/environment/partition name globally without a recovery path.
4. **OSS provenance:** retain Git history, license and third-party notices. Credit upstream contributors visibly, and distinguish the new project's additions from inherited functionality.
5. **Trademark:** assess use of “Codex” in a product name and avoid suggesting official OpenAI or upstream affiliation before public release.

## Required gate before implementation

- Fix a release/channel and backwards-compatibility policy before changing app ID, NSIS GUID, executable names, user data paths, or managed Codex integration markers.
- Record on-disk before/after fixtures and exact rollback behavior for a previous-version upgrade on each supported OS.
- Build and check updater, package, smoke, and migration paths; validate authenticated Codex and MCP flows manually on the target platforms according to `docs/release-validation.md`.

## Recommended sequence

| Phase | Scope | Exit evidence |
| --- | --- | --- |
| 0. Identity contract | Choose canonical product, GitHub owner/repo, app ID, signing identities, release channel and in-place versus side-by-side semantics | Recorded identifiers, owners and legacy aliases for macOS, Windows, Linux, CLI, browser and Codex integration |
| 1. User-facing rename | Product copy, UI/help, icons, repository metadata and multilingual docs; visible credits for upstream | No misleading affiliation, translated UI reviewed, copyright notices preserved |
| 2. Compatibility layer | Dual-reading previous config/env names, old CLI alias, Codex integration markers and browser/profile migration where proven safe | Fixtures from real previous versions; an old install stays usable and can be uninstalled safely |
| 3. Packaging/release | Build metadata, installer scripts, updater, CI asset names, checksums, signing and Linux desktop entries | All platforms use the same name/channel/asset matrix; stable updater cannot install an upstream-branded binary |
| 4. Migration rehearsals | Clean install, upgrade, interrupted upgrade, rollback, old/new coexistence and uninstall | No lost credentials or route ownership; safe, reproducible recovery documented |
| 5. Public rollout | Pre-release followed by stable release only after account-bound end-to-end validation | Versioned evidence per OS with real login/MCP/Codex turns; disclosure and migration guide published |

## Changes to treat differently

- **Rename directly when appropriate:** visible marketing copy, new screenshots, future documentation, repository badges once URLs exist, icons and names of new release assets when all producers/consumers agree.
- **Keep aliases temporarily:** CLI executable names, existing environment variables, old config/state locations, protocol labels consumed by other clients, and legacy release asset patterns required by existing installers.
- **Preserve provenance:** original commit history, existing copyright/license text, third-party attributions and references that document the upstream relationship. Historical release notes and historical journal formats should not be rewritten for appearance.
- **Choose deliberately:** Windows NSIS GUID, macOS bundle identifier, browser persistent partitions, Codex integration marker namespace, updater GitHub repository and GitHub fork-network membership. These may be migration identities rather than branding strings.

## Targeted verification matrix (implementation phase)

| Change area | Minimum relevant checks | Additional acceptance |
| --- | --- | --- |
| CLI and env/config | `tests/cli.test.ts`, `tests/setup-lifecycle.test.ts`, `tests/dev-profile.test.ts` | Read legacy config with both new and old CLI; precedence and secrets retention |
| Codex integration/journals | `tests/codex-integration.test.ts`, `tests/codex-interrupt-hook.test.ts` | Previous-install disconnect/reconnect and interruption/recovery with no orphaned hooks |
| Browser profile/session | `launcher/tests/profile.test.cjs`, `launcher/tests/browser-host.test.cjs`, `tests/browser-login.test.ts` | Sign-in persistence and isolation between DEV/production after upgrade |
| Packaging/update/installer | `launcher/tests/packaging-contract.test.cjs`, `launcher/tests/update.test.cjs`, `launcher/tests/windows-installer.test.cjs`, `launcher/scripts/smoke-package.cjs` | OS-native installer, asset/checksum and rollback matrix |
| Production release | `.github/workflows/release.yml`, `docs/release-validation.md` | Signed package checks, macOS/Windows/Linux install/upgrade and authenticated live smoke |

The commands above are a proposed future test selection, not checks executed by this audit.

## Public UI, documentation and OSS findings (read-only agent audit)

| Priority | Actual touchpoints | Necessary handling |
| --- | --- | --- |
| P0 | `README.md:6-12,24,54,60,93,170-171,193-205`, plus corresponding sections in `README.zh-CN.md`, `README.ja.md`, `README.ko.md` | Replace upstream download/support/community/Star History destinations only when Zam-owned destinations exist. Keep explicit credit and historical upstream links. |
| P0 | `launcher/src/i18n.ts:10,49,88,307,346,385,604,643,682,901,940,979,1198,1237,1276`, `launcher/index.html:8`, `launcher/src/App.tsx:2821` | Rename text in all five localized UI languages and app/page titles. |
| P0 | `launcher/electron/main.cjs:63-68,606-614`, `launcher/src/App.tsx:274-313,2044-2054` | Replace current GitHub/X and onboarding destinations. **Onboarding currently requires opening upstream social destinations**; avoid shipping this as Zam-branded onboarding. Add attribution in About. |
| P1 | `src/cli.ts:35-58,93,238,548,610,627`, `src/dev-chat/cli.ts:34-42,156`, `src/doctor.ts:141`, `TROUBLESHOOTING.md` | New commands, help/error examples, diagnostics; keep old executable alias for a migration period. |
| P1 | `CONTRIBUTING.md:3-6,17-22`, `SECURITY.md:18-20`, `.github/ISSUE_TEMPLATE/{bug-report.yml,config.yml}`, `.github/PULL_REQUEST_TEMPLATE.md` | Zam maintainership, current issue templates and vulnerability channel, rather than upstream service contacts. |
| P1 | `LICENSE:3,12`, `scripts/generate-third-party-notices.ts`, `LICENSES/*`, `launcher/package.json:5-6` | Preserve upstream notices, provenance and third-party licensing; new project maintainer metadata must distinguish copyright/authorship. |
| P2 | `assets/readme/hero.svg`, `launcher/assets/icon.png`, `launcher/assets/icon.ico`, `assets/demo.gif`, `launcher/src/assets/mcp-*` | Review branding and ownership of visuals; replace where appropriate, preserve licensed/icon attribution. |

Additional documentation mismatch: multilingual `README*` files still describe release `6.1.8-rc.1`, while `package.json:3` reports `6.1.8-rc.2`. Correct version reporting as part of the docs rollout, independently of naming.

### Suggested public attribution

> Zam Codex Web is an independent fork of codex-chatgpt-web, originally created and maintained by miuuyy. We retain the original project's copyright notices, license, and contribution history. Zam Codex Web is independently maintained and is not affiliated with or endorsed by the upstream maintainer or OpenAI.

Publish this visibly in the primary README, a small `UPSTREAM.md`/provenance note, and the app's About section. The original LICENSE must remain intact; historical notes about old releases and upstream authorship should retain their original factual context.

## Packaging, updater and distribution findings (read-only agent audit)

**Current release readiness: blocked on identity/channel and migration decisions.** `launcher/electron/main.cjs:1313-1314` currently omits the update check to prevent installations updating from upstream; merely changing a visible product name will not enable Zam releases.

| Priority | Actual touchpoints | Risk and necessary treatment |
| --- | --- | --- |
| P0 | `launcher/electron/update.cjs:8-10,64-70`, `.github/workflows/release.yml:155-185` | Updater still requires `miuuyy/codex-chatgpt-web`; Actions publish to the repo running the workflow. Define a Zam-owned, independently verified release source and expected assets before enabling update checks. |
| P0 | `launcher/electron/update.cjs:188-197`, `launcher/electron/update-worker.cjs:40-50`, `scripts/install-launcher.sh:80-95`, `scripts/install-launcher.ps1:95-102` | macOS update validation, replacement worker, installers and Windows executable discovery assume `Codex Web GPT`; change producers and consumers as one compatible migration. |
| P1 | `launcher/package.json:90-97`, `scripts/install-launcher.ps1:95-100`, `src/dev-chat/profile.ts:24-34` | NSIS GUID `d1a6026a-6210-588e-9a2b-da3936f94e02` identifies existing Windows installations. Preserve for an intended in-place upgrade, or design a separate migration for side-by-side installs. |
| P1 | `scripts/install-launcher.sh:106-110,143-193`, `launcher/electron/autostart.cjs:6-10` | Linux wrapper, AppImage, desktop/icon and autostart entries contain old names; plan cleanup and rollback to avoid orphaned launchers. |
| P1 | `launcher/scripts/package.cjs:31-41`, `.github/workflows/release.yml:61-71` | macOS packaging can be ad-hoc signed; current verification does not prove Developer ID/notarization. Windows signing configuration was not identified in audited paths. |
| P1 | `launcher/electron/update-worker.cjs:40-110` | macOS handles certain failed replacement renames; Windows and Linux have different, incomplete rollback semantics. Exercise interrupted and failed upgrades, not only clean install. |
| P2 | `scripts/build-runtime-bundle.ts:97-125`, `launcher/electron/runtime-install.cjs:52-58` | Bundled CLI executable and its manifest checks expect old `codex-chatgpt-web` filename. Coordinate binary alias/renaming with runtime extraction. |

### Current identity matrix (at baseline)

| Surface | Current identifier | Proposed policy |
| --- | --- | --- |
| App ID / AUMID | `dev.zam.codexweb` | Prefer preserve existing installed identity unless evidence shows a conflict |
| Electron product | `Codex Web GPT` | `Zam Codex Web`; test macOS bundle/executable and userData migration |
| Launcher package | `codex-web-gpt-launcher` | Rename metadata and packaging contract together |
| Desktop release artifacts | `codex-web-gpt-*` | Zam names after cross-version asset compatibility review |
| Runtime archives | `codex-chatgpt-web-*` | New artifact naming with tested old installer handling |
| Linux wrapper/Desktop | `codex-web-gpt`, `codex-web-gpt.desktop` | New names plus intentional replacement/cleanup |
| Linux autostart | `dev.codexwebgpt.launcher.desktop` | Migrate old autostart idempotently |
| Electron profile and browser partition | `Codex Web GPT`, `persist:codex-web-gpt-chatgpt` | Avoid silent session loss; see runtime section |
| Release/update API | `miuuyy/codex-chatgpt-web` | Zam-owned repository after signed/channel verification |

The release workflow targets macOS ARM64/x64, Linux x64/ARM64, and Windows x64 (`.github/workflows/release.yml:14-25`). Explicit Linux AppImage ABI verification currently covers x64 only (`.github/workflows/release.yml:50-56`), so Linux ARM64 requires its own execution evidence.

The `scripts/install.sh:4-9` terminal installer is separately pinned to upstream `6.1.5`; do not forget this legacy distribution path. Existing `docs/release-validation.md:8-26` defines prerelease/latest behavior, and installed launchers only discover a new release on startup when update checks are enabled.

## Runtime persistence, hooks, tunnel and protocol findings (read-only agent audit)

| Priority | Actual touchpoints | Consequence of blind rename |
| --- | --- | --- |
| P0 | `src/config.ts:210-216`, `launcher/electron/profile.cjs:26-59`, `launcher/electron/main.cjs:72-85`, `launcher/electron/browser-host.cjs:352-358`, `src/launcher-browser-host.ts:114-118` | Legacy core home, Electron userData, DEV home and persistent browser partition are linked to session/config ownership; changing names can appear to log out users or orphan config/secrets. |
| P0 | `src/codex-integration-shared.ts:245-263`, `src/codex-integration-route.ts:302-322`, `src/codex-integration-journal.ts:137-196` | Existing Codex provider/route markers and journals are checked against installed values and recoverable filesystem state. Global comment/marker changes can defeat remove/reconnect recovery. |
| P0 | `src/codex-interrupt-hook.ts:26-36,52-60,96-143,213-263` | Interrupt-hook SHA-256 identity, absolute command paths and trust records must move transactionally. A cosmetic hook name change can break ownership verification. |
| P0 | `src/setup.ts:397-409`, `src/tunnel.ts:218-285`, `src/tunnel-service.ts:8,51-84`, `src/service.ts:8`, `launcher/electron/runtime.cjs:469-509,1293-1312` | Production tunnel profiles, aliases, credentials and launchd labels are fixed legacy names. Renaming these can create duplicate service ownership or disconnect a working tunnel. |
| P1 | `src/server.ts:945-955`, `src/doctor.ts:64-77`, `launcher/electron/runtime-supervisor.cjs:620-627` | `codex-chatgpt-web` is a produced-and-validated **health protocol value**. Keep until all consumers accept a versioned replacement. |
| P1 | `src/setup.ts:130-202`, `src/browser-login.ts:139-153,362-370,440-449` | Saved runtime commands, browser storage, sockets and login verification data can embed absolute legacy paths. A directory copy is insufficient without resolving saved references. |
| P1 | `launcher/electron/runtime-install.cjs:41-79,218-288` | Versioned runtime manifest/CLI validation depends on executable names; coordinate with packaging and old aliases. |
| P1 | `launcher/electron/connector-identity.cjs:1-46` | Connector naming and retired identifiers are governed by a separate compatibility contract; some connector identity migrations require new connection setup. |

### Recommended persistent-state policy

1. **First Zam release:** preserve the old physical home, environment-variable names, session partition, Codex managed markers, hook identities, tunnel profiles, and service labels for installed users. New user-facing product labels can diverge safely from internal historical identifiers.
2. **Optional future migration:** introduce a centralized identity resolver that recognizes old and new names. Define deterministic precedence and explicit conflict refusal when two homes contain divergent durable state.
3. **Explicit move, if justified:** quiesce runtime and tunnel, back up state and recovery journals, move files plus absolute references, reconcile Codex route/hook ownership, verify authentication and external effects, then commit the migration or roll back. Existing recovery helpers (`src/codex-integration-shared.ts:274-363`, `src/codex-integration-journal.ts:150-196`, `launcher/electron/runtime.cjs:469-532`) do not together prove full cross-component migration atomicity.

**Regression additions:** upgrade with legacy session and Codex routes; repeated setup/disconnect/reconnect/uninstall; interruption between filesystem and journal migration; existing tunnel service reuse with exactly one owner; no DEV/production crossover. Add fixtures that capture actual prior-release files without retaining raw tokens, prompts, cookies or personal content.

## Decisions for implementation review

1. Target repository and release ownership: choose the Zam GitHub organization/repository, its public security/issue channels, and whether the previous release feed will carry a migration bridge release.
2. Distribution topology: in-place upgrade or explicit side-by-side installation on each OS. Record the compatible bundle ID/NSIS GUID, executable names, old launcher cleanup and redirect behavior.
3. Identity boundary: approve user-facing `Zam Codex Web` plus CLI alias as the first milestone; preserve legacy runtime identity until separate migration tests prove it safe.
4. Attribution and branding: preserve MIT copyright and Git history; add a visible upstream credits statement, original authorship and no-affiliation statement before public launch.
5. Live evidence owner: select machines/accounts for macOS ARM64/x64, Windows x64 and Linux x64/ARM64 validation. Do not treat a package smoke check as production acceptance.

## Audit limits and handoff

Three bounded read-only subagents inspected (a) packaging/release, (b) runtime/identity compatibility, and (c) public UI/docs/OSS. The parent independently checked Git worktrees, codebase identifiers, manifests, available targeted tests and this report. No modifications were made to application code, release scripts, installers or user installations; this report is the sole added file.

Evidence is static and specific to HEAD `0ab071e`. No typecheck, unit suite, release package, installer, live browser/ChatGPT/Codex turn, migration or rollback was executed. Existing targeted verification foundations are listed above; future work should start with identity decisions, then implement in small slices and record exact checks for each slice.
