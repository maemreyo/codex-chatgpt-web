# Semantic Epoch Memory

Status: experimental, opt-in, default off.

## Active tool-result pressure policy (2026-10-10)

At the user's explicit request, accumulated occupancy and unknown occupancy are
advisory. They emit a content-free pressure warning and deliver the complete,
unchanged pending tool-result batch normally. They do not require canonical
compaction and do not emit `chatgpt_active_turn_compaction_required`. This policy
supersedes the earlier strict S6 pressure-boundary requirements below.

If an individual result is larger than the browser's physical working set,
the active tool broker now retains its exact JSON-encoded canonical content in
memory, scoped to that one turn, and delivers a short reference to ChatGPT.
This output guard also runs on the ordinary automatic ChatGPT Desktop route
when SEM history projection is disabled. It does not require enabling SEM.
The read-only `codex_result_chunk` MCP operation retrieves up to 8,192 characters
per call, requiring the same turn binding and a matching reference/offset.
The full result in the native Codex request remains unchanged. No tools are
re-executed, reconnect replay remains idempotent, and all references expire
when the turn's broker capability retires. No raw outputs are saved to logs
or long-lived diagnostic files.

Broker-held references are limited to 8,000,000 characters per result and
24,000,000 characters per turn. Results beyond this bound still produce the
typed capacity error rather than silently losing content or failing after a
partial batch. Explicit canonical compaction and browser rejection handling
remain available. A physical browser rejection is still possible.

Native `codex_exec` and `codex_write_stdin` now request at most 4,096 output tokens
by default when the advertised native tool supports `max_output_tokens` (and for
the Codex exec gateway). An explicit caller-selected limit is respected; an older
native tool without the parameter remains unchanged. This bounds routine command
output at the native execution boundary without rewriting the canonical result
after it is returned. For large investigations, write output to a workspace file
and read bounded ranges, without re-running commands that may have side effects.
Other tools and explicitly large outputs can still exceed the bounded
broker-reference capacity. Treat those errors as actionable capacity limits;
do not replay a previously executed tool or silently drop evidence.

Desktop MCP invocations retain the bounded 90-second deadline below the
documented 120-second tunnel response limit. Long command sessions should
return a native session handle and use bounded polling; an elapsed MCP timeout
retires the turn binding rather than re-executing an ambiguous native effect.
Explicit shorter owner leases still apply. Broker shutdown terminates
incomplete socket requests and waits for in-flight socket startup before exit;
a failed startup can be retried after the obstruction is removed.
The updated MCP tool schema requires launcher/connector protocol v6 alignment.

## Bigger Context compatibility

SEM can run alongside Bigger Context in automatic ChatGPT browser mode. Bigger Context retains
its configured up-to-3× context behavior where supported, including the actual model/Codex
context limit for the active account and model. SEM changes the browser-facing representation
of settled history; it does not increase, replace, or silently shrink that reported logical
context limit. Canonical token accounting still follows the full history.

The physical browser request and staged-message limits remain separate from the configured
logical limit. SEM must keep each browser submission within those physical limits even when
Bigger Context is enabled. SEM's separate logical-window increase remains disabled pending
in-use diagnostics. Combined SEM + Bigger Context behavior is still experimental and requires
live-session acceptance; UI compatibility does not establish that acceptance.

On the canonical Bigger Context fallback path, each multipart stage is preflighted under
its actual staging effort; the final part is checked separately under the requested
effort and its learned rejection ceiling. Active SEM epochs use one inline browser
submission, never multipart. When the Launcher loses the retained tab, the full
projected prompt is preflighted before sending, and the physical occupancy ledger
is rebased for the fresh conversation. Reused tabs retain
their existing occupancy evidence; occupancy that cannot be reconstructed is advisory for
tool-result delivery. `semantic_cost` is emitted only for active SEM epochs after
a successful browser response or an acknowledged submission; failed attempts
before submission are excluded.
The physical tool-result guard also applies to the first canonical turn and
epochless fallbacks when SEM is enabled. A retained tab without a verified
process-local occupancy ledger emits an advisory warning while delivering the batch. For
canonical Bigger Context, accepted multipart stages and the final submission
are charged to that physical ledger; individual oversized tool results return
the terminal `semantic_atomic_result_too_large` error because Web compaction
cannot fit them either. Native Codex's response to recovery error codes still
requires independent integration acceptance.
When an active compaction's tool-result batch is only partially acknowledged,
the retained browser source is canceled and its broker capability revoked.
An acknowledgement failure may mean the browser received the result already;
the bridge does not resend the uncertain remainder to that same source. This
fail-closed rule also applies to Zero Risk compaction. The canonical native
tool results remain unchanged, and end-to-end recovery still needs acceptance
with a real native Codex client and authenticated browser session.
Invalid epoch provenance creates a durable, per-thread quarantine that forces
the canonical path until the original history is recoverable. For a completed
native v2 Web compaction, the bridge persists only a digest of its summary;
quarantine clears when the same native thread later replays that exact summary
as its latest `compaction` output item. A failed compaction, unverified user-text
summary, or unrelated checkpoint does not clear quarantine. This acceptance
path has offline adapter tests and still needs authenticated native acceptance;
native v1/memento replay remains quarantined until a separate verified policy.

