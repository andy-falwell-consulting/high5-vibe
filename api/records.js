// Fast cursor-paged read of a replicated layout from Redis (see api/_replica.js).
// GET /api/records?layout=contacts&db=High5_Core4&cursor=0
//   → { records, cursor, meta }   (loop until cursor === '0')
import { scanReplica, getMetaPublic, REPLICATED } from './_replica.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { layout, db, cursor = '0' } = req.query;
  if (!layout || !REPLICATED[layout]) return res.status(400).json({ error: 'unknown layout' });
  if (!db) return res.status(400).json({ error: 'db required' });
  try {
    const [{ cursor: next, records }, meta] = await Promise.all([
      scanReplica(db, layout, String(cursor)),
      cursor === '0' ? getMetaPublic(db, layout) : Promise.resolve(undefined),
    ]);
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({ records, cursor: next, count: records.length, ...(meta !== undefined ? { meta } : {}) });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
