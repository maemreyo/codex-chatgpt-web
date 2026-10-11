# RC9 post-install diagnostic checkpoint — 2026-10-11

Scope: observed installed `6.1.8-rc.9-darwin-arm64` on macOS. This is a
read-only inspection of privacy-safe launcher and diagnostic observations plus
targeted offline regression tests. No live browser acceptance was run here.

## Observed SEM signals

- Four `semantic_compaction_accepted` observations in the retained daily
  diagnostic archive (16:51, 17:30, 19:11 and 19:46 local time). These prove
  persisted receipt/replay acceptance was logged, not that each user turn
  completed successfully.
- Two `anchor_missing` validation events at 13:54 and 15:03 local time, each
  followed by canonical fallback. The saved anchor was absent from that
  request's canonical provenance; the reason the anchor disappeared is not
  recoverable from content-free diagnostics alone.
- One `schema` validation event at 13:52 and one `operational_unknown` at
  19:44 local time. The current safe log schema deliberately omits exception
  bodies. Do not attribute these to a specific exception without a reproduction.
- Seven distinct `semantic_fallback` observations were retained, including
  four quarantined-epoch fallbacks. Canonical fallback is expected when a
  prior epoch cannot be verified; it is not proof that Codex failed to finish.
- The local state inspection showed 43 active epochs and four quarantines,
  all with `anchor_missing` as their stored reason. State was **not modified**.

## Diagnostic coverage limitation and fix candidate

The daily diagnostic archive evicts routine observations after its 4 MiB
ceiling while preferentially retaining failure/compaction observations. The
number of recorded MCP ingresses and Codex results can therefore differ
even when no call actually hung. They must not be subtracted to infer lost
execution or user-visible failures.

`scripts/native-tool-diagnostic-report.ts` now reports
`archiveRetention.{overflowObserved,droppedRoutine,droppedActionable,droppedInvalid,correlationCoverage}`
to expose this uncertainty. Archive counters are aggregate, privacy-safe
values. An overflow marks coverage `partial`; without one, report counts
remain **observed only**, not independently verified execution receipts.

## Focused verification (Bun 1.4.0)

- Three requested recovery cases: broker disconnect with oversized tool-result
  recovery, replayed native v2 compaction unlocking quarantine, and semantic
  rotation across retained turns: **3 PASS, 49 filtered, 0 FAIL**.
- Diagnostic/semantic report tests: **5 PASS, 0 FAIL**.
- Root TypeScript check and `git diff --check`: **PASS**.

Outstanding: identify the cause of the missing anchors and the unclassified
validation error with a deterministic source-history fixture, then validate
compaction and broker disconnect with authenticated ChatGPT Desktop. Do not
relax canonical history/compaction fences based only on these counters.

## Follow-up: classify missing-anchor history without changing recovery authority

A deterministic replay fixture shows that the same `anchor_missing` exception
can arise when a compact item appears in the canonical input, when the old
source turn remains but its answer is changed, when the source turn disappears,
or when an occurrence-based anchor reference changes while its answer hash
remains. This demonstrates several possible request shapes; **it does not
identify which one caused the two installed-app failures**.

The bridge now emits one of four enum-only `anchorDetail` values when an active
epoch fails with `anchor_missing`: `compaction_boundary_present`,
`answer_hash_retained`, `source_turn_retained`, or `source_turn_absent`.
Presence of a compaction item is an observation, not proof that the compaction
caused history replacement or that its summary is authorized. The launcher
archive allowlists these values; the semantic report counts them without
printing prompt text, canonical items, or answer hashes. Existing quarantines
and the exact native v2 compact receipt fence remain unchanged.

A read-only report over the retained October 11 diagnostic archive observed
36 SEM events, 10 rotations, 6 accepted compactions and 2 `anchor_missing`
failures; both missing-anchor details are `unknown` because the installed RC9
does not emit this new field. Native diagnostics observed 393 correlations,
370 with Codex-result records, and an overflow marker aggregating 29,851
dropped routine records (zero dropped actionable/invalid records). Correlation
coverage is **partial**; the count difference is not a count of stalled calls.
These are snapshot counts from a changing, capped archive, not an exhaustive
history.

Follow-up targeted checks: 5 PASS (three agreed recovery cases, the new
source-history classification and stale-anchor quarantine), 5 PASS diagnostic
report tests, 1 PASS archive-retention test, TypeScript and `git diff --check`
PASS using the available Bun 1.4.2. The repository's pinned toolchain is Bun
1.4.0; these checks alone do not replace the pinned release gate. Actual
authenticated Desktop recovery is still NOT RUN for this candidate.

Changes in this checkpoint are an **unreleased local candidate**; they are
not installed in the running RC9 application.

## Continuation verification

The saturated-archive regression retains both `operational_unknown` and the
new `anchor_missing`/`anchorDetail` fixture. Its focused launcher check passed
(1 PASS). The five selected broker/compaction/rotation and semantic-validation
regressions passed (5 PASS, 63 filtered). The diagnostic-report suite passed
(5 PASS); TypeScript and `git diff --check` passed with Bun 1.4.2.

A later read-only archive sample had 46 SEM observations, 7 accepted native
compactions, 2 `anchor_missing` events (both missing the new detail field), and
1 `operational_unknown` event. The sampled native diagnostic archive held 707
correlations, including 682 with a Codex-result observation; it also retained
an aggregate marker for 29,851 evicted routine observations. The difference
between correlations is **not** a verified tool loss count. No authenticated
Desktop replay was performed; the new classifier cannot retrospectively
diagnose failures already recorded by RC9.