Rotation and Web-compaction limits are keyed by native thread identity within
the durable cost-budget file. Legacy V1 budget entries were hashed with mutable
provider settings and cannot be safely attributed. Upgrading a nonempty V1
file conservatively prevents new reservations until its previous charges
expire (at most one hour), then writes V2 with stable thread keys. Older
versions must not write a V2 file concurrently with this runtime.
`extraStageSubmissions` is currently always `0` because those epochs use inline
transport. Canonical Bigger Context multipart fallback does not emit a
`semantic_cost` event, so this field does not measure fallback stage submissions.
Do not interpret `0` as evidence that canonical fallback used no stages.
The SEM inline preflight uses the ordinary single-message context window even
with Bigger Context enabled. Learned rejection ceilings also apply before
canonical multipart fallback. Retained-epoch reuse checks both incremental
resume and full fresh-tab reseed before selecting the browser lease.

## Goal

Keep substantially more canonical Codex history than one ChatGPT browser request can physically
carry, while preserving exact authority, current-turn evidence, and tool-call/result pairing.

## Recovery evidence and managed compaction routing

Recovery evidence is retained through canonical entry binding. Native v2 compaction items are
recovery evidence only when their canonical identity and retained entry binding are preserved;
caller-provided protocol fields do not select the trusted classification. The managed direct
runtime has verified the new-page reset path through a fresh retained conversation boundary.

The same-session reconnect path preserves the recovery ledger so retained evidence remains bound to
the existing semantic epoch. These properties are covered by protocol tests with the managed fake
adapter; browser execution and authenticated live model sessions remain separate acceptance gates.

## Non-negotiable invariants

1. Canonical Responses history is never destructively rewritten by semantic projection.
2. Current native turn input remains exact.
3. Open tool batches and their results remain exact in canonical history. Oversized browser-facing
   results may use a turn-bound, lossless read reference while native history stays unchanged.
4. Environment, user-revision, subagent-lineage, and reasoning-envelope checks continue to read
   canonical wire provenance.
5. Browser physical limits remain measured transport limits even after Codex logical limits diverge.
6. A semantic checkpoint is advisory task state; bridge-owned hashes/refs bind it to canonical
   evidence. Any mismatch falls back to canonical history.
7. Semantic epoch rotation is independent of native Codex `/compact`.
8. The legacy path remains available while `experimentalSemanticMemory` is false.

## Integration boundary

The projector belongs after `parseRequest()` and authority validation, but before browser prompt
construction in the `startRuntime()` preparation path. It must project a browser-facing clone and
must not replace the canonical parsed request used for identity, provenance, or tool settlement.

Within one semantic epoch, retained-chat suffix continuation remains unchanged. When a semantic
working set ages out, the bridge commits a checkpoint, increments a semantic epoch, rotates to a
fresh retained browser conversation, and sends checkpoint + exact working set.

## Context budgets

`resolveChatGptWebPhysicalContextLimits()` owns measured ChatGPT browser limits. The existing
`resolveChatGptWebContextLimits()` remains the logical/Codex seam and currently aliases physical
limits. A later guarded phase may raise the logical window only after semantic projection is able to
keep every physical browser request within the measured limit.

## Rollout order

1. Add the default-off feature flag and separate physical-limit resolver. No behavior change.
2. Add versioned semantic checkpoint storage and exact binding metadata.
3. Add browser projection with exact current turn/tool evidence and fallback-to-canonical tests.
4. Add semantic epoch identity to retained conversation keys.
5. Split logical vs projected usage accounting and validate native auto-compaction behavior.
6. Raise the logical Codex context budget only after the large-context DEV harness passes.
7. Replace quadratic `previous_response_id` snapshots with a versioned parent+delta representation,
   retaining v1 read compatibility during migration.

## Acceptance gates

- Existing default-path tests remain unchanged and green.
- Active native tool results remain byte-for-byte canonical; referenced browser results must be
  readable in bounded ranges and must never execute the original tool again.
- User revision/environment/subagent provenance tests pass under projected history.
- Restart/replay and `previous_response_id` recovery remain deterministic.
- A large synthetic task can retain roughly 220-240k canonical tokens while projected browser input
  remains inside the measured physical window.
- Disabling the feature flag restores the pre-feature behavior without state migration.
