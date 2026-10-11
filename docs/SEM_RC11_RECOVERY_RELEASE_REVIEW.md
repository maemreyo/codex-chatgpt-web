# RC11 composer and submitted-turn recovery

Date: 2026-10-12 (Asia/Ho_Chi_Minh). Candidate: `6.1.8-rc.11`.
Source baseline: `5f25bd154612663734af8fd7fc8c9334021e36ec` (RC10, PR #17).

## User-visible behavior

Composer formatting changes and transient response observation failures should
recover inside the existing turn before surfacing an error to Codex Desktop.
Recovery must not submit an uncertain prompt again, rerun a native tool, accept
an incomplete answer, or replace canonical history with a browser projection.

## Changes

- Reconstruct composer text using block boundaries and inline BRs. Adjacent inline
  spans remain on the same line; placeholder caret BRs and connector UI do not
  become prompt content. Preserve leading whitespace and remove exactly the
  connector's inserted separator before reconstructing lines.
- Retry failed attachment once before Send, after checking that no submission
  evidence appeared. Rebuild large drafts in 64k UTF-16 segments and position
  each segment at the editor end. Verify the whole draft before sending. Final
  prompts, native compaction and Bigger Context stages share this recovery.
- Use LF for browser text transport when the source contains CR/CRLF; retain the
  original native request/history. Verify all characters against this explicit
  transport representation; retain the existing limited repeated-space/NBSP
  equivalence. Lost lines or arbitrary text changes still fail verification.
- Re-observe an already-submitted turn on ambiguous idle/missing-assistant
  observations, with finite retries and same-page transport recovery. Keep
  terminal errors, cancellation, explicit deadlines and ownership checks.
- Recover environment-less subagent continuations from authenticated current
  native session/turn records. Agent, parent, permissions and workspace evidence
  must agree. User prompt cwd and process cwd are never recovery authorities.
- Use that same continuation identity for SEM user-turn attribution. Both the
  environment and SEM paths reject disagreement between the native session parent
  and the indexed spawn edge; all attributed user records must match exactly.

## Evidence and limits

Offline Chromium fixtures recreate the reported signatures:

| Expected UTF-16 units | Legacy readback units | Common prefix | New readback |
| --- | --- | --- | --- |
| 233873 | 234466 | 193793 | Complete match |
| 55390 | 55983 | 42627 | Complete match |

Each synthetic fixture fragments a logical line into 594 inline runs. The old
reader inserts 593 newlines. These tests prove a matching failure mechanism;
they do not establish the exact DOM structure of the user's original private
ChatGPT draft. No private prompt or browser response is retained by the tests.

Additional real Chromium checks exercise 260235-unit LF text, astral Unicode,
nested connector/cursor markup, CRLF boundaries and production insertion plus
complete CRLF readback verification, in a network-isolated disposable profile.
This fixture is not the authenticated ChatGPT Lexical editor.

## Verification status

- Chromium composer suite: **7 PASS / 0 FAIL** (56 assertions), pinned Bun 1.4.0.
- Composer contract subset: **13 PASS / 0 FAIL** (147 filtered, 84 assertions).
- Environment agent verification: **75 PASS / 1 SKIP / 0 FAIL**; parent integration
  and release gate results will be recorded after completion.
- Version synchronization: **PASS**, `6.1.8-rc.11`, Bun 1.4.0.
- Three requested SEM regressions (broker disconnect without tool replay, native
  compaction quarantine receipt, 220–240k-token retained reuse): **3 PASS / 0 FAIL**
  (27 filtered, 50 assertions).
- Final idle/missing-assistant subset: **3 PASS / 0 FAIL** (159 filtered, 54 assertions).
- Native SEM attribution: **4 PASS / 0 FAIL** (16 assertions), including continued
  child parent-evidence consistency and unchanged canonical raw history.
- Independent final review: **no outstanding P1 finding**; combined browser worker,
  compaction, idle and native SEM attribution suite **174 PASS / 0 FAIL**, TypeScript
  and diff check **PASS** on the final code.
- Frozen final-code release gate (`bun run verify`, pinned Bun 1.4.0): **PASS**.
  Root: **1131 PASS / 40 SKIP / 0 FAIL**, 100 files, 12047 assertions. Launcher:
  **405 PASS / 2 SKIP / 0 FAIL**. Runtime and
  launcher TypeScript, both dependency audits, renderer build, third-party notices
  and relocatable runtime smoke (`RELOCATABLE_RUNTIME_SMOKE_OK`): **PASS**.
- macOS arm64 `bun run app:package` and `bun run app:smoke`: **PASS**.
  Package smoke emitted `PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64`. Packaging
  verified the extracted app with `codesign --verify --deep --strict` and checked
  its runtime manifest. Embedded Bun signature and `hdiutil verify` DMG: **PASS**.
- Authenticated Desktop acceptance for real broker disconnect, native compaction,
  SEM rotation and the actual ChatGPT composer: **NOT RUN** for RC11.

Stable promotion remains subject to `docs/release-validation.md`. A preview
installer and offline PASS results do not prove those authenticated flows.
Preparation preserves the running app, profile, sessions and existing broker.

Local preview artifact SHA-256:

- `codex-web-gpt-6.1.8-rc.11-mac-arm64.dmg`:
  `07351ad6cdcf07f1f77d26858e1cbc7f2e5d246a4162bd929ce1cb7bab6ac905`
- `codex-web-gpt-6.1.8-rc.11-mac-arm64.zip`:
  `8e8e6024bc317fd66fe153eeb10d2e3af01813557c4d3e92d556f1338adc47d1`

The preview is macOS arm64 only, ad-hoc signed, and not Apple-notarized. Windows
and Linux packaging/interactive acceptance are **NOT RUN**. No durable storage
schema changed; existing native history, SEM checkpoints and quarantine fences
remain intact. RC10 packages remain available for rollback without clearing
profiles or sessions.

The release gate runs with a Bun 1.4.0 directory first in `PATH`: invoking
the pinned binary alone still lets nested package scripts resolve the system Bun.
For packaging, copy the verified Bun into a separate toolchain directory outside
`launcher/build/runtime` first: runtime preparation replaces that output directory,
so using its binary as the build tool removes the running tool's path mid-build.
The final verify used the bundled Bun before packaging; packaging uses a verified
Bun 1.4.0 toolchain copy outside the output directory.
All release evidence must come from a frozen source snapshot, not a test process
that loaded an earlier module before a concurrent edit.
