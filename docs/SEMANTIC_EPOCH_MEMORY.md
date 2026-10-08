# Semantic Epoch Memory

Status: experimental, opt-in, default off.

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
