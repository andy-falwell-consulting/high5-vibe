// Shared Google session helper — imported by api/agent.js, api/me.js, api/google-logout.js.
// Files starting with _ are not treated as Vercel API routes.
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const FALLBACK_KEY = 'fallback_session';
const FALLBACK_TTL = 60 * 24 * 60 * 60; // 60 days — the real limit is Google's own 7-day
                                          // refresh-token expiry for this unverified (Testing
                                          // mode) OAuth app; this TTL just bounds how long a
                                          // dead entry lingers in Redis after that.

// Only ever true on the rolling `preview` branch deployment — these are
// Vercel's own system env vars, set automatically per-deployment, not
// something configured by hand, so this can never accidentally activate on
// production (a different git ref / VERCEL_ENV entirely). See CLAUDE.md's
// "Preview auth bypass" section for the full picture.
const BYPASS_ALLOWED = process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_GIT_COMMIT_REF === 'preview';

export function parseSessionId(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)h5_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Refreshes `session` in place if within 5 min of expiry, persisting the
// rotated token back to `redisKey`. Returns the (possibly refreshed) session,
// or null if refresh failed — in which case the stale record is deleted.
async function refreshIfNeeded(session, redisKey, ttlSeconds) {
  if (Date.now() <= (session.expiresAt || 0) - 5 * 60 * 1000) return session;
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(JSON.stringify(data));
    session.accessToken = data.access_token;
    session.expiresAt = Date.now() + data.expires_in * 1000;
    await redis.set(redisKey, session, { ex: ttlSeconds });
    return session;
  } catch {
    await redis.del(redisKey).catch(() => {});
    return null;
  }
}

// Returns the full session object (with sessionId) or null.
// Automatically refreshes the access token if it's within 5 min of expiry.
//
// On the preview deployment only, falls back to a shared stored session
// (captured once via Admin → "Preview access") whenever the request has no
// valid login cookie of its own — lets anyone with the preview link in
// without signing in. A real login, when present, always wins over the
// fallback. See api/admin-set-fallback-session.js for how it's captured.
export async function getGoogleSession(req) {
  const sessionId = parseSessionId(req);
  if (sessionId) {
    const session = await redis.get(`session:${sessionId}`).catch(() => null);
    if (session) {
      const refreshed = await refreshIfNeeded(session, `session:${sessionId}`, 30 * 24 * 60 * 60);
      if (refreshed) return { ...refreshed, sessionId };
    }
  }

  if (!BYPASS_ALLOWED) return null;
  const fallback = await redis.get(FALLBACK_KEY).catch(() => null);
  if (!fallback) return null;
  const refreshed = await refreshIfNeeded(fallback, FALLBACK_KEY, FALLBACK_TTL);
  if (!refreshed) return null;
  return { ...refreshed, sessionId: null, isFallback: true };
}
