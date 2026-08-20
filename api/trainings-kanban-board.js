// Shared, team-wide "which trainings are on the Kanban board" set — mirrors
// api/kanban-board.js for CCS exactly, same reasoning: the board is curated
// by hand rather than auto-showing every active-status training. Membership
// lives in Redis (one set per environment) so everyone sees the same board;
// a card's column still comes from its own Status field. Keyed by FMP
// recordId, which is stable within an environment.
//
//   GET  /api/trainings-kanban-board?db=High5_Core4            → { ids: [...] }
//   POST /api/trainings-kanban-board?db=High5_Core4  { id, on } → add (on!==false) / remove
// Auth: a Google session (same as the rest of the app), or x-sync-key for
// scripts/backfills (matches distance-sync.js / ccs-estimate.js).
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';

const redis = Redis.fromEnv();
const SYNC_KEY = process.env.QBO_SYNC_KEY;
const keyFor = db => `trainings-kanban:onboard:${db}`;
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

      // Seed the board with every training starting from a given date onward.
      //
      // The board is normally curated by hand, one card at a time, which is
      // fine for adding a few and useless for filling an empty board. Ids are
      // supplied by the CALLER rather than found here: the client already holds
      // the whole trainings cache and can filter it on Start Date, and doing it
      // there avoids this endpoint paging FileMaker for something the browser
      // already knows.
      //
      // Adds only. Existing cards are untouched and nothing is removed, so
      // running it twice is harmless and it can never clear a curated board.
      if (Array.isArray(body.seedIds)) {
        const ids = [...new Set(body.seedIds.map(String).map(x => x.trim()).filter(Boolean))];
        if (!ids.length) return res.status(400).json({ error: 'seedIds was empty' });
        if (ids.length > 2000) return res.status(400).json({ error: 'refusing to seed more than 2000 at once' });
        const before = new Set(asList(await redis.smembers(key)));
        const fresh = ids.filter(id => !before.has(id));
        if (fresh.length) await redis.sadd(key, ...fresh);
        return res.status(200).json({
          seeded: fresh.length, alreadyOnBoard: ids.length - fresh.length,
          ids: asList(await redis.smembers(key)),
        });
      }

      const id = String(body.id || '').trim();
      if (!id) return res.status(400).json({ error: 'id or seedIds required' });
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
