# SEM + Bigger Context — macOS RC4 acceptance record

Date: 2026-10-09. Integration worktree: `codex/sem-rc4-integration`, based on
`61dbe9d` (RC3 agent cards, quota controls and SEM settings). The existing
dirty SEM worktree at `codex/live-subagent-smoke-gpt6` was preserved.
This record describes the local integration candidate and the subsequent
read-only/live checks. Commit, push, installation, and publication status are
reported separately; a successful Codex continuation does not prove SEM reuse.

## Verified candidate

- Version: **6.1.8-rc.4**, macOS ARM64, Bun **1.4.0**.
- Runtime bundle: `dist/runtime`; schema v2 manifest with 6,030 files.
- Distributables: `launcher/artifacts/codex-web-gpt-6.1.8-rc.4-mac-arm64.dmg`
  and `.zip`. Ad-hoc signed and verified during packaging; not notarized.
- SEM/Bigger Context recovery regressions on the RC3 UI/runtime base: **28 pass,
  0 fail** across six focused test files.
- Cross-impact browser worker, usage, semantic projection/store/provenance/cost,
  launcher-helper and agent-preset tests: **197 pass, 0 fail** across nine files.
  The legacy multipart-cost fixture was updated to enforce the current invariant:
  a semantic epoch is an inline browser message; any Bigger Context multipart
  fallback retains canonical evidence without adding phantom SEM stages.
- Launcher agent, quota, runtime-install, SEM Settings and state tests:
  **33 pass, 0 fail**.
- TypeScript typecheck (root and launcher), version synchronization, and
  `git diff --check`: **PASS**.
- Relocatable runtime smoke: `RELOCATABLE_RUNTIME_SMOKE_OK`.
- Packaged macOS smoke: `PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64`.

Tests use local fake workers and isolated runtime state. They do not establish
authenticated browser acceptance, accurate billed-token savings, or readiness
for an experimental logical window.

## Prior installed RC3 — read-only live observations

Before the RC4 upgrade, the installed app was **6.1.8-rc.3**. A read-only
diagnostic inspection of its launcher log observed:

| Metric | Observation |
| --- | ---: |
| SEM events / threads | 49 / 5 |
| Recorded semantic turn events / rotations | 2 / 2 |
| Masked historical tokens (estimate only) | 186,619 |
| Cost samples / equivalent legacy submissions | 2 / 2 |
| Reseed input tokens (estimate) | 96,524 |
| Extra stage submissions | 0 |
| Validation: missing anchor / digest mismatch | 21 / 1 |
| Legacy fallbacks due to active-epoch validation | 19 |

These events came from the installed RC3 process, **not** RC4. They do not
independently prove completed browser submissions. A missing
covered-history anchor requires conservative recovery; bypassing that
validation would risk losing canonical history or developer authority.
The diagnostic script emits only bounded categories and counts, without
echoing prompts, tool output or credentials.

## Installed RC4 — partial authenticated acceptance (2026-10-09)

- macOS application and `/healthz` both report **6.1.8-rc.4**. The user
  installed RC4 manually; the RC3 application rollback ZIP was preserved at
  `launcher/artifacts/Codex-Web-GPT-6.1.8-rc.3-rollback.zip`.
- Configured maximum browser sessions: **8**; SEM and Bigger Context enabled;
  `experimentalSemanticLogicalWindow=false`. Launcher UI showed **effective 5,
  pending 8 (restart required)**. A configured value of 8 is **not** proof that
  the running launcher has applied the new limit. Do not restart it with active
  HTTP/browser turns.
- Authenticated Codex root + V1 child model chain smoke: **PASS**, both
  `chatgpt-web/gpt-6-sol`, version `6.1.8-rc.4`.
