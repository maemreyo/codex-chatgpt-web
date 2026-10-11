# Tool-result recovery RC8 review handoff

Date: 2026-10-10. Candidate: `codex/tool-output-budget-1010`, macOS arm64,
`6.1.8-rc.8`. This is a source/packaging candidate, not production acceptance.

## Scope and locally verified behavior

- Broker reconnect retains outstanding tool-call identity and exact oversized
  JSON references without tool replay. Duplicate completion ACKs are accepted
  only for an identical digest. Reference access is turn-bound, and cumulative
  reservations have an 8M-character per-result / 24M-character per-turn limit.
- Native compaction and SEM-off continuation use browser-facing references while
  leaving canonical Codex input unmodified. The local preflight tracks retained
  result sizes across native batches to avoid approving a known over-cap result.
- SEM rotation/reseed retains canonical history; browser occupancy resets only
  on a verified fresh lease. Local owner operations negotiate protocol v7.
- The source turn snapshots accepted oversized evidence before broker revocation.
  The subsequent one-shot compaction checkpoint reads bounded chunks using
  `codex_compaction_result_chunk`; the access expires with summary acceptance.
  Manual Zero Risk compaction now reserves bounded references using the same
  `request_id` before acknowledging native results.
- Broker shutdown waits for startup and closes incomplete client sockets. A
  canceled native MCP request is not re-dispatched. MCP native invocations keep
  a bounded 90s timeout below the documented tunnel deadline.

Selected local behavior cases: `broker disconnect` (PASS), `S8: advisory
pressure delivers once` (PASS), and `S8: valid persisted epoch survives process
restart with oversized canonical history` (PASS). Root TypeScript typecheck,
`git diff --check`, and pinned Bun version synchronization passed.

## Fresh macOS arm64 package (2026-10-11)

- Rebuilt `6.1.8-rc.8` from the updated dirty candidate with pinned Bun 1.4.0;
  `launcher package:mac` PASS. Both runtime and launcher TypeScript checks PASS;
  focused MCP bridge contract PASS. The two broker/compaction cases PASS in the
  24-test focused run, and the persisted restart case PASS in its separate run.
- Rebuilt `launcher/artifacts/codex-web-gpt-6.1.8-rc.8-mac-arm64.dmg`
  (2026-10-11 00:06:29 local); SHA-256:
  `ec2a8ec010f36231f5afd9c364202d2247bde7dee79a6021333b255e0ac14359`.
- Rebuilt `launcher/artifacts/codex-web-gpt-6.1.8-rc.8-mac-arm64.zip`
  (2026-10-11 00:06:32 local); SHA-256:
  `bdab4010f4ad0b5b73b431c68000f1fbf2c955ef99a54f8bf7b423c71aa4e6c3`.
- `hdiutil verify` on DMG PASS; `codesign --verify --deep --strict`
  on the mounted application PASS. Signing is ad-hoc, with no Apple Team ID;
  the package was **not notarized**.
- Isolated `smoke:package` **PASS**: the completed native session exited 0
  with `PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64`. The earlier missing poll
  result was recovered on 2026-10-11 without re-running the package smoke.

## Known limits; gates still open

1. The checkpoint reference lifetime and Zero Risk bounded-result path now have
   focused regression coverage (`tests/compaction-evidence.test.ts`). Actual
   ChatGPT Desktop model consumption of referenced evidence remains unverified.
2. The local broker stores referenced results in RAM; daemon termination loses
   those references. A browser/connector restart and a real dropped completion
   ACK have not been exercised with the candidate.
3. The 90s MCP timeout is a transport boundary. It does not prove that an
   already-executing native side effect was canceled, so timed-out commands
   must be reconciled before any replay.
4. Native `codex_result_chunk` and `codex_compaction_result_chunk` schema/ABI
   require connector reconnection against the same v7 broker. Installed
  `6.1.8-rc.7` runtime at the latest inspection is
   different from this source candidate.

Do not infer live ChatGPT Desktop acceptance from local tests or a package
smoke. At latest inspection, installed `6.1.8-rc.7` reported three active HTTP
turns and three active browser turns; avoid restarting it until idle. Required live gates
are broker disconnect/reconnect without tool replay, real native compaction
with SEM disabled, and SEM rotation preserving canonical history.

Keep this build as a preview candidate until the live gates are verified.
No stable release readiness claim.
