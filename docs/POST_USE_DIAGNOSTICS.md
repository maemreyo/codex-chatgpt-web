# Post-use diagnostics for Zam Codex Web 6.1.7

The upstream 6.1.6 integration into the local 6.1.7 candidate is staged in the
`codex/sync-upstream-v6.1.6-into-zam-v6.1.7` worktree. The owner requested that
authenticated/live ChatGPT testing be deferred until they use the build. Keep
the diagnostic path below available for that handoff.

## Capture after using the candidate

1. In the **Zam Codex Web** launcher, open **Runtime activity** (**Activity**)
   and select **Export safe log**. Save the resulting `.jsonl` file.
2. Export soon after reproducing an issue: `launcher.jsonl` rotates at 4 MiB
   and retains only the current file plus the previous rotation (`.1`).
3. Before sharing, review the exported file for private content. The exporter
   redacts known sensitive fields, credential formats, usernames, and URL paths,
   but arbitrary error messages may still contain sensitive data.
4. Include the approximate time and timezone, model and thinking effort,
   whether `experimentalSemanticMemory` was enabled, the observed error, and
   concise reproduction steps. Send the **exported copy**, not the raw log.

The launcher stores its original log at `app.getPath("logs")/launcher.jsonl`.
It captures daemon stdout/stderr, including structured `semantic_*` events when
Semantic Epoch Memory is enabled. These events include numeric counters,
enumerated outcomes, and hashed thread IDs, rather than prompt/checkpoint text.
The launcher also records runtime and startup errors. The original log and
browser diagnostic snapshots are local; **do not send browser snapshots or
semantic trace files** as a substitute for the reviewed export.

For a local aggregate of the semantic events, from this repository run:

```sh
bun run scripts/semantic-log-report.ts "/absolute/path/to/exported-diagnostics.jsonl"
```

That command reads the exported file locally and produces counts of turns,
rotations, skips, rejections, fallbacks, and affected hashed threads. It does
not send a request to ChatGPT. If no `semantic_*` events appear, confirm that
the feature was enabled in the build that generated the log; it is default off.

This log collection process supports later field diagnosis. It does not count
as live end-to-end acceptance or authorize publishing the candidate as stable.