- Authenticated, read-only, **three-turn native Codex session**: **PASS** for
  initial shell read of a synthetic marker and two `codex exec resume`
  continuations that recalled the marker without tools. All three turns exited
  0 with expected marker/anchor and no reported turn failure. The first
  isolated-`CODEX_HOME` attempt failed on turn 2 with `missing cwd in trusted
  Codex environment context`. Repeating with the same Codex Home as the
  launcher and per-process provider overrides succeeded. **No bridge source
  change was needed or made**; the earlier test setup was not representative
  of the launcher-owned native rollout lookup.
- Additional targeted environment, outer-native harness and SEM recovery
  regressions: **172 pass, 1 platform-specific skip, 0 fail**, three files.
- Post-install safe-log snapshot: 44 SEM events across 14 thread hashes, **0
  `semantic_turn`, 0 rotation and 0 cost samples**. The snapshot included 16
  `anchor_missing` validations and 13 active-epoch legacy fallbacks. These are
  aggregate events in the launcher log, not a per-test causal diagnosis.
  The successful three-turn continuation establishes the native resume path,
  **not** SEM rotation/reuse/reseed, canonical fallback cost, or SEM savings.
- Commit `7555b9a` was pushed and draft PR #11 created. Original dirty
  worktree and active unrelated Codex sessions were left untouched.

## Remaining acceptance gates

1. When **both** HTTP and browser turns are idle, restart the launcher and
   verify that effective browser capacity equals the configured 8. The
   capacity change is pending until restart.
2. Exercise authenticated **eligible** SEM rotation, retained reuse,
   cache-miss/restart reseed, model-family switching, cap-limited canonical
   multipart fallback, and authority/occupancy safeguards. Capture bounded
   event counts and confirm end-to-end correctness for each.
3. Compare actual real-use SEM cost and answer quality with canonical Bigger
   Context. Keep `experimentalSemanticLogicalWindow=false` and S9 gated until
   measurement and explicit owner acceptance.

No release tag, GitHub Release, production SEM acceptance or token-savings
claim is made. macOS ARM64 artifact is ad-hoc signed, not notarized.

## Deep-diagnostic follow-up (2026-10-09, local source patch)

The working branch was initially clean at `9484b45`. The installed RC4 still
uses the earlier diagnostic implementation. No restart or installation was
performed during this follow-up.

Reading the *available* oldest-to-newest `launcher.jsonl.1` and `launcher.jsonl`
segments together gave 78 semantic events across 20 hashed threads: one
`semantic_turn`, one rotation, 28 `ineligible` skips, 27 `anchor_missing`
validation failures, and 20 legacy fallbacks from active epoch validation.
One recorded rotation estimated 89,237 masked historical tokens and 41,838
reseed input tokens. These are estimates, not browser billing or proven net
savings. Log rotation means the record is not necessarily exhaustive.

The two authenticated native-smoke hashes `1523037dbe60caea` and
`420fc8458445a0ac` accounted for three and four `ineligible` skips,
respectively, with **zero verified rotations**. An earlier loopback proxy had
observed request-level native `thread_id`/`turn_id` but no consistent item-level
turn attribution. This is a verified incompatibility between real request
shape and test fixtures, but not yet proof of which eligibility branch each
live request took.

The current *uncommitted* source patch adds an allowlisted `detail` category to
`semantic_skip: ineligible` for both top-level eligibility and candidate
provenance failures. It adds `ineligibleDetails` to the safe report, repairs
the archive's omission of known skip/fallback reasons, and tests untagged
native-style history. With missing lineage, SEM continues to fail closed and
keeps canonical history: it never fabricates previous-turn ownership.

Verification on the patched source: 83/83 semantic tests (866 assertions),
155/155 browser-worker contract tests, 4/4 launcher diagnostic-archive tests,
root and launcher TypeScript typechecks, and `git diff --check` all passed.
The launcher worktree initially lacked React dev dependencies, restored using
its existing frozen lockfile without changing tracked dependency files.

The next authenticated gate needs a new isolated runtime/package that includes
this diagnostic patch, followed by safe per-thread `detail` counts; testing
against the currently installed RC4 cannot produce the new detail. Only after
the exact failure category is observed should candidate turn reconstruction
be changed. Preserve digest/anchor verification, canonical authority, tool
pairing, and fail-closed fallback. Reuse, reseed, model switch, physical
pressure, and cost comparison all remain live **NOT_RUN** for this patch.

