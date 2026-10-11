# RC10 composer integrity recovery — local candidate review

Historical intermediate candidate. The final RC11 implementation and validation
are recorded in [SEM_RC11_RECOVERY_RELEASE_REVIEW.md](SEM_RC11_RECOVERY_RELEASE_REVIEW.md).
The checks below apply to that earlier patch, not the current source tree.

Date: 2026-10-11 (Asia/Ho_Chi_Minh). Source branch:
`codex/sem-rc10-release-1011`; parent commit `5f25bd1`.

## Scope

An installed RC10 browser turn reported a composer readback mismatch at about
260k UTF-16 code units. The candidate retries attachment once, before Send,
only after verifying that no new user turn appeared. It clears the composer,
inserts the original prompt in bounded 64k-code-unit plain-text edits, and
requires the complete post-edit readback to match. Intermediate multipart
stages and final prompts share the same retry. This does not retry an uncertain
submission or mutate the canonical native history.

The precise cause of the originally observed extra/missing composer text has
not been established. The retry is a bounded mitigation, not a verified fix
for every ChatGPT Lexical failure.

## Local verification

- Pinned Bun 1.4.0: browser-worker and compaction-browser-recovery suites:
  **166 PASS / 0 FAIL**, 1,237 assertions.
- Pinned Bun 1.4.0: root TypeScript `tsc --noEmit`: **PASS**.
- Three selected SEM recovery tests: broker disconnect without tool replay,
  native-v2 quarantine recovery, and 220–240k-token epoch reuse:
  **3 PASS / 0 FAIL** (27 filtered).
- Isolated headless Chromium (no account or network): inserting a 260,235-unit
  LF multiline payload containing backticks, JSON-like text, Unicode, and
  surrogate pairs in five plain-text edits produced **exact complete readback**
  under the bridge's current child-node text extraction.
- Isolated Chromium also normalized input CRLF to LF. A CRLF-containing draft
  therefore **fails exact readback**; this is an observed browser limitation,
  not evidence that the native canonical prompt was modified.
- `git diff --check`: **PASS**.

The Chromium fixture is a plain contenteditable surface; it is not the real
ChatGPT Lexical editor. Authenticated Desktop composer replay, broker disconnect,
native compaction, and SEM rotation E2E remain **NOT RUN** for this candidate.

## Installed RC10 diagnostics (read-only)

Between 15:00:00Z and 16:26:02Z, sampled launcher `browser_settled` records
showed 19 `final` and six `error` results (including two client cancellations).
The six error codes were `client_cancelled` (2),
`prompt_attachment_integrity`, `browser_stream_inconsistent`,
`upstream_server_error`, and `model_version_unavailable` (one each).
SEM logs showed seven rotations, eight epoch-commit events, four accepted native
compactions and one canonical fallback. These are observed event counts in
retained logs, not complete execution receipts or proof of SEM causation.

The installed app remains **6.1.8-rc.10**; this candidate is not yet built,
packaged, published, or installed. The app/profile and running broker were not
changed during this review. Stable readiness remains gated on authenticated
Desktop acceptance and investigation of the remaining browser failures and
quarantined legacy SEM epochs.
