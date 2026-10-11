# RC9 live-recovery fixes and release evidence

Date: 2026-10-11 (Asia/Saigon). Baseline: RC8 commit
`45bc5ac8f7e6078927420568536f9ad3c134b062`. Target: macOS arm64
`6.1.8-rc.9`, preview release.

## Observed failures

The running RC8 accepted native tool results and completed turns, but successful
native compaction at 15:03:39 replaced the old assistant anchor. SEM validated
that stale anchor at 15:03:40 and quarantined the thread. The resulting canonical
fallback continued the task but stopped saving browser context.

Other observed gaps were repeated MCP requests against canceled turn tokens,
failure to align a virtualized response DOM with already streamed Markdown,
model/effort controls unavailable before submission, reused diagnostic IDs, and
a daily observation archive that stopped retaining events after reaching 4 MiB.

## Compaction transition

Completed v2 compaction now stores a pending summary digest for a healthy epoch
as well as a quarantined epoch. The old epoch remains usable until native Codex
replays the latest exact matching compaction item. That replay retires the old
anchor before projection validation; a subsequent completed source can establish
a new epoch. The receipt survives a process restart and uses compare-and-swap
fences to reject stale writers and preserve a newer epoch.

Canonical native history, compaction envelope/protocol, authority-bearing
messages, and tool results remain unchanged. Merely supplying summary text,
an unrelated compaction, or an older matching item does not clear quarantine.

An RC8 quarantine without a completed receipt is not silently erased on upgrade.
Its next successfully completed and replayed canonical compaction can restore
SEM. No production state file is edited as part of this build.

## Targeted verification recorded so far

Pinned runtime: Bun 1.4.0. No account-bound production turns were canceled or
replayed by the verification commands.

- `bun test tests/semantic-epoch-store.test.ts tests/semantic-adapter-recovery.test.ts`:
  37 PASS, 0 FAIL, 346 assertions. Includes healthy compaction, canonical
  continuation, restart, reseed, quarantine recovery and stale completion fences.
- `bun test tests/turn-broker-lifecycle.test.ts --test-name-pattern 'broker disconnect'`:
  1 PASS, 0 FAIL; result reference and exact completion ACK survive reconnect
  without a second native invocation.
- `bun test tests/semantic-active-pressure.test.ts --test-name-pattern 'S8: advisory pressure'`:
  1 PASS, 0 FAIL; complete canonical results, explicit native compaction and
  delta continuation.

Release gate (`PATH` pinned to Bun 1.4.0, `bun run verify`): PASS on macOS arm64.
Root tests: **1111 pass, 0 fail, 40 skip**, 98 test files. Launcher tests:
**405 pass, 0 fail, 2 skip**. Root and launcher TypeScript checks, root and
launcher package audits, renderer build, third-party notice generation, and
`RELOCATABLE_RUNTIME_SMOKE_OK` all passed. `git diff --check` passed. The
three pre-review suite failures were corrected in fixtures for current MCP ABI,
large native-result references, and MCP broker readiness; their focused checks
then passed before the complete release gate ran.

The skipped browser-facing tests and authenticated ChatGPT Desktop acceptance
are separate unverified dimensions.

macOS ARM64 preview packaging (`bun run app:package`) PASS. Packaged application
smoke (`bun run app:smoke`) PASS with `PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64`.
Built locally using ad-hoc code signing; Apple notarization was skipped.
The packaged DMG passed `hdiutil verify`. Mounted read-only, the packaged
`Codex Web GPT.app` and `Contents/Resources/runtime/runtime/bun` both passed
`codesign --verify --deep --strict`. The DMG was detached afterward.

- `codex-web-gpt-6.1.8-rc.9-mac-arm64.dmg` (158 MiB):
  SHA-256 `784d4396bb81749aa21d79d4ada61de7a1da1941beae54b5c388404766d971de`.
- `codex-web-gpt-6.1.8-rc.9-mac-arm64.zip` (161 MiB):
  SHA-256 `530f4e2cc3808090e1a075d62937d4af2b6cccdcf26f8e506e7086cc5fd6d71e`.

The local artifact manifest `launcher/artifacts/checksums.txt` still refers to
RC7 and is not evidence for RC9; release automation generates and verifies a
fresh manifest from the published assets. Multi-platform CI, publication and
public download checksum verification require separate evidence.
GitHub reported zero Actions runs at this checkpoint despite the CI and
Release workflows being active. Local verification is separate from remote CI.

## Post-review corrections

- A completed v2 browser compaction now returns a terminal
  `semantic_compaction_receipt_stale` error if its captured epoch fence no
  longer permits the durable receipt. The summary is not delivered to native
  Codex as a successful compact. A fixture simulates this failed compare-and-swap.
- Failed/aborted remote Stop checks ownership before sending its request and
  rechecks exact tab identity, trace and helper PID after the asynchronous
  operation. A concurrent replacement regression confirms that a successor
  and sibling remain untouched.
- Only the first, unsent model-control readiness probe has a 10-second wait.
  Its one bounded recovery reprobes with the original 70-second readiness
  allowance. All subsequent model/effort selections retain 70-second waits.
- Markdown reconcilers reject source-range changes even if a remounted node
  retains its source start. Diagnostic archives serialize cross-process
  compact/rename/append using a bounded per-day lock, preserving concurrent
  actionable records and overflow counts.

The native v2 replay item is read from Codex's canonical Responses request
to the local proxy. This is a **local-client trust boundary**, not remote
cryptographic attestation: the proxy binds `127.0.0.1`, but a hostile local
process able to forge complete native Responses requests is outside the
provenance guarantees of the current protocol. Replay still requires the
latest exact `ocx1:` compaction item to match a separately persisted, fenced
receipt from a completed browser compaction. Do not claim protection against
a malicious local client on the basis of this check alone.

## Release boundaries

Publish as a preview, not as the stable/latest updater release. Build and smoke
the macOS arm64 package in an isolated profile. Keep the existing running RC8
sessions intact; user installation and restart are separate from publication.
Windows/Linux builds and authenticated RC9 acceptance remain unrun unless
explicit evidence is added below. Even after a successful preview publication,
do not promote RC9 to the updater's stable/latest channel without authenticated
ChatGPT Desktop browser and compaction acceptance. The localhost client-history
provenance limitation described above also remains open.
