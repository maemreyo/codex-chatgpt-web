# SEM + Bigger Context — macOS RC4 acceptance record

Date: 2026-10-09. Integration worktree: `codex/sem-rc4-integration`, based on
`61dbe9d` (RC3 agent cards, quota controls and SEM settings). The existing
dirty SEM worktree at `codex/live-subagent-smoke-gpt6` was preserved.
This record describes the local integration candidate and the subsequent
read-only/live checks. Commit, push, installation, and publication status are
reported separately; a successful Codex continuation does not prove SEM reuse.

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

## Prior installed RC3 — read-only live observations

Before the RC4 upgrade, the installed app was **6.1.8-rc.3**. A read-only
diagnostic inspection of its launcher log observed:

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

## Installed RC4 — partial authenticated acceptance (2026-10-09)

- macOS application and `/healthz` both report **6.1.8-rc.4**. The user
  installed RC4 manually; the RC3 application rollback ZIP was preserved at
  `launcher/artifacts/Codex-Web-GPT-6.1.8-rc.3-rollback.zip`.
- Configured maximum browser sessions: **8**; SEM and Bigger Context enabled;
  `experimentalSemanticLogicalWindow=false`. Launcher UI showed **effective 5,
  pending 8 (restart required)**. A configured value of 8 is **not** proof that
  the running launcher has applied the new limit. Do not restart it with active
  HTTP/browser turns.
- Authenticated Codex root + V1 child model chain smoke: **PASS**, both
  `chatgpt-web/gpt-6-sol`, version `6.1.8-rc.4`.
- Authenticated, read-only, **three-turn native Codex session**: **PASS** for
  initial shell read of a synthetic marker and two `codex exec resume`
  continuations that recalled the marker without tools. All three turns exited
  0 with expected marker/anchor and no reported turn failure. The first
  isolated-`CODEX_HOME` attempt failed on turn 2 with `missing cwd in trusted
  Codex environment context`. Repeating with the same Codex Home as the
  launcher and per-process provider overrides succeeded. **No bridge source
  change was needed or made**; the earlier test setup was not representative
  of the launcher-owned native rollout lookup.
- Additional targeted environment, outer-native harness and SEM recovery
  regressions: **172 pass, 1 platform-specific skip, 0 fail**, three files.
- Post-install safe-log snapshot: 44 SEM events across 14 thread hashes, **0
  `semantic_turn`, 0 rotation and 0 cost samples**. The snapshot included 16
  `anchor_missing` validations and 13 active-epoch legacy fallbacks. These are
  aggregate events in the launcher log, not a per-test causal diagnosis.
  The successful three-turn continuation establishes the native resume path,
  **not** SEM rotation/reuse/reseed, canonical fallback cost, or SEM savings.
- Commit `7555b9a` was pushed and draft PR #11 created. Original dirty
  worktree and active unrelated Codex sessions were left untouched.

## Remaining acceptance gates

1. When **both** HTTP and browser turns are idle, restart the launcher and
   verify that effective browser capacity equals the configured 8. The
   capacity change is pending until restart.
2. Exercise authenticated **eligible** SEM rotation, retained reuse,
   cache-miss/restart reseed, model-family switching, cap-limited canonical
   multipart fallback, and authority/occupancy safeguards. Capture bounded
   event counts and confirm end-to-end correctness for each.
3. Compare actual real-use SEM cost and answer quality with canonical Bigger
   Context. Keep `experimentalSemanticLogicalWindow=false` and S9 gated until
   measurement and explicit owner acceptance.

No release tag, GitHub Release, production SEM acceptance or token-savings
claim is made. macOS ARM64 artifact is ad-hoc signed, not notarized.
