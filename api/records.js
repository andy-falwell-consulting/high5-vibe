// Fast cursor-paged read of a replicated layout from Redis (see api/_replica.js).
//
//   GET /api/records?layout=contacts&db=High5_Core4&cursor=0
//     → { records, cursor, meta }              (loop until cursor === '0')
//
//   GET /api/records?layout=contacts&db=High5_Core4&since=<ms>
//     → { mode: 'incremental', records, removed, now }   only what changed
//     → { mode: 'full' }                                 caller must re-page
//
// The `since` form is why the change index exists. A refresh used to re-read
// the whole hash — 26 MB for contacts — to discover that a dozen records had
// moved. It answers 'full' rather than guessing whenever an incremental answer
// would be wrong (no index, watermark older than the index) or wasteful (more
// than a third of the layout changed), so the caller always has a correct path.
import { scanReplica, changesSince, getMetaPublic, REPLICATED } from './_replica.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { layout, db, cursor = '0', since } = req.query;
  if (!layout || !REPLICATED[layout]) return res.status(400).json({ error: 'unknown layout' });
  if (!db) return res.status(400).json({ error: 'db required' });
  try {
    if (since) {
      const out = await changesSince(db, layout, Number(since));
      // Never cached at the edge: the answer depends on the caller's watermark,
      // and a shared cache would hand one client another's delta.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(out);
    }
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
