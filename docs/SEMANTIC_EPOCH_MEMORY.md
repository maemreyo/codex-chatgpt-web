# Semantic Epoch Memory

Status: experimental, opt-in, default off.

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
their existing occupancy evidence; occupancy that cannot be reconstructed fails closed for
tool-result delivery. `semantic_cost` is emitted only for active SEM epochs;
`extraStageSubmissions` is currently always `0` because those epochs use inline
transport. Canonical Bigger Context multipart fallback does not emit a
`semantic_cost` event, so this field does not measure fallback stage submissions.
Do not interpret `0` as evidence that canonical fallback used no stages.

## Goal

Keep substantially more canonical Codex history than one ChatGPT browser request can physically
carry, while preserving exact authority, current-turn evidence, and tool-call/result pairing.

## Non-negotiable invariants

1. Canonical Responses history is never destructively rewritten by semantic projection.
2. Current native turn input remains exact.
3. Open tool batches and their results remain exact and are delivered from canonical history.
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
- Active tool results are byte-for-byte canonical at delivery.
- User revision/environment/subagent provenance tests pass under projected history.
- Restart/replay and `previous_response_id` recovery remain deterministic.
- A large synthetic task can retain roughly 220-240k canonical tokens while projected browser input
  remains inside the measured physical window.
- Disabling the feature flag restores the pre-feature behavior without state migration.
