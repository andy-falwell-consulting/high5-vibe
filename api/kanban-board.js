// Shared, team-wide "which CCS jobs are on the Kanban board" set. The board is
// curated by hand (Ian + team) rather than auto-showing every active-status
// project. Membership lives in Redis (one set per environment) so everyone sees
// the same board; a card's column still comes from its merged Status. Keyed by
// FMP recordId, which is stable within an environment.
//
//   GET  /api/kanban-board?db=High5_Core4            → { ids: [...] }
//   POST /api/kanban-board?db=High5_Core4  { id, on } → add (on!==false) / remove
// Auth: a Google session (same as the rest of the app), or x-sync-key for
// scripts/backfills (matches distance-sync.js / ccs-estimate.js).
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';

const redis = Redis.fromEnv();
const SYNC_KEY = process.env.QBO_SYNC_KEY;
const keyFor = db => `kanban:onboard:${db}`;
const asList = v => (Array.isArray(v) ? v.map(String) : []);

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });
  const key = keyFor(db);

  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const id = String(body.id || '').trim();
      if (!id) return res.status(400).json({ error: 'id required' });
      if (body.on === false) await redis.srem(key, id);
      else await redis.sadd(key, id);
    } else if (req.method !== 'GET') {
      return res.status(405).json({ error: 'method not allowed' });
    }
    return res.status(200).json({ ids: asList(await redis.smembers(key)) });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