## Native replay / digest policy v2 follow-up (2026-10-09)

An authenticated four-turn isolated RC4 smoke previously rotated its first
semantic epoch, then reported `digest_mismatch` and fell back to canonical
history on subsequent turns. Four persisted request snapshots established that
the saved anchor remained present but covered input changed: the per-request
`additional_tools` registry varied in its identity and current tool description,
previous reasoning gained explicit `content: null` and `encrypted_content: null`,
and completed assistant text lost `status: completed` and empty annotations.
This is an observed request serialization difference, not a changed user prompt.

The current local, **uncommitted** patch introduces semantic digest policy v2:

- Tool registry items remain available to the current parser/tool compiler but
  do not bind a historical prefix digest. Historical developer/user authority,
  tool arguments and results remain fully digested.
- Only the observed null reasoning fields, assistant completed status, and
  empty output-text annotations are normalized for stable history identifiers
  and digest computation. The canonical raw request is never rewritten.
- Verified native rollout user-message attribution also feeds rotation cooldown
  ordering. Persisted v1 epochs remain readable and checked against their v1
  digest. If old stored refs are incompatible with new identifiers, projection
  fails closed and requires a fresh safe canonical fallback/reseed.
- Tests cover exact replay normalization, changed instructions, user messages,
  tool arguments/results, answer mutation, legacy digest validation, native
  rollout attribution, restart reseeding, model switching and cap-limited
  canonical fallback.

Verification after the change: **41 pass / 0 fail** across seven focused SEM
files; **169 pass / 0 fail** across browser-worker, usage, log-report and
launcher archive regressions; root and launcher TypeScript typechecks **PASS**;
`git diff --check` **PASS**. The tests use fake workers or isolated input.

An isolated source runtime started on port `17854` with a distinct temporary
config/runtime home and the existing launcher browser host. Its authenticated
Codex smoke completed **turns 1–3 PASS** (expected anchor and synthetic marker,
no tools, all exit 0). An intermediate result-collection call was blocked by a
safety-status error; turns 2 and 3 were later returned when the smoke session
was interrupted. Turn 4 was not completed: the isolated smoke was interrupted
(exit 130) while stopping the isolated server. The exact live SEM event sequence,
verified retained epoch reuse, restart reseeding and actual token savings remain
**UNVERIFIED** for this patch. A separate attempt
to read/compare the sensitive saved snapshots was also blocked; those snapshots
were not changed or shared.

Production port `17841` was observed healthy with two active browser turns and
one active HTTP turn before the isolated run. The production launcher was not
restarted or upgraded for this patch. The isolated source server has been
stopped. No commit, push, tag or release is claimed.

## Authenticated retained-epoch acceptance (2026-10-09, isolated source runtime)

The same dirty integration worktree at `9484b45` was checked before proceeding.
The source runtime used isolated configuration, state and broker on port `17854`
and the existing authenticated launcher browser host. Production stayed on
port `17841`, with active turns, and was not changed or restarted. The native
Codex smoke used GPT-6 Sol at **high** effort; the earlier `low` effort attempt
was rejected by account capabilities. One earlier tool-using smoke returned a
Codex Native turn-token error in its model reply, so this acceptance deliberately
used text-only turns. It does **not** establish native tool-execution acceptance.

Six serial authenticated Codex turns, one persistent native thread, were
checked for completed status, exit code 0, and correct recall of a synthetic
anchor. Codex Markdown-escaped some underscores in the reply; comparisons
normalized that display escaping. No repository tools were invoked by these
six turns. The scoped, content-free runtime events showed:

