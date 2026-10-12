# RC14: confirmed composer readback false positive

Observed on installed RC13 on 2026-10-12, approximately 09:08-09:10
Asia/Ho_Chi_Minh. Trace: `c60ecb76e639_fallback`. Baseline commit `8482a60`
plus the uncommitted RC13 diagnostic and RC14 reader patches.

## Live findings

All six pre-cleanup mismatch records across three attempts agree:

| Measurement | Result |
| --- | --- |
| Draft before edit | 0 characters |
| Editing command | Applied successfully |
| Immediate text, compared with intended text minus structural LF | Complete match |
| Expected complete prompt | 55390 UTF-16 units |
| Default reconstructed prompt | 55983 units |
| Unchanged prefix / suffix | 42627 / 12763 units |
| Inserted region | 593 units; no source units replaced or deleted |
| Reconstruction excluding aria-hidden UI | Exact 55390-unit match |
| Reconstruction excluding noneditable UI | Exact 55390-unit match |
| Raw DOM text changed after editing | Yes |
| CSS-hidden text | 0 units |
| Noneditable / aria-hidden elements | 22 / 12 |

The initial paragraph edit and BR-based recovery both produce this result.
Content-free evidence is retained in `SEM_RC13_LIVE_MISMATCH_EVIDENCE.json`.

The confirmed mechanism is that editor hydration introduces accessibility-
excluded UI text and the bridge reader includes it in prompt reconstruction.
The complete intended prompt remains present outside that UI. This is not
evidence of truncation, CRLF conversion, or a 64000-unit insertion limit.
The exact widget containing the extra text was not retained; no original DOM
HTML or private text was archived.

## Fix

The production DOM reader excludes `aria-hidden=true` decoration from its clone
before reconstructing prompt text. Explicitly editable nodes and containers
with editable descendants are preserved. Ordinary noneditable token labels
are preserved. Literal HTML source remains literal text and is not removed.
The entire reconstructed prompt must still match the intended prompt before
Send; no tolerance for inserted, deleted, or replaced source text is added.
Browser editing, native history, tool execution and compaction receipts are
unchanged. RC13 content-free diagnostics and failed-trace retention remain.

## Verification

- Composer and worker regression checks: **182 PASS / 1 SKIP / 0 FAIL**,
  1175 assertions on Bun 1.4.0.
- The new production-path regression models late 593-unit aria decoration at
  offset 42627 in both observed DOM layouts. The complete prompt passes the
  actual reader and assertion. Added ordinary noneditable authored labels
  remain mismatches, literal markup survives, and editable aria islands survive.
- Runtime TypeScript and version synchronization: **PASS**.
- Three SEM regressions: **3 PASS / 0 FAIL**, 50 assertions.
- Independent source review: no actionable blocker; nested editable islands
  and live RC14 acceptance remain unverified.
- Local macOS arm64 packaging, code-signature verification, package smoke
  (`PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64`) and DMG checksum validation: **PASS**.
  Candidate is ad-hoc signed, not notarized, and not published/promoted.
- Bundle ID: `528f4768acfb53724460aa1f7f4a14bbd81327b41e21821ff49e6c2a29daf5ab`.
  Browser helper SHA-256:
  `7021658b34900c151ed9041657636af43335f96e5e83ab7a81df15e9f83e0db1`.
- DMG SHA-256:
  `a16c0842c7250e0cf0325f859f8c5e7b123d5853d1646c1b64117ebde90195b1`.
- ZIP SHA-256:
  `fd6bd044a099ff967c18f971551028f189018640013b53c0485157673f461617`.

## Installed RC14 acceptance, 2026-10-12

Installed daemon and browser helper match the RC14 candidate above. Browser
compact trace `a465a7baeb43_fallback` used the same 55390-unit part 4, acknowledged
parts 1-5, submitted the final part, and completed at `2026-10-12T02:25:30.111Z`
(09:25:30 Asia/Ho_Chi_Minh). No attachment mismatch or browser-turn failure was
observed after RC14 startup in the inspected log interval. The user reports the
compact worked. All recorded browser diagnostic checkpoints captured successfully.

Runtime `/healthz` reports version RC14 and accepts turns. A direct read-only
tunnel status probe reports `process_running=true`, `healthy=true`, `ready=true`.
Startup recorded three unhealthy tunnel observations; the current probe is
healthy. The supervisor snapshot reports ready but omits the live tunnel PID,
so status persistence remains an investigation item rather than a proven outage.

Remaining dimensions: a normal Web turn after this compact was not present in
the inspected interval, and a new completed native-history compact record was
not independently located in the previously used rollout. Actual browser/broker
disconnect recovery and SEM rotation still lack complete live RC14 acceptance.
The fallback reason remains `source_unavailable_before_handoff`, meaning this
run used fresh multipart staging. Recovery from a genuine late-stage failure
still restarts acknowledged staging work. None of those open dimensions imply
that the observed part-4 false-positive integrity error persisted.
