# Handoff prompt — Semantic Epoch Memory implementation

Paste everything below the line into a fresh coding-agent session started in this repository.

---

You are continuing a fork-only, hidden experiment in `codex-chatgpt-web` (repo root = your working
directory, branch `feat/semantic-epoch-memory`). Talk to the owner in Vietnamese; write code, comments,
tests and docs in English.

## Read first, in this order

1. `docs/SEMANTIC_EPOCH_MEMORY_IMPLEMENTATION_PLAN.md` (the contract; read all of sections 1, 2, 5, 6,
   9-14, 17, 18, 21-25 before touching code).
2. `docs/SEMANTIC_EPOCH_MEMORY_PLAN_REVIEW.md` (why the earlier design was rejected).
3. `docs/SEMANTIC_EPOCH_MEMORY.md`, `CONTRIBUTING.md`, `docs/architecture.md`, `docs/security-model.md`.

## State you are starting from

- HEAD contains `aa96a44` (the last plan commit) plus this handoff file; upstream `v6.1.5` is already merged (`96916aa`). S0 (scaffold) and S0.5 (merge +
  physical-resolver seam fix + `tests/physical-limit-isolation.test.ts`) are done. Verify with
  `git log --oneline -8` and by running the isolation test; do not redo them.
- The repo pins `packageManager: bun@1.4.0`. Check `bun --version` first. On Bun 1.3.5, four tests in
  `tests/retained-compaction.test.ts` fail identically on pristine `v6.1.5` because `mock.timers` is
  missing. That is an environment mismatch: do not "fix" those tests or the source for it. If you can
  use Bun 1.4.0, do; otherwise report it and exclude that file from your gate.
- Nothing has been pushed from this work. Do not push, force-push, amend existing commits, open PRs, or
  merge further upstream changes without asking the owner.

## Non-negotiable rules

- The feature is hidden and default-off (plan 5.8, invariants 16-20). Config-file only: no launcher UI,
  no `setup` flag, no `doctor` output, no model-catalog label, no mention in `README*`,
  `TROUBLESHOOTING.md`, `CONTRIBUTING.md`, or release text. Never write "quota", "free", "unlimited",
  or "bypass" in code, comments, logs, tests, or docs. A stock install must behave and log exactly as
  `v6.1.5`.
- Browser enforcement always reads the physical resolver; only `model-catalog.ts` and
  `src/dev-chat/driver.ts` may call the logical one (the isolation test enforces it).
- Logs and exports contain counters and identifiers only: never checkpoint text, masked or pinned
  content, or tool output.
- Canonical history is never rewritten. Authority, identity, provenance, and tool settlement read the
  canonical request; only a browser-facing clone is projected.
- Follow upstream's fail-closed style: an unclear case returns an explicit error, never a silent
  fallback. Do not add a model/effort fallback.
- No live ChatGPT account actions and no real browser submissions. Do not read the owner's real Codex
  transcripts unless the owner explicitly confirms the exact set in this conversation (S0.6-lite).
  Use fixtures and fakes.
- Do not read, commit, or print anything under `~/.codex-chatgpt-web`, the launcher data directory, or
  Codex history.

## How to work

The owner reduced scope (plan 5.11): **no expensive tests**. Do not run live evaluations, judge-scored
probes, multi-epoch live runs, or anything needing many real browser submissions. Quality is judged by
the owner using the feature and reading logs. V1 is **Tier 0 only** (masked view + bridge-computed
artifact ledger + inter-turn rotation); the model-written checkpoint (Tier 1, S3) is out of scope.

Execute in this order and stop at the stated gates:

1. **S0.5b**: make "message too long" diagnosable (plan 12.4 requirement 6 and section S0.5b). Cover both
   rejection shapes (HTTP 413 and SSE `input_too_large`) with cheap unit tests in the style of
   `tests/browser-worker-contract.test.ts`. No behavior change beyond the added fields.
2. **S0.6-lite (optional, ask first)**: a read-only script over the owner's local Codex session files
   that makes no model call and uses no account, reporting the share of tokens that are old tool-result
   bodies and how often a thread would cross the physical limit. Only after the owner confirms which
   sessions it may read. Skip if the owner says so.
3. **M1, Tier 0 only**: S1 (provenance sidecar, covered digest, pin policy, the pure masking function of
   10.4, the pure artifact-ledger extractor of 9.2), then S2 (epoch store, durable, fenced), then S4
   (authority-safe projection and inter-turn rotation with the single-message fit check of 12.4), then
   the `semantic_*` log events and `scripts/semantic-log-report.ts` of plan 14.2. Optional local trace
   (`experimentalSemanticMemoryTrace`, default off) only as specified in 14.2. **Stop** after M1 and ask
   the owner to use it and read the report.
4. **M2 (S5, S6)**: only if the owner says the logs show repeated active-turn pressure stops. Do not
   start it to "be complete". S7 is dropped. S8 is a manual owner decision, not a task for you.

Tests you write must be cheap: pure-function unit tests, fake-driven in-process harness tests, and the
existing physical-resolver isolation test. Never add a test that needs a real account, a real browser
session, or the owner's real transcripts.

If real code contradicts the plan (a symbol moved, an assumption is false, an upstream change breaks a
seam), stop, say so, and propose a plan edit. Edit the plan in the same commit as the code that forced
it. Never silently deviate.

## Quality bar per slice

- Add focused tests first or alongside; new behavior needs a regression test (`CONTRIBUTING.md`).
- Run `bun run typecheck`, `git diff --check`, and the focused suites for the files you touched. Run
  `bun run verify` only if the owner asks. Report exact pass/fail counts; if something fails, say so with
  the output instead of working around it.
- Keep diffs additive and small so upstream merges stay cheap: new files for new logic, minimal hooks
  into upstream files (`index.ts`, `prompt.ts`, `browser-worker.ts`, `parser.ts`).
- One commit per coherent slice. Message style: `feat:` / `fix:` / `docs:` / `test:` with a short body.
  End the message with the attribution trailer your environment requires. Update the plan's status/merge
  log and any measured results in the same commit.
- Leave the working tree clean at the end of every turn (commit or report why not).

## What to report after each slice (in Vietnamese)

1. What changed (files, behavior), and what deliberately did not.
2. Tests run with exact counts; anything skipped and why.
3. Deviations or discoveries that touch the plan; open questions that need the owner.
4. The next step, and whether it is behind a decision gate.

Start now with the read-first list, confirm the starting state, then do S0.5b.