| Turn | SEM evidence | Result |
| --- | --- | --- |
| 1 | `semantic_skip: no_completed_turn` | Completed; seeded anchor. |
| 2 | `semantic_rotation: initial`, epoch 1; `semantic_turn` and `semantic_cost` | PASS: initial rotation. |
| 3 | `semantic_skip: cooldown`; `semantic_turn` epoch 1, estimated occupancy 22,614, next-wire estimate 924, `epochRotations=0` | PASS: retained reuse, correct anchor, no validation fallback. |
| 4 | Restarted **only** isolated server; `semantic_skip: low_pressure`, `semantic_turn` epoch 1, occupancy reset to 0; anchor correct | PASS: saved-epoch validation and fresh browser reseed. |
| 5 | Restarted isolated server again after the cost-accounting patch; epoch 1, `epochRotations=0`, `reseedInputTokensEst=23,770` | PASS: authenticated existing-epoch reseed correctly accounted. |
| 6 | Same server; epoch 1, estimated occupancy 23,787, `epochRotations=0`, `reseedInputTokensEst=0` | PASS: subsequent retained reuse without an extra reseed. |

No `digest_mismatch`, `anchor_missing`, or active-epoch legacy fallback was
observed for this isolated thread in the captured turn-2 through turn-6 semantic
events. Each comparison used the same synthetic marker, and the saved record
retained digest policy v2 and model family 6 across restarts. Runtime-event
visibility is scoped to these requests; these results do not prove global
absence of failures.

The code fix accounts for a **submitted** fresh browser lease as reseed input
even when the persisted logical epoch does not rotate. The `semantic-adapter`
regression now asserts positive reseed estimates after a fresh lease with
`epochRotations=0`. Focused verification: `bun test` for six SEM test files,
**28 pass / 0 fail**; root and launcher typechecks **PASS**; `git diff --check`
**PASS**. The prior 210-test aggregate remains historical evidence for the
earlier patch state, not a claim about all tests after this follow-up.

Remaining gates: authenticated native tool-call/result pairing, model-family
switching, physical-pressure and cap-limited fallback, larger workloads, and
measured quality/billed-token comparison against canonical Bigger Context.
The estimated `nextWireTokens`, `canonicalTokens`, `reseedInputTokensEst` and
`maskedTokensEst` are diagnostic estimates, **not** actual billed savings;
`semantic_turn` is emitted before the browser selects a fresh retained lease,
so its `nextWireTokens` can reflect the smaller resume preflight while the
separate `semantic_cost` event records the full fresh submission. Logical
window remains disabled, and production deployment/release is not accepted.

## Follow-up: tool pairing and estimated efficiency (2026-10-09)

The source-only follow-up now validates that every covered function, custom,
local-shell or tool-search call has **exactly one matching result after the
call**, with no duplicate identifiers, orphan results, or cross-kind pairing.
Ambiguous histories return `outstanding_tools` and cannot create a semantic
epoch. The same pairing check runs on **persisted epoch reuse**, preventing an
older checkpoint from silently reusing historical results admitted by an
earlier, weaker rotation policy. This hardening protects historical tool
evidence before it can be masked for browser projection; it does not change
the canonical request.

- Targeted SEM projection/provenance/native-rollout verification: **23 pass,
  0 fail** across three files, including new rotation and persisted-reuse
  pairing regressions.
- Local model-switching, pressure, cap and canonical-fallback regression tests:
  **10 pass, 0 fail** across three files. No authenticated large-pressure run.
- Two-broker routing regression: **1 pass, 0 fail**. A live token registered
  on broker A fails a claim on broker B with the observed invalid-token class,
  but succeeds on A; this demonstrates the failure mechanism locally.
- Root TypeScript typecheck and `git diff --check`: **PASS**.
- Final scoped integration verification after both pairing checks: **65 pass,
  0 fail** across ten SEM, broker, restart, physical-pressure and fallback test
  files; root and launcher TypeScript typechecks **PASS**. These remain local
  tests; the authenticated isolated native tool gate is still pending.
