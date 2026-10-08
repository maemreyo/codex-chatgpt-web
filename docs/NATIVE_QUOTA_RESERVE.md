# Optional native Codex quota reserve (ChatGPT Plus)

The `nativeQuotaReserveEnabled` config flag is **off by default**. Set it to
`true` in the installed bridge's `config.json` and restart the bridge to opt in.
This feature affects the ChatGPT Plus Work/Codex allowance used by **native
Codex** requests, not ChatGPT Web model submissions. It protects the native
Responses, compaction, search and image routes forwarded through this bridge.

## Two safety modes

Use `~/.codex-chatgpt-web/config.json` (or `$CODEX_CHATGPT_WEB_HOME/config.json`)
for these settings. These are JSON fields in the existing configuration, not a
new standalone file. The following values are the defaults:

```json
{
  "nativeQuotaReserveEnabled": false,
  "nativeQuotaReserve": {
    "mode": "strict",
    "fiveHourReservePercent": 5,
    "weeklyReservePercent": 3,
    "fiveHourAdmissionPercent": 20,
    "weeklyAdmissionPercent": 10
  }
}
```

To disable the guard again, set `nativeQuotaReserveEnabled` to `false`
and restart the bridge. This restores ordinary native forwarding.

When you enable the feature (`nativeQuotaReserveEnabled: true`), the **default
Strict mode** blocks all quota-consuming native requests through this bridge,
including compaction, search and image requests. It performs **zero quota
polls**. Native quota consumption by this bridge is therefore zero as long as
all such traffic is routed through it. ChatGPT Web models keep working.

Select `mode: "conservative"` only if you choose to accept some risk. It
performs preflight checks and admits a native request only if **more than 20%**
of the five-hour allowance and **more than 10%** of the weekly allowance remain
by default. Both admission thresholds can be increased to stop earlier. The
5% / 3% reserve targets are separately configurable; validation requires each
admission threshold to be strictly higher than the corresponding reserve.

For example, a request at 10% five-hour remaining is stopped before it starts
under the conservative defaults. However, a request admitted at 21% could
still consume 19 percentage points and leave only 2%. **Conservative mode is
not a guarantee**: OpenAI does not publish an upper bound on the quota cost of
a single native turn; cost depends on task complexity, model, tools, and
context. Requests from other apps/devices also remain outside the bridge.

There is no supported hard cap on native per-task quota consumption known to
this integration. If never crossing 5% / 3% matters more than native access,
use Strict mode. The percentage settings cannot create a mathematically strict
floor without server-side quota reservation or an enforced per-request usage cap.

## Anti-spam behavior

- There is **no timer, background job or retry loop** calling the usage endpoint.
- Only when a new quota-consuming native request arrives, the guard performs
  a quota lookup in Conservative mode, subject to a **15-minute minimum interval per account**.
- The same successful snapshot authorizes **one** native request. Other requests
  during the interval are refused locally without contacting OpenAI. Native
  requests are serialized until their response stream completes or is cancelled.
- Transport errors or HTTP 5xx impose a **one-hour cooldown**. HTTP 401/403/429
  and unrecognized usage formats impose a **24-hour circuit breaker**.
- Once the reserve is reached, the guard waits at least **five hours** for the
  five-hour limit or **24 hours** for the weekly limit before checking again.
- Last-check and cooldown timestamps are written durably under
  `~/.codex-chatgpt-web/native-quota-guard-state.json` (or the configured
  `CODEX_CHATGPT_WEB_HOME`). The file contains only account hashes and
  timestamps, not Bearer credentials, prompts or account IDs.
- Instances using the same bridge profile coordinate with an atomic lock
  directory (`native-quota-guard-state.json.lock`), preventing simultaneous
  quota reads. An orphaned lock after a crash blocks native traffic until an
  operator confirms the process is stopped and clears the stale lock.
- A corrupt/unreadable state file fails closed. Quota read failures never
  authorize a native request. Requests are rejected with HTTP 403 rather than
  a retryable 429 response.

In Conservative mode the guard currently reads `/backend-api/wham/usage` using the incoming native
Codex session. This is an **undocumented endpoint** whose schema and availability
can change. The guard deliberately refuses native requests when both 5-hour
and weekly windows cannot be verified. Do not enable it if your installation
does not support this usage read. **No live usage endpoint check has been made
during implementation**; tests use a mocked transport only.

The cooldowns are deliberately restrictive: this feature is intended to retain
a small native allowance while most work uses ChatGPT Web. Using native Codex
through another client, the API, or another bridge profile can still consume
quota outside this guard. Running multiple independent profiles against one
account is unsupported for strict reserve protection. When in doubt, use the account's
official Settings > Usage page for the authoritative allowance.
