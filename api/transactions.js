// Read API for the Transactions page, backed by the Redis mirror (txn-sync).
//   GET /api/transactions?db=High5_Core4&cursor=0   → { cursor, records:[slim] }
//   GET /api/transactions?db=High5_Core4&id=Invoice:123 → full record (with lines)
// Slim rows omit line items so the client can load the whole ledger cheaply;
// the detail view fetches one full record by id.
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';

const redis = Redis.fromEnv();
const SYNC_KEY = process.env.QBO_SYNC_KEY;
const recsKey = db => `txn:${db}:recs`;

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}

const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);
const slim = r => { const { lines, ...rest } = r; return rest; };

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const db = req.query?.db || 'High5_Core4';

  try {
    if (req.query?.id) {
      const v = await redis.hget(recsKey(db), String(req.query.id));
      if (!v) return res.status(404).json({ error: 'not found' });
      return res.status(200).json(parse(v));
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
