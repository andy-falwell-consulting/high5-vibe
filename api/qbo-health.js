// Daily QuickBooks token health check.
//
// Why this exists: the QBO refresh token is normally self-maintaining — the
// invoice/estimate/txn crons call QBO every 15 minutes, and each refresh issues
// a new refresh token that resets Intuit's ~100-day window. But the chain can
// break (e.g. the 2026-07-19 Upstash quota exhaustion: Intuit rotated the token
// while the Redis write that stores it failed), and once broken it never heals
// on its own. That happened and went unnoticed for about a week, with invoice
// mirroring and estimate status sync silently dead the whole time.
//
// This records the connection's state so the app can surface it, and tracks
// how long it has been broken.
//
// GET /api/qbo-health?env=production   (cron: Authorization: Bearer CRON_SECRET)
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { getAccessToken } from './_qbo.js';

const redis = Redis.fromEnv();
const SYNC_KEY = process.env.QBO_SYNC_KEY;
export const HEALTH_KEY = 'qbo_health';

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  const cron = process.env.CRON_SECRET;
  if (cron && req.headers.authorization === `Bearer ${cron}`) return true;
  return !!(await getGoogleSession(req));
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });

  // peek=1 returns the last recorded state without contacting Intuit. The
  // in-app banner polls this on load, and a token exchange per page view would
  // be both slow and pointless — the cron is what keeps the state fresh.
  if (req.query?.peek) {
    try {
      const prev = await redis.get(HEALTH_KEY);
      return res.status(200).json(prev || { unknown: true });
    } catch {
      return res.status(200).json({ unknown: true });
    }
  }

  const env = req.query?.env === 'sandbox' ? 'sandbox' : 'production';
  const now = new Date().toISOString();

  let state;
  try {
    await getAccessToken(env);
    state = { ok: true, env, checkedAt: now };
  } catch (e) {
    const msg = String(e?.message || e);
    // Keep the original brokenSince across repeated failures, so the banner can
    // say how long this has actually been down rather than resetting daily.
    let brokenSince = now;
    try {
      const prev = await redis.get(HEALTH_KEY);
      if (prev && prev.ok === false && prev.brokenSince) brokenSince = prev.brokenSince;
    } catch { /* first run, or Redis unreachable — today is close enough */ }
    state = {
      ok: false, env, checkedAt: now, brokenSince,
      reason: msg.includes('invalid_grant') ? 'expired' : 'error',
      detail: msg.slice(0, 300),
    };
  }

  // Never let a Redis failure turn a health check into a 500 — the caller still
  // wants the live answer even if we couldn't record it.
  try { await redis.set(HEALTH_KEY, state, { ex: 86400 * 30 }); } catch { /* not fatal */ }
  return res.status(200).json(state);
}
