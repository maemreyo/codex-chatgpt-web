const DEFAULT_MAX_BROWSER_SESSIONS = 5;
const MAX_BROWSER_SESSIONS = 8;

function validateMaxBrowserSessions(value) {
  if (!Number.isInteger(value)
    || value < DEFAULT_MAX_BROWSER_SESSIONS
    || value > MAX_BROWSER_SESSIONS) {
    throw new Error(`Max browser sessions must be an integer between ${DEFAULT_MAX_BROWSER_SESSIONS} and ${MAX_BROWSER_SESSIONS}`);
  }
  return value;
}

module.exports = { DEFAULT_MAX_BROWSER_SESSIONS, MAX_BROWSER_SESSIONS, validateMaxBrowserSessions };
