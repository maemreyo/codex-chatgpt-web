# SEM recovery native offline harness

The harness requires an OS-enforced network sandbox before starting a native client. It uses a disposable CODEX_HOME, synthetic loopback provider, and content-free diagnostics. If outbound isolation cannot be enforced, it fails closed.

The verified native run covers fixed recovery categories, SSE HTTP 200 failures, HTTP 409 failures, bounded repeats, and terminal behavior. Results apply only to the recorded native executable fingerprint.

Run:

```sh
bun run scripts/smoke-codex-sem-recovery.ts --binary=ABSOLUTE_NATIVE_BINARY
```

Verified run date: 2026-10-10.

Native binary:

```text
/Users/trung.ngo/.nvm/versions/node/v24.19.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex
version: codex-cli 0.160.0
sha256: 112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b
```

The wrapper requires an explicit native binary path and an isolated PATH. The prior sandbox profile issue using `127.0.0.1:port` was fixed by using `localhost:port`; the mandatory allowed and denied listener gate passed.

Actual result:

- Cases: 6 (`chatgpt_active_turn_compaction_required`, `semantic_atomic_result_too_large`, `semantic_epoch_recovery_required` × SSE 200 / JSON 409).
- requestCount: 5, compactCount: 0, status: ERROR, exitCode: 1.
- Duration: approximately 3.1-3.5 seconds.
- Classification: `harness_limit_reached`.
- Fixture cap 4 emitted 429 on the fifth request.

This result does not claim native terminal no-retry behavior or native automatic recovery. Observed retries occurred despite `retryable=false` before the fixture cap. No compact calls were observed. The harness process exiting with code 0 means the harness reported results; it does not mean all cases passed.

The report vocabulary separates `native_terminal_no_retry`, `native_requested_compact`, `client_retry_observed`, `harness_limit_reached`, and `sandbox_unavailable`. An external timeout or request cap does not prove native retry bounds. HTTP 200 SSE and HTTP 409 JSON are separate cases. Cases run serially and retain only fixed categories, counts, and hashed identifiers. Native transcripts, prompts, and outputs are discarded.

Production gate status remains NOT_RUN for native compatibility with a real authenticated browser and actual broker disconnect. Current verified gates remain limited to existing SEM checks and this offline native harness result.

Follow-up offline run (2026-10-10, same fingerprint): the original six cases still
reached the fixture cap at five requests with zero compact requests. Two additional
HTTP 400 JSON cases (`chatgpt_active_turn_compaction_required` and
`context_length_exceeded`) each exited with code 1 after exactly one request and
zero compact requests (179 ms and 143 ms respectively). Both classify as
`native_terminal_no_retry`; this is a terminal error, not successful recovery.

The production adapter now offers a read-only preflight for an exact active
tool session with a complete pending result batch. Known physical pressure is
returned as HTTP 400 JSON before SSE headers, preserving the original error code
and outstanding results. Canonical compact requests bypass this preflight. The
adapter's existing delivery guard remains necessary for pressure discovered later;
those mid-stream failures still use SSE and do not prove native no-retry behavior.
Explicit canonical compaction remains required. The bridge does not invent a
compaction trigger or rewrite the native canonical batch.

Context-error classification follow-up: a rejected single browser message
(`message_length_exceeds_limit`, `input_too_large` for `last_user_message`,
composer limit, stage budget, or observed semantic message ceiling) now carries
`chatgpt_message_too_large`. Only the full model/transaction context preflight
retains `context_length_exceeded`. A typed adapter exception also keeps its
status/code/retryability at the HTTP boundary instead of being reclassified from
its human-readable message. This prevents a transport-size rejection from
masquerading as native context exhaustion; it does not recover a truly full
context or prove live automatic compaction.

Release candidate 6.1.8-rc.5 verification (Bun 1.4.0):
- `bun test tests/semantic-*.test.ts tests/compaction-*.test.ts tests/browser-worker-contract.test.ts tests/native-sem-recovery-harness.test.ts tests/sem-native-recovery-runner.test.ts tests/server-compaction.test.ts`: 343 pass, 0 fail, 2916 assertions.
- `node --test launcher/tests/*.test.cjs`: 402 pass, 2 skip, 0 fail.
- Runtime/launcher TypeScript and version synchronization: PASS.
- Native CLI fingerprinted offline matrix: eight scenarios; terminal HTTP 400 behavior confirmed, automatic compaction not observed.
- Full runtime suite, authenticated live browser and actual broker disconnect: NOT_RUN.

6.1.8-rc.6 policy supersedes rc.5 pressure preflight: accumulated/unknown occupancy
no longer rejects tool-result batches. Only atomic oversize is rejected by this
preflight. Existing native synthetic pressure cases document legacy rc.5 errors,
not errors generated by the rc.6 advisory policy.

rc.6 focused verification (Bun 1.4.0): `bun test tests/semantic-active-pressure.test.ts tests/semantic-occupancy.test.ts tests/semantic-compaction-routing.test.ts tests/semantic-adapter-recovery.test.ts tests/semantic-s8-recovery-matrix.test.ts` — 45 pass, 0 fail, 508 assertions. Runtime TypeScript, version synchronization and diff checks PASS.