- Fixed six-turn fake worker comparison (`tests/semantic-stock-cost.test.ts`):
  **2 pass, 0 fail**. Browser submissions: **6 for SEM and 6 for legacy**;
  incremental estimated browser-input difference: approximately **-36,000
  tokens per 100 native turns**, or **-360 tokens per turn**, on that specific
  small synthetic workload. This estimate does not include actual billing,
  model output, or real workload quality, and must not be extrapolated to an
  account-wide savings rate.

The earlier authenticated native tool-token failure remains unresolved. The
isolated source runtime used a broker socket inside its temporary home,
whereas the installed production configuration points to a different broker
socket under `~/.codex-chatgpt-web/runtime/`. The launcher starts its managed
MCP tunnel with that configured `--broker-socket`, while the isolated source
runtime cannot silently transfer its turn capabilities to another broker.
This mismatch reproduces the failure class in a local regression, but the
earlier authenticated failure's actual tunnel target remains **unverified**.
A bounded
inspection attempt of the saved tool-using smoke output was rejected by a
safety-status classifier; the existing acceptance files were not changed.
Do not treat text-only authenticated acceptance or local broker tests as
authenticated isolated-runtime tool-call/result pairing. Live read-only
Codex Native calls to the currently connected production broker succeeded
during this continuation; this does not validate the uninstalled source patch.
Production remains unchanged.

The historical digest v2 still excludes the per-request `additional_tools`
registry, including volatile descriptions. Its surviving call/result records
remain hash-bound, but equivalent-name tool rebinding across changed
registries has not been accepted by an authenticated end-to-end tool test.
Keep the experimental logical window off until that and physical-pressure /
canonical-fallback gates complete.

## Digest v3 and explicit isolated MCP routing (2026-10-09, source-only)

The dirty RC4 integration worktree now issues new SEM checkpoints with
`digestPolicyVersion=3`. Covered historical messages, tool arguments, results
and replay-only normalization remain protected as before. In addition, the
digest binds the execution type, namespace and argument contract of live
`additional_tools` definitions whose names are actually used by covered tool
calls. Unrelated tool registrations, duplicate equivalent definitions,
per-request IDs and description-only changes do not invalidate reuse. A
same-name tool schema/type change does invalidate reuse. This reduces the
registry-rebinding ambiguity left by v2 while keeping the historical raw
request untouched. It cannot prove the identity of an opaque implementation
that changes behavior behind an identical declared contract, nor bind a
historical registry that was not present in the request. These are explicit
limitations, not accepted authenticated guarantees.

Persisted v1 epochs remain verifiable against v1 evidence. Persisted v2
**text-only** epochs remain reusable after digest verification; v2 epochs with
covered tool calls require canonical fallback because their ignored tool
registry cannot be reconstructed retroactively. The old records are preserved.

The new `native-mcp-isolated-broker` regression launched the real MCP stdio
child with an explicit temporary broker socket and relayed a read-only `pwd`
through broker claim, native command request, test-dispatched process result
and MCP response: **PASS**. Rebinding the same client invocation to a second
broker failed with the expected invalid-token class: **PASS**. These results
establish local MCP/broker wiring, not an authenticated ChatGPT Web model
turn or a real Codex native dispatcher callback.

Source verification: combined browser-worker, SEM, recovery, cost, broker and
native-MCP regressions **217 pass, 0 fail**, 1,410 assertions across eleven
test files. The test runner completed and printed this summary; its shell
wrapper then returned exit 1 because it attempted to write zsh's read-only
`status` variable. Earlier focused runs returned exit 0. Root and launcher
TypeScript typechecks and `git diff --check` **PASS**. No full repository-wide
or production acceptance claim. Production `/healthz` was read-only checked at **6.1.8-rc.4**, PID
20681, with **4 active HTTP turns and 5 active browser turns**; no restart,
tunnel changes, installation, commit, push or release was performed for this
follow-up.

The remaining acceptance dimensions are model switching, real context pressure,
fallback behavior and equivalent-workload quality/cost evidence. Keep
`experimentalSemanticLogicalWindow=false`; deployment and release remain
separate decisions.

## Owner scope decision (2026-10-09)

