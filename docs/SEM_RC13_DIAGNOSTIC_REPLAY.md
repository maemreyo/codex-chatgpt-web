# RC13: one-replay composer diagnostics

Candidate: `6.1.8-rc.13`, based on `8482a60` plus the local diagnostic patch.
Purpose: collect evidence for the installed part-4/6 failure. This candidate
does not claim that the underlying composer corruption is repaired.

## Measurements

The browser editing command now reports its boolean outcome, raw text counts
before and immediately after the command, and character-category comparisons
against the intended prefix. Raw text is temporary attachment-local memory.

Before a failed draft is cleared, a bounded probe records:

- Complete reconstructed prompt comparison, common prefix/suffix, changed-region
  counts, and fixed code-unit categories without literal character values.
- Whether the expected text is a subsequence of the observed text and the
  category counts of additional units. This helps distinguish inserted escaping
  from replacement or omission; it does not identify characters by value.
- Comparisons using CSS-visible text, aria-hidden exclusion, noneditable-node
  exclusion, and rendered innerText. These are advisory diagnostics only.
- Counts of hidden text, paragraphs, BRs, spans, links, math, code and text nodes.
- Whether raw text changed between the editing command and the failed integrity
  check, and which edit strategy/chunk was used.

No prompt fragments, raw HTML, commands, content hashes, or response bodies are
included. Integrity-failure captures suppress screenshots even if general
screenshot debugging is enabled. Unavailable probes are explicitly marked and
do not replace the original attachment error or prevent cleanup.

## Artifact retention

The event `composer_attachment_diagnostic` is written to launcher runtime logs.
The complete numeric report is also saved as `attachment-failure.json` within
`~/.codex-chatgpt-web/diagnostics/browser-turns/<trace>-<attempt>/` and within
the numbered mismatch checkpoint. Retention keeps 20 failed attachment traces
separately from 10 ordinary settled traces. Active traces have PID-bound markers
until their diagnostic owner settles; abandoned markers expire after 24 hours.

## Single replay

Install and restart the diagnostic candidate when existing active work has
settled. Confirm both launcher/runtime version `6.1.8-rc.13`, then run the
reported compact once in the existing task. If it fails, preserve that result
and inspect its trace; repeated manual retries are unnecessary for collection.
If compact succeeds, send one normal continuation to check the other reported
failure boundary. Existing attachment recovery may make its own one pre-Send
retry, and both attempts are captured independently.

Interpretation:

- Immediate mismatch with a clean pre-edit draft locates the divergence within
  browser editing or synchronous editor handling.
- Immediate raw text followed by a different settled raw value locates a later
  reconciliation mutation.
- A complete CSS-visible reconstruction with excess hidden text identifies a
  reader contribution; it does not by itself prove ChatGPT's outgoing serializer.
- If advisory reconstructions all remain wrong, category/subsequence evidence
  identifies inserted versus replaced/deleted units for the next exact fix.

Do not relax Send verification or replay native tools based on these probes.

## Verification

- Bun 1.4.0 focused composer/worker checks: **181 PASS / 1 SKIP / 0 FAIL**,
  1167 assertions, with `bun test tests/composer-diagnostics.test.ts
  tests/browser-worker-contract.test.ts tests/composer-insert.test.ts
  tests/long-composer-chromium.test.ts`.
- The three requested SEM regressions: **3 PASS / 0 FAIL**, 50 assertions,
  with the exact RC12 report's filter on `semantic-adapter-recovery.test.ts`
  and `turn-broker-lifecycle.test.ts`.
- Runtime TypeScript, version synchronization, renderer build and
  `git diff --check`: **PASS**. Relocatable runtime smoke: **PASS**.
- Independent source review found no remaining blocker after screenshot and
  active-trace retention fixes. Cross-process pruning races and disk-write
  failures are not verified by these checks.
- Local macOS arm64 packaging, code-signature verification, packaged launcher
  smoke (`PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64`) and DMG checksum validation:
  **PASS**. This is an uncommitted diagnostic candidate, not a published or
  promoted stable release. The macOS candidate is ad-hoc signed, not notarized.
- Initial packaging hit a Code Signing subsystem error; its retry hit ENOSPC.
  Only this task's failed staging directories were removed. Packaging then
  succeeded with the same frozen runtime.
- Bundle ID: `69a3b840a559dd2d25d2c52bb0162ebf319fe3b1dbe8e7cf7ea77c5168f07a2a`.
  Browser helper SHA-256:
  `f7f7e1ca45759b0c24e99dd239ffe5dad5c3cd49f87310159daefc7386f2f6ed`.
- DMG SHA-256:
  `5a05435090ed0fbc42c6616b3024fda4cfc48e79f6be170053cf3212570d4d9a`.
- ZIP SHA-256:
  `e3875f31cb4c89b1e5a66202b09bb1f69430bb35e2eacd51a488b1d228c84718`.

The original failing native compact has not been replayed with RC13 yet.
