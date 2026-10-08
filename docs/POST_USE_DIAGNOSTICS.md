# Post-use diagnostics for Zam Codex Web 6.1.7

The upstream 6.1.6 integration into the local 6.1.7 candidate was merged into
`feat/semantic-epoch-memory` at commit `1424093`. The owner requested that
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

## Investigating intermittent Codex Native2 safety-status refusals

Related report: [upstream #342](https://github.com/miuuyy/codex-chatgpt-web/issues/342)
(closed as not planned; needs a reproducible trace). For the reported local
case, record the model (`chatgpt-web/gpt-6-sol`), effort (`high`), CLI version,
number of concurrent agents, affected tool, approximate time, and whether user
confirmation changed the observed outcome. Do not include raw command text,
arguments, prompts, repository content, keys, or browser snapshots in shared logs.

The bridge emits fixed-field `native_tool_diagnostic` events:

| Event stage | Evidence established |
| --- | --- |
| `browser_safety_text_visible` | The assistant-turn UI included the known safety-status phrase; text matching alone cannot identify the refusing system. |
| `mcp_ingress` | A `tools/call` message reached local MCP transport. |
| `handler_entered`, `broker_claimed` | The MCP handler started; the latter means its claim returned from the broker. |
| `broker_claim_with_turn` | The daemon associated that claim with a browser turn trace. |
| `broker_invoke_requested`, `broker_queued` | MCP attempted broker dispatch; the daemon queued a native invocation. |
| `broker_delivered_to_codex_adapter` | The adapter received the invocation for Codex. This is not proof that a hook or tool ran. |
| `codex_result_received` | The broker received Codex's result; `outcome=is_error` does not identify whether a hook, policy, sandbox, or tool failed. |
| `broker_invoke_settled`, `handler_result`, `mcp_reply_sent` | Results returned through the corresponding boundaries; `is_error` is recorded without result text. |
| `handler_failed`, `broker_invoke_failed`, `mcp_reply_send_failed` | That boundary failed; only an enumerated category is logged. |

For safety, MCP transport/handler diagnostics travel from the separate MCP
process to the daemon through a **best-effort, bounded** local broker relay.
The existing launcher logger stores and rotates those events for Activity export.
If the relay itself fails or logs rotate away, an absent event cannot prove the
request never arrived. Each received call has a per-process, salted
`diagnosticId`; correlated broker events also have a local `traceId`.

Run this read-only aggregate on a reviewed **Activity-exported** file:

```sh
bun run scripts/native-tool-diagnostic-report.ts "/absolute/path/to/exported-diagnostics.jsonl"
```

It reports observed ingress, lifecycle stages, error flags, and up to 50 recent
correlations without echoing arbitrary log content. `safetySignals` lists hashed
turn references and how many calls with matching broker traces had observable
ingress. A signal with zero ingress means **no matching ingress was observed in
the retained log**, not confirmed upstream blocking. UI wording may change,
and safety warnings outside the assistant-turn text may not be detected.

To reproduce after installing an instrumented build, perform an ordinary
authorized read-only repository inspection in Full mode. Record success or the
exact user-visible refusal, then export Activity promptly and inspect the JSONL
before sharing. Compare affected and successful agents by `diagnosticId` and
hashed turn, without resubmitting refused commands through another route.
Do not treat this instrumentation or focused tests as an authenticated live
reproduction or a fix to OpenAI's classification behavior.
