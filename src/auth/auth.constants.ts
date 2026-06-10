// "Remember me" → long-lived persistent refresh cookie + session. Otherwise
// the refresh cookie is a session cookie (no maxAge, dropped when the browser
// closes) backed by a 1-day server-side cap.
export const REMEMBER_ME_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
