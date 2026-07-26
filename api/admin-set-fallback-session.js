import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail } from './_admin.js';

// One-time (well — weekly, since Google expires refresh tokens after 7 days
// for this unverified/Testing-mode OAuth app) admin action: captures the
// caller's OWN current, real login session into a fixed Redis key that
// _googleSession.js falls back to on the preview deployment when a request
// has no login cookie. See CLAUDE.md's "Preview auth bypass" section.
const redis = Redis.fromEnv();
const FALLBACK_KEY = 'fallback_session';
const FALLBACK_META_KEY = 'fallback_session_meta';
const FALLBACK_TTL = 60 * 24 * 60 * 60;

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session || session.isFallback) return res.status(401).json({ error: 'Sign in with your own Google account first.' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  if (req.method === 'GET') {
    const meta = await redis.get(FALLBACK_META_KEY).catch(() => null);
    return res.json({ meta });
  }

  if (req.method === 'POST') {
    const { sessionId, isFallback, ...toStore } = session; // eslint-disable-line no-unused-vars -- strip transient/derived fields before storing
    await redis.set(FALLBACK_KEY, toStore, { ex: FALLBACK_TTL });
    const meta = { capturedAt: new Date().toISOString(), capturedBy: session.email };
    await redis.set(FALLBACK_META_KEY, meta, { ex: FALLBACK_TTL });
    return res.json({ ok: true, meta });
  }

  return res.status(405).end();
}
