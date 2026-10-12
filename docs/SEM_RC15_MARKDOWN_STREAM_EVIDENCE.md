# RC15: stream reconciliation failure evidence

The observed RC14 failures at 09:38 and 09:41 (2026-10-12 Vietnam time)
reported `browser_stream_inconsistent` after the browser completion fence.
The existing failed-turn DOM snapshots contain no block-level reconciliation
metadata, so the original cause cannot be proven from those snapshots alone.

RC15 uses `verified` Markdown delivery in browser turns: source-ranged blocks
can stream; blocks that depend only on ephemeral DOM identity remain pending
until the answer completes. This mitigates one possible remount failure but is
not a proven fix for every stream reconciliation path.

On a future `ChatGptMarkdownConsistencyError`, the browser helper writes
`markdown-failure.json` to:

`~/.codex-chatgpt-web/diagnostics/browser-turns/<trace>-<attempt>/`

The launcher log also emits `markdown_failure_evidence` with the same trace ID
and counters. The report includes the failed observation stage, controlled
error reason, committed and pending block counts, ranged-block counts, total
character counts, observed block counts, and visible completion action state.
It **does not** persist response text, prompt text, HTML, DOM keys, link URLs,
content hashes, or screenshots of this failure. Recent Markdown failures have
their own 20-trace retention allowance, separate from ordinary successful
turns. The existing `turn-failed` diagnostic remains available for DOM-level
state information.

Compare `observedRangedBlocks` against `ledger.committedRangedBlocks` and the
`reason` on the next live failure before changing reconciliation rules again.
Unit and DOM regression tests do not prove browser/live production success.
