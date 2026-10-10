# Browser idle grace recovery — 6.1.8-rc.7

The bridge previously classified an assistant shell with no visible Stop control,
no new answer or trace text, and no completed-turn action as failed after 60 seconds.
That DOM state is ambiguous: it does not prove upstream generation has stopped.

The ordinary turn now tolerates 10 minutes of unchanged, unconfirmed idle state.
Visible generation, new answer/trace text, or recent MCP progress restarts this grace.
Multipart acknowledgements use their existing 180-second per-stage budget for both
missing response DOM and missing completion controls. Explicit session/model error
alerts, cancellation, caller deadlines, and confirmed empty completion retain their
existing handling. No automatic resubmission, tool replay, or synthetic final answer
is introduced. A truly stalled unconfirmed turn can consequently wait longer.

Validation: deterministic DOM-health tests cover silence beyond 60 seconds followed
by a final answer, the 10-minute boundary, explicit empty completion, and progress
resetting the grace. Browser selector validation runs against a local headless Chrome
fixture. Adapter recovery, compaction recovery, and advisory-pressure regressions
cover unchanged tool delivery and completion fencing. Runtime typecheck and packaged
launcher smoke are release gates.

Real authenticated ChatGPT slow-generation acceptance remains NOT_RUN. These checks
establish the local timeout behavior; they do not establish the cause of every live
stream disconnect or guarantee upstream recovery.

Focused checks (Bun 1.4.0):

- `bun test tests/browser-worker-contract.test.ts`: 156 PASS.
- `CHATGPT_DOM_TEST_BROWSER=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome bun test --timeout 30000 tests/browser-generation.test.ts`: 1 PASS.
- `bun test tests/semantic-adapter-recovery.test.ts tests/semantic-active-pressure.test.ts tests/compaction-browser-recovery.test.ts`: 21 PASS.
- `bun run typecheck`, `bun run check-version`, `git diff --check`: PASS.

The first browser-selector run exceeded Bun's default 5-second test startup budget;
the standalone run with a 30-second budget passed. An initial contract run raced the
error-message edit and failed its old substring assertion; the final complete run
above passed after the wording was finalized.
