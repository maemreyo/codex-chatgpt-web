# RC12 composer recovery after installed RC11 failures

Date: 2026-10-12 (Asia/Ho_Chi_Minh). Preview candidate: `6.1.8-rc.12`.
Source baseline: `17999c04584e8f3517aec7fdf041b1a4caac721f`.

## Observed installed behavior

Installed and running RC11 runtime manifests and browser-helper SHA-256 agree.
This was not an old daemon continuing after installation.

- Compact trace `e74fa9119124_fallback` repeatedly reached multipart stage 4,
  then failed before Send with expected 55390, observed 55983, prefix 42627.
  Both attachment attempts failed; a later caller retry repeated the same error.
- The other compact has a durable native compacted record at
  `2026-10-11T17:51:02.785Z`. Its subsequent normal turn failed before Send with
  expected 96240, observed 96241, prefix 0.
- Both delegated agents failed at initial attachment with the same +1 / prefix 0
  signature and were closed. They did not provide an independent final review.

## Concrete causes and changes

Authenticated Electron editor inspection reproduced the second failure exactly:
the markdown composer creates its own one-space separator after the connector;
RC11 also inserted another space. RC12 inspects the verified empty connector
draft and supplies a separator only when the editor has not already supplied it.
The prompt's own leading whitespace is preserved.

RC11 retried a 55390-character prompt with the same atomic edit: its 64000-unit
chunk threshold left this compact unchanged. RC12's one pre-Send retry always
changes editing strategy. It builds escaped text nodes and BR elements, using
the browser edit command to insert them. User HTML is never parsed as markup.
Large edits retain surrogate-safe chunks and explicit document-end placement.
Whole-prompt readback, cancellation and before/after submission-evidence checks
remain authoritative. Recovery does not rerun tools or replay Send.

The current `data-composer-markdown` editor retains meaningful final BRs, whereas
ordinary Chromium contenteditable adds a final caret BR. RC12 distinguishes the
editors. It also excludes an empty mention block when the prompt itself begins
with a BR, and skips empty text nodes when locating the owned separator.

LF transport normalization now applies to both expected and observed text.
Authenticated editor insertion of CRLF text reproduced exactly the 55390 / 55983
/ prefix 42627 signature. This establishes a matching representation mechanism;
the original failed private draft was already cleared, so its exact structure
cannot be retrospectively asserted. Native request/history bytes are untouched.
Arbitrary lost lines, changed text and single-space/NBSP substitutions still fail
verification. Structural CR/LF/paragraph/BR counters are captured before cleanup,
without retaining private draft text, commands, HTML or response bodies.

## Live evidence

The launcher-owned empty ChatGPT surface was checked before synthetic edits.
No private prompt or native tool call was replayed. Composer tests did not Send.

Authenticated current-editor recovery readback: **13 complete matches**, covering
the two reported payload sizes, leading spaces/newline, ending blank lines,
literal markup, tabs, Unicode, escaped newlines, Markdown and a 169007-unit
segmented draft. Source CRLF uses its explicitly normalized LF representation.

A separate small synthetic test forced one pre-Send integrity failure, exercised
the real reset/recovery path, then sent once. The actual ChatGPT POST message text
was **116 / 116 characters, byte-for-byte equal** to the expected synthetic text.
An assistant response became visible. This proves recovery can produce a real
complete browser submission, rather than merely satisfying a detached DOM test.

The synthetic envelope includes a non-whitespace closing marker, as compiled
Codex transport does. A preliminary probe ending in two newlines showed that
ChatGPT's own submit serializer trims envelope-boundary whitespace. Interior
newlines, indentation, literal tags, tabs and Unicode were checked on the wire.
No request body or response text was archived.

The original user compact failing at stage 4 has **not** been replayed on RC12;
the installed app remains RC11 until the user installs the candidate. Full live
Desktop broker disconnect and SEM rotation acceptance remain **NOT RUN** for RC12.
The three requested canonical regression cases are tested separately offline.

## Release verification

Frozen source `bun run verify` with durable Bun 1.4.0: **PASS**. Runtime:
**1135 PASS / 40 SKIP / 0 FAIL**, 100 files, 12085 assertions. Runtime and
launcher TypeScript, both dependency audits, launcher tests/build, third-party
notices and relocatable runtime smoke: **PASS**.
Launcher: **405 PASS / 2 SKIP / 0 FAIL**.

The three requested regression cases: **3 PASS / 0 FAIL**, 50 assertions, with
`bun test tests/semantic-adapter-recovery.test.ts tests/turn-broker-lifecycle.test.ts
--test-name-pattern 'persisted quarantine lifts only|ninth turn reuses a verified
persisted epoch after restart at 220-240k|broker disconnect: oversized result'`.
Chromium composer cases: **10 PASS / 0 FAIL** as part of the same final gate.

An earlier release-gate attempt used Bun from `/tmp` and hit the four existing
tests requiring a durable runtime executable. That invalid-toolchain attempt
was stopped and replaced by the complete successful run above. Packaging also
uses the verified durable binary outside its disposable runtime output.

`bun run app:package` and `bun run app:smoke`: **PASS**;
`PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64`. The DMG checksum verification is
**VALID**. Artifact SHA-256:

- DMG: `c8427c6d9e34c115c4f136dbce5bd5629437a8f16d24dd9778f0d4541df10157`
- ZIP: `3e2ba5d7e6bf0e06f626c9ba9f539415330e5afca9408e0b461abafb22bbc836`
Preview remains macOS arm64 only; stable promotion requires the live gates in
`docs/release-validation.md`. No storage schema or native history migration.
