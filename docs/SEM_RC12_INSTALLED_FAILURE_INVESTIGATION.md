# Installed RC12 composer failure investigation

Date: 2026-10-12, Asia/Ho_Chi_Minh. Investigation baseline: `8482a60`.
Status: both investigations complete. No new implementation or release;
installed composer root cause remains unconfirmed.

## Installed identity

The running daemon uses `versions/6.1.8-rc.12-darwin-arm64/app/cli.js`.
The installed manifest reports `appVersion: 6.1.8-rc.12`; the browser helper
matches its manifest SHA-256:
`77507090d8937c022eedd36974512b35f1d29bbdc407207ec69fcfbe544b8383`.
This is a failure on installed RC12, rather than evidence of an old runtime.

## Observed failing compact

Trace `72ace06cd16f_fallback` failed during part 4 of 6 on three attempts.
Failure times from launcher records (UTC):

- `2026-10-11T21:17:19.998Z`
- `2026-10-11T21:18:09.751Z`
- `2026-10-11T21:19:37.485Z`

Each reports `expectedChars=55390`, `actualChars=55983`, and
`commonPrefixChars=42627`. Each attachment was retried before failure.
The original part 4 was not observed reaching Send.

Content-free diagnostics for the last attempt show:

| Edit | DOM text units | Paragraphs | BR elements | CR / LF text counters | Selected connectors |
| --- | ---: | ---: | ---: | --- | ---: |
| Initial | 55966 | 18 | 0 | 0 / 0 | 0 |
| Recovery | 55966 | 1 | 17 | 0 / 0 | 0 |

Changing block representation did not remove the excess text. It is not yet
proved that changing the 64000-unit chunk threshold resolves this mechanism.
Private prompt text, HTML, commands, and response bodies are not retained here.
The diagnostic directories were subsequently pruned by continued runtime use;
the counters above were read before pruning.

## Input shape and evidence limits

A content-free scan of the original native history found no CR characters and
no unusual C0, U+0085, U+2028, or U+2029 characters in response-item strings.
The previous CRLF synthetic scenario does not establish the cause of this
installed failure. Browser insertion, editor transformations, and readback
must still be distinguished using a representative reproduction.

The native history also contains a completed compact record at
`2026-10-11T21:19:04.546Z`. A separate launcher semantic acceptance record was
previously observed at `2026-10-11T21:20:05.233Z`. These must not be attributed
to the failed trace merely because their times are close.

## Parallel investigation

Two agents investigate disjoint scopes:

1. Composer insertion/readback, shortcomings of existing reproductions, and a
   concrete regression for the installed +593 signature.
2. Multipart retry, compact receipt correlation, post-compact continuation,
   and `anchor_missing` / `compaction_boundary_present` SEM fallback.

No browser Send, native tool replay, runtime restart, or installation was
performed during this investigation. Live recovery acceptance remains open.

## Composer investigation result

The composer agent reproduced all numeric observations with a synthetic hidden
inline element containing 593 characters at offset 42627. Both the 18-paragraph
and 1-paragraph/17-BR layouts reproduced the error. This establishes diagnostic
ambiguity, not that hidden text caused the installed failure.

The existing 593-inline-span test checks a historical reader that inserted
newlines between spans; the current reader already handles that fixture. The
CRLF fixture deliberately adds carriage returns absent from the installed
diagnostics. Simplified offline contenteditable fixtures do not model ChatGPT's
editor reconciliation. These checks remain useful regressions but do not prove
the production mechanism was fixed.

Source ownership: `browser-worker.ts` insertion (2383-2431), text equivalence
(2493-2527), DOM readback (3530-3589), integrity check (3591-3613), and recovery
insertion (4306-4352), at the investigation baseline.

The next diagnostic slice should compare insertion and reconciliation in memory
and persist only counts, offsets, code-unit categories, and DOM structural
counters. It must distinguish real mutation, hidden/duplicate text, and reader
reconstruction. Retain failed trace counters long enough to inspect them.
Neither broad hidden-node exclusion nor relaxation of complete-prompt checks is
justified by the available evidence.

## Recovery audit result

Confirmed P1: failed compact retries start staging again from part 1. Each of
the three attempts acknowledged parts 1-3 before failing at part 4, for nine
acknowledged staging submissions without a successful part-4 submission.
Acknowledged stages are scoped to one browser run (`browser-worker.ts:5565`);
fresh fallback creates another runtime (`index.ts:1816`), and failed exact
compaction runs are evicted after physical settlement
(`compaction-handoff.ts:662`). This proves repeated staging work, not duplicated
native tools or duplicated Send within one conversation.

Resuming a stage requires the same verified conversation, transaction and
payload bindings, plus independently revalidated acknowledgement receipts.
Uncertain submission must reconcile first; a caller retry cannot simply trust
a remembered part number. A regression should fail pre-Send at part 4 after
parts 1-3 have been acknowledged, then recover without duplicate effects or
ambiguous Send.

The `anchor_missing` / `compaction_boundary_present` fallback is not currently
proved to be an incorrect rejection. The detail means a compaction boundary
exists while the saved anchor is absent (`semantic-projection.ts:83`); it does
not identify which compact invalidated it. The affected epoch is quarantined
and canonical fallback remains available within physical limits
(`index.ts:648`). Recovery matches the latest native compact summary digest
against the recorded completed receipt (`semantic-epoch-store.ts:382`).

Successful separate compact trace `12be03f85593_fallback` acknowledged parts
1-5, submitted the final request at `2026-10-11T21:18:04.326Z`, and completed at
`2026-10-11T21:19:03.728Z`. The native completed compact at
`2026-10-11T21:19:04.546Z` follows this run. A subsequent normal turn submitted
and completed at approximately `2026-10-11T21:23:31Z`. The later semantic
acceptance has the same thread hash, but exact receipt-to-compact association
was not independently established. One successful path does not clear the
other trace's repeatable composer failure.

## Verification and continuation

- Both agents performed read-only investigation; no source patch was made.
- Composer agent ran `bun test tests/composer-insert.test.ts
  tests/long-composer-chromium.test.ts`: 14 PASS / 1 SKIP / 0 FAIL, with macOS
  arm64, headless Google Chrome, Playwright and an offline browser context.
  Inline Bun probes were not persisted. This is not live ChatGPT acceptance.
- Recovery agent ran no tests; its evidence is source and runtime records.
- Parent ran `git diff --check`: PASS; only this report was added.
- No runtime restart, history reset, installation, commit, push, or release.

Implementation priority is to obtain content-free evidence distinguishing real
editor mutation from duplicate/readback text, then repair that exact mechanism.
Transaction-bound recovery and retention of failed diagnostic counters address
the confirmed repeated work and lost evidence. The composer integrity error
must not be reported as fixed until the original compact and following normal
turn complete on the installed candidate.
