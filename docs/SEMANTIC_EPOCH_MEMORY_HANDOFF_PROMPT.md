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
- No live ChatGPT account actions, no real browser submissions, and no use of the owner's real Codex
  transcripts unless the owner explicitly confirms the account and the transcript set in this
  conversation. Use the DEV harness, fixtures and fakes.
- Do not read, commit, or print anything under `~/.codex-chatgpt-web`, the launcher data directory, or
  Codex history.

## How to work

Execute the plan slice by slice, in the order of plan section 25, and **stop at every decision gate**.
The plan is gated on purpose; skipping a gate is a failure even if the code would compile.

1. **S0.5b** (do this first, it is independent and small): make "message too long" diagnosable per plan
   12.4 requirement 6 and section S0.5b. Cover both rejection shapes (HTTP 413 and SSE
   `input_too_large`) with tests in `tests/browser-worker-contract.test.ts` style. No behavior change
   beyond the added fields.
2. **S0.6 harness only**: build the offline five-arm evaluation as scripts (under `scripts/` or
   `tests/fixtures`-adjacent, clearly marked experimental, not wired into the shipped runtime). Include
   the probe set, the judge-prompt scaffolding, the arm definitions, the submission counter, and a
   synthetic redacted fixture so it runs without the owner's data. Do **not** run it against a real
   account or real transcripts. Then **stop** and ask the owner: which account, which transcripts, and
   what pass bar (write the bar into the plan before any real run).
3. **After the owner records the S0.6 decision in the plan**: M1 in the order S1, S2, S4, and S3 only if
   the decision rule requires Tier 1. S1 includes the pure masking function and artifact-ledger
   extractor (plan 9.2, 10.4). Stop at the M1 -> M2 gate and report measured data.
4. M2 (S5, S6) and M3 (S7, S8, S9) only when the owner says the gate passed. Do not start them to "be
   complete".

If real code contradicts the plan (a symbol moved, an assumption is false, an upstream change breaks a
seam), stop, say so, and propose a plan edit. Edit the plan in the same commit as the code that forced
it. Never silently deviate.

## Quality bar per slice

- Add focused tests first or alongside; new behavior needs a regression test (`CONTRIBUTING.md`).
- Run `bun run typecheck`, `git diff --check`, and the focused suites for the files you touched. Run
  `bun run verify` at each milestone gate. Report exact pass/fail counts; if something fails, say so with
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
