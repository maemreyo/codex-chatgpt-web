# Automatic diagnostic observations (14 days)

The instrumented Zam Codex Web launcher automatically archives **content-free**
`semantic_*` and `native_tool_diagnostic` events while the launcher is running.
No manual recording, ChatGPT submission, or external upload is performed.

## Retention and export

- The ordinary launcher activity log still rotates at 4 MiB plus one backup.
- In addition, recognized structured diagnostic events are retained locally in
  `app.getPath("logs")/diagnostic-observations/YYYY-MM-DD.jsonl`, with a maximum
  of 4 MiB per UTC day. Only the current day and the previous 13 UTC days are
  included in exports; older archive files are pruned during subsequent writes.
  When a day's limit is reached, later observations for that day are omitted
  from the archive (but the ordinary activity log continues operating).
- **Activity → Export safe log** combines the daily archives with the remaining
  ordinary activity logs, removing duplicates and preserving timestamp order.
  The existing `scripts/semantic-log-report.ts` and
  `scripts/native-tool-diagnostic-report.ts` can read the combined JSONL.
- Only events generated **after installing and launching this version** enter
  the new archive. Events lost in previous rolling logs cannot be reconstructed.

The archive recognizes only known diagnostic event types, hashed identifiers,
validated outcome enums, and bounded numeric counters. It discards arbitrary
error strings, tool arguments, prompts, browser content, and transcript text.
The normal activity log and its export can still include error strings: review
the exported JSONL for private data **before sharing**. Never send the raw
launcher log, browser state, or semantic trace files.

## After a few days of normal use

1. Use the newly built launcher normally, with `experimentalSemanticMemory`
   enabled only if you intend to test that experimental feature. It remains
   disabled by default. Native tool observations are independent of that flag.
2. After several days, open **Activity → Export safe log**, save the JSONL,
   and review it for sensitive data.
3. Share the reviewed file and provide approximate incident times/timezone,
   affected model and effort, whether Semantic Memory was enabled, and observed
   symptoms. A missing event does not establish that a call never occurred:
   diagnostics are best-effort and can hit daily limits or relay failures.

This is passive observation, not a live authenticated integration test or
permission to retry an operation rejected by safety controls.
