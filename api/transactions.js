// Read API for the Transactions page, backed by the Redis mirror (txn-sync).
//   GET /api/transactions?db=High5_Core4&cursor=0   → { cursor, records:[slim] }
//   GET /api/transactions?db=High5_Core4&id=Invoice:123 → full record (with lines)
// Line items live in their own hash (txn:{db}:lines) since v1.0.505, so the
// ledger read ships rows only — the list needs every row and none of the lines,
// and shipping them was 62% of a 21 MB Redis read on every load.
//
// BOTH SHAPES ARE UNDERSTOOD, because the re-sync that moves records to the new
// one runs over several hours and reads must stay correct throughout: a row
// mirrored under the old shape still carries its own `lines`, so the list strips
// them and the detail falls back to them.
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';

const redis = Redis.fromEnv();
const SYNC_KEY = process.env.QBO_SYNC_KEY;
const recsKey = db => `txn:${db}:recs`;
const linesKey = db => `txn:${db}:lines`;

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}

const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);
// Legacy rows carry their lines inline; new ones do not. Either way the list
// answers without them.
const slim = r => { const { lines, ...rest } = r; return rest; };

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const db = req.query?.db || 'High5_Core4';

  try {
    if (req.query?.id) {
      const id = String(req.query.id);
      const [v, l] = await Promise.all([
        redis.hget(recsKey(db), id),
        redis.hget(linesKey(db), id),
      ]);
      if (!v) return res.status(404).json({ error: 'not found' });
      const row = parse(v);
      // The lines hash wins; a legacy row's inline copy is the fallback until
      // the re-sync reaches it.
      const lines = (l && parse(l)) || row.lines || [];
      return res.status(200).json({ ...slim(row), lines });
    }

    const cursor = String(req.query?.cursor ?? '0');
    const [next, flat] = await redis.hscan(recsKey(db), cursor, { count: 5000 });
    const records = [];
    for (let i = 1; i < flat.length; i += 2) records.push(slim(parse(flat[i])));
    return res.status(200).json({ cursor: String(next), records });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