The owner elected to **skip the separate authenticated native-tool E2E flow**
because its MCP connector/tunnel setup is disproportionately complex. Mark that
gate **WAIVED / NOT_RUN**, not PASS. Do not create or repoint a tunnel, restart
the production launcher, or block subsequent source review solely on this test.

The existing local MCP/broker routing checks and authenticated *text-only*
SEM rotation/reuse/reseed evidence remain valid within their tested scope.
They do **not** establish authenticated tool-using SEM reliability or resolve
the prior live native turn-token failure. Source integration may continue with
this explicit coverage limitation; any release or production acceptance must
report the waiver and residual risk instead of claiming full E2E validation.

## Pre-integration source review and offline gates (2026-10-09)

The existing dirty integration candidate was preserved on
`codex/sem-rc4-integration` at `9484b45`; this follow-up has not committed,
pushed, installed, restarted production or published a release.

Source review found three gaps in v3 tool-contract fingerprinting. Regression
tests reproduced each gap **before** the fix: (1) a historical call with an
explicit namespace could ignore changes to the corresponding namespaced tool
declaration; (2) a used tool declared in top-level `tools` (instead of inline
`additional_tools`) was omitted from the fingerprint; and (3) recursively
removing a volatile declaration `id` also removed an actual JSON Schema
`properties.id` argument. The source now resolves covered call names using
their explicit namespace, includes top-level tool declarations in ephemeral
semantic provenance, and removes volatile `id` only at a tool declaration's
root. These changes affect **digest v3**; v1/v2 compatibility behavior and
canonical request bytes remain unchanged. Existing experimental v3 epochs
with different fingerprints fail validation conservatively and can reseed
from validated canonical history.

Scoped verification against the resulting source:

| Gate | Result |
| --- | --- |
| SEM provenance, projection, store, rollout, adapter (5 files) | 39 PASS, 0 FAIL |
| Model switch, active pressure, Bigger Context recovery/multipart, stock cost, rotation caps (6 files) | 16 PASS, 0 FAIL |
| Isolated native MCP and broker lifecycle (2 files) | 18 PASS, 0 FAIL |
| Diagnostic archive and semantic-log report (2 files) | 6 PASS, 0 FAIL |
| Browser-worker contract (1 file) | 155 PASS, 0 FAIL |
| Root + launcher TypeScript typechecks and `git diff --check` | PASS |

This totals **234 PASS / 0 FAIL across 16 test files**, including three new
digest regressions. These tests cover local source behavior with fake or
isolated harnesses; they do not verify billed-token savings, user-facing
answer quality on real workloads, production process configuration, or the
waived authenticated native-tool end-to-end flow. The previously observed
synthetic difference of about 360 estimated tokens per turn is workload-
specific and excludes reseed/billing uncertainty. Keep
`experimentalSemanticLogicalWindow=false`.

At this pre-integration inspection, draft PR **#11** on
`maemreyo/codex-chatgpt-web` had not yet received the dirty source changes.
They were subsequently pushed in `280f2e1`; the review follow-up below
records the next patch. Authenticated native-tool reliability remains
**WAIVED / NOT_RUN**, and production acceptance is not claimed.

## PR #11 source-review corrections (2026-10-09)

PR **#11** (`codex/sem-rc4-integration` against `main`) was subsequently
marked Ready for Review. Source review of `280f2e1` identified one P1 and
two P2 regressions, reproduced before the corrections:

1. **P1 — SEM inline preflight:** the preflight could accept a Bigger Context
   multipart projection although the active SEM epoch is sent inline. The
   corrected preflight validates the exact inline submission boundary. A
   510,000-character synthetic continuation now falls back to lossless
   canonical Bigger Context multipart before persisting a new epoch or
   charging its rotation budget. This does not enable SEM multipart transport.
2. **P2 — digest v3 tool parameter:** declaration-level descriptive text is
   still excluded from the digest, but a tool argument actually named
   `description` remains part of the schema fingerprint. Changing its type
   changes the digest, while changing human-only descriptive text does not.
