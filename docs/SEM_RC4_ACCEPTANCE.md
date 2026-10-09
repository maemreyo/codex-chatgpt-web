# SEM + Bigger Context — macOS RC4 acceptance record

Date: 2026-10-09. Integration worktree: `codex/sem-rc4-integration`, based on
`61dbe9d` (RC3 agent cards, quota controls and SEM settings). The existing
dirty SEM worktree at `codex/live-subagent-smoke-gpt6` was preserved.
This record describes the local integration candidate. Commit, push, installation,
and publication status must be verified from the repository and installed runtime.

## Verified candidate

- Version: **6.1.8-rc.4**, macOS ARM64, Bun **1.4.0**.
- Runtime bundle: `dist/runtime`; schema v2 manifest with 6,030 files.
- Distributables: `launcher/artifacts/codex-web-gpt-6.1.8-rc.4-mac-arm64.dmg`
  and `.zip`. Ad-hoc signed and verified during packaging; not notarized.
- SEM/Bigger Context recovery regressions on the RC3 UI/runtime base: **28 pass,
  0 fail** across six focused test files.
- Cross-impact browser worker, usage, semantic projection/store/provenance/cost,
  launcher-helper and agent-preset tests: **197 pass, 0 fail** across nine files.
  The legacy multipart-cost fixture was updated to enforce the current invariant:
  a semantic epoch is an inline browser message; any Bigger Context multipart
  fallback retains canonical evidence without adding phantom SEM stages.
- Launcher agent, quota, runtime-install, SEM Settings and state tests:
  **33 pass, 0 fail**.
- TypeScript typecheck (root and launcher), version synchronization, and
  `git diff --check`: **PASS**.
- Relocatable runtime smoke: `RELOCATABLE_RUNTIME_SMOKE_OK`.
- Packaged macOS smoke: `PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64`.

Tests use local fake workers and isolated runtime state. They do not establish
authenticated browser acceptance, accurate billed-token savings, or readiness
for an experimental logical window.

## Installed RC3 — read-only live observations

The installed app remained **6.1.8-rc.3**. A read-only diagnostic inspection
of its current launcher log observed:

| Metric | Observation |
| --- | ---: |
| SEM events / threads | 49 / 5 |
| Recorded semantic turn events / rotations | 2 / 2 |
| Masked historical tokens (estimate only) | 186,619 |
| Cost samples / equivalent legacy submissions | 2 / 2 |
| Reseed input tokens (estimate) | 96,524 |
| Extra stage submissions | 0 |
| Validation: missing anchor / digest mismatch | 21 / 1 |
| Legacy fallbacks due to active-epoch validation | 19 |

These events came from the installed RC3 process, **not** RC4. They do not
independently prove completed browser submissions. A missing
covered-history anchor requires conservative recovery; bypassing that
validation would risk losing canonical history or developer authority.
The diagnostic script emits only bounded categories and counts, without
echoing prompts, tool output or credentials.

## Pending acceptance gates

1. Wait for installed RC3's in-flight HTTP/browser turns to complete. The
   2026-10-09 read-only check observed **1 HTTP and 2 browser turns**; this
   snapshot is not a claim about subsequent runtime state.
2. Preserve the existing app and profile for rollback. Verify an idle drain
   before attempting an RC4 app upgrade; do not run two versions against the
   same `~/.codex-chatgpt-web` state.
3. Start a **new Codex session** with the installed RC4 bundle and check
   version, launcher capacity, UI/Settings, SEM/Bigger Context config and
   agent behavior.
4. Execute authenticated SEM rotation, retained reuse, launcher cache-miss,
   restart, model-family switch, rotation-cap canonical multipart fallback,
   and authority/occupancy safeguards; record safe logs for each.
5. Compare real-use SEM cost and quality with canonical Bigger Context.
   Keep `experimentalSemanticLogicalWindow=false` and S9 gated until
   those measurements and the owner decision are available.

No tag, GitHub Release, production acceptance, or updated-app live
acceptance is claimed.
