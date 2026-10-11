# RC10 semantic anchor compatibility and privacy diagnostics

Date: 2026-10-11 (Asia/Ho_Chi_Minh). Candidate: `6.1.8-rc.10`, macOS
arm64 preview. Source baseline: RC9 `8864f0f`; this candidate builds from
`codex/tool-output-budget-1010`. Preserve the installed RC9 app and its saved
profiles during release preparation.

## Changes

- Restore compatibility for persisted digest-v1 SEM anchor references after
  digest-v3 normalization changed current item refs. Reconstruct the v1
  canonical-item hash and occurrence ordinal, then validate the exact covered
  digest, saved source answer, user revision, pinned instructions and covered
  call/result pairing. Tampered, incomplete or ambiguous history still fails
  closed. No automatic epoch migration or hash-only rebasing.
- Classify `anchor_missing` using a small allowlisted diagnostic enum;
  preserve canonical native history and exact compaction/quarantine fences.
- Prevent native diagnostics report from echoing untrusted request categories;
  surface SEM archive overflow as `metricCoverage: partial` so retained-log
  counts cannot be mistaken for a complete history.
- Log compaction validation fallback target after canonical preflight, so a
  real recovery error is not labeled a successful legacy fallback.

## Verification on pinned Bun 1.4.0

The release gate `bun run verify` completed with exit 0 on macOS arm64:

- Root: **1117 pass, 40 skip, 0 fail**, 98 files.
- Launcher: **405 pass, 2 skip, 0 fail**.
- Root/launcher TypeScript, both package audits, renderer build, notices,
  relocatable runtime smoke (`RELOCATABLE_RUNTIME_SMOKE_OK`): **PASS**.
- Broker reconnect, native v2 quarantine-compaction replay, and SEM rotation,
  plus selected v1 anchor and diagnostic cases: **8 pass, 74 filtered, 0 fail**.
- Diagnostic reports: **7 pass**, launcher archive focused check: **1 pass**.
- macOS arm64 `bun run app:package`, `bun run app:smoke`, runtime Bun
  `codesign --verify --deep --strict`, and `hdiutil verify` DMG: **PASS**.
  Packaged smoke emitted `PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64`.
- `git diff --check`: **PASS**.

Local preview installer SHA-256 (these apply only to this built candidate):

- `codex-web-gpt-6.1.8-rc.10-mac-arm64.dmg`:
  `89c90ce6d999798105f7aabb7827bc5e6b0aeced853ce5d6f46cf7f18607733e`
- `codex-web-gpt-6.1.8-rc.10-mac-arm64.zip`:
  `37018239bd439ee466ea1f2b020fbb4b56a77334a5c9d24c2b57aac3702461f4`

## Interpretation and acceptance gate

The two `anchor_missing` events in the earlier October 11 retained log occurred
at approximately 13:54 and 15:03 local time, before RC9 was installed. The
legacy-v1 ref mismatch is deterministically reproduced but cannot be assigned
as the cause of both incidents from the old content-free log. Current RC9
does not emit `anchorDetail`. Archive pruning makes observed request/result
correlation totals incomplete.

Authenticated ChatGPT Desktop acceptance for real broker disconnection,
canonical native compaction, and rotation is **NOT RUN** for this candidate.
Preview publication does not constitute production acceptance or promotion to
the stable/latest updater channel. macOS arm64 only has a local installer
artifact; Windows/Linux packaging and Apple notarization are not verified.