3. **P2 — diagnostic archive metadata:** the sanitizer now preserves rotation
   reasons `initial`, `physical_pressure` and `token_savings`, plus both
   boolean values of `fitsSingleMessage`. Regression coverage verifies
   bounded sanitization as well as preservation through archive read/export.

Scoped verification after these corrections:

- `bun test tests/semantic-projection.test.ts tests/semantic-provenance.test.ts
  tests/semantic-bigger-context-recovery-regressions.test.ts
  launcher/tests/diagnostic-archive.test.cjs`: **33 PASS / 0 FAIL** before
  the extra archive read/export assertions (238 expectations, Bun 1.4.2).
- `bun test launcher/tests/diagnostic-archive.test.cjs` after the additional
  archive read/export assertions: **4 PASS / 0 FAIL**.
- `bun run typecheck`: **PASS** (root runtime TypeScript).
- `bun run launcher:typecheck`: **PASS** (launcher TypeScript).
- `git diff --check`: **PASS**.

These checks exercise source-level regression paths and isolated fake workers;
they do not validate an installed patched build or production usage.
Authenticated native-tool E2E remains **WAIVED / NOT_RUN** by owner decision.
Real browser context pressure, model quality and billed-token savings remain
outside this patch's acceptance. Keep `experimentalSemanticLogicalWindow=false`.
No merge, deployment, release or production restart is authorized by this
source-review correction.

## PR #11 follow-up: inline transport regression fixture alignment

Post-push review of `7f1e5b7` confirmed the three source fixes and exposed
two older test expectations that conflicted with the now enforced inline-only
SEM epoch transport. The interrupted SEM cost test now uses a physically
fitting current suffix, so it still asserts that an active epoch has no
multipart stages. The unmaskable user-history test now requires canonical
Bigger Context multipart fallback without a retained SEM conversation key;
its exact user and developer evidence must remain present. The nine-turn
S8 persisted-epoch test passed alone but exceeded Bun's default five-second
timeout under concurrent tests, so it uses a bounded 20-second timeout.

These are test-only adjustments; no runtime transport or SEM policy changed.
The focused original review regressions remain **33 PASS / 0 FAIL**; the
authenticated native-tool E2E waiver remains **WAIVED / NOT_RUN**. No live
browser, installed app or billed-token measurements are claimed by this review.

## PR #11 follow-up: review P2 test timeout and cost telemetry wording

Two Bigger Context integration regressions in `tests/semantic-adapter.test.ts`
were susceptible to Bun's default five-second per-test timeout when other SEM
tests ran concurrently. Both now have a bounded 20-second timeout, matching
the related large-history/recovery tests. In one combined run of five relevant
test files, these two cases completed in approximately 3.3 and 2.9 seconds,
respectively; the existing ninth-turn restart test completed in approximately
3.6 seconds. One passing run does not prove that CI will never be overloaded.

The SEM overview and implementation plan now describe the actual telemetry
boundary: active SEM epochs use inline submissions only, so their
`semantic_cost.extraStageSubmissions` is always zero. Canonical Bigger Context
multipart fallback can submit stages, but it does not emit a `semantic_cost`
event. Zero in this counter must not be used to conclude that no canonical
multipart stages were submitted, or to estimate fallback staging cost.
Production behavior was not changed by this documentation correction.

- `bun test tests/semantic-adapter.test.ts tests/semantic-adapter-recovery.test.ts
  tests/semantic-bigger-context-recovery-regressions.test.ts
  tests/semantic-multipart-cost.test.ts tests/semantic-log-report.test.ts`:
  **19 PASS / 0 FAIL**, 250 assertions, Bun 1.4.2.
- Root and launcher TypeScript typechecks: **PASS** (source unchanged by this
  follow-up; both were run before these documentation/test changes).
- Authenticated native-tool E2E: **WAIVED / NOT_RUN**. No new installed-app,
  production, or actual billed-token acceptance is claimed.
