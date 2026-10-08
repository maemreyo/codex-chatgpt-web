import { ChatGptWebAdapterError } from "./adapter-error";

/**
 * ChatGPT Web concurrency is deliberately bounded. Every active Codex turn owns a real
 * browser document in the signed-in account, so unbounded fan-out would create account-level
 * traffic that is indistinguishable from spam.
 */
export const MAX_CHATGPT_BROWSER_TABS = 5;

export const MAX_CONFIGURABLE_CHATGPT_BROWSER_TABS = 8;
export const CHATGPT_BROWSER_CAPACITY_HELPER_FEATURE = "browser-session-cap-v1";

export function resolveMaxBrowserSessions(value: unknown = MAX_CHATGPT_BROWSER_TABS): number {
  if (!Number.isInteger(value) || (value as number) < MAX_CHATGPT_BROWSER_TABS
    || (value as number) > MAX_CONFIGURABLE_CHATGPT_BROWSER_TABS) {
    throw new Error(`maxBrowserSessions must be an integer between ${MAX_CHATGPT_BROWSER_TABS} and ${MAX_CONFIGURABLE_CHATGPT_BROWSER_TABS}`);
  }
  return value as number;
}

export class ChatGptBrowserCapacityError extends ChatGptWebAdapterError {
  constructor(readonly maxBrowserSessions: number, readonly activeBrowserSessions: number) {
    super(
      `ChatGPT Web supports at most ${maxBrowserSessions} simultaneous browser turns`
      + ` (${activeBrowserSessions}/${maxBrowserSessions} active); finish a browser turn or reduce agent fan-out before trying again`,
      { status: 409, errorType: "invalid_request_error", code: "browser_session_limit_exceeded", retryable: false },
    );
    this.name = "ChatGptBrowserCapacityError";
  }
}

export function chatGptBrowserCapacityError(limit: number, active: number): ChatGptBrowserCapacityError {
  return new ChatGptBrowserCapacityError(limit, active);
}

// Process-wide reservations cover workers with different provider configurations. Reserve before
// dispatching any async browser/helper work and release only when that work actually settles.
const activeBrowserReservations = new Set<symbol>();

export function reserveChatGptBrowserTurn(limit: number): () => void {
  resolveMaxBrowserSessions(limit);
  if (activeBrowserReservations.size >= limit) throw chatGptBrowserCapacityError(limit, activeBrowserReservations.size);
  const reservation = Symbol("chatgpt-browser-turn");
  activeBrowserReservations.add(reservation);
  return () => { activeBrowserReservations.delete(reservation); };
}
