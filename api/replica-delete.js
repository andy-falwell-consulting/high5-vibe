// Replica deletion hook. FileMaker fires a POST here when a replicated record is
// deleted, so the row is removed from the Redis replica (the incremental sync
// only upserts modified records — it never sees deletions). See api/_replica.js.
//
// POST /api/replica-delete
//   headers: x-sync-key: <REPLICA_SYNC_KEY or QBO_SYNC_KEY>   (or ?key=)
//   body (application/json): {
//     db:        "High5_Core4" | "High5_Core4_Dev" | "High5_Core4_Stage",
//     layout:    "Contacts_New"            // the replicated FMP layout, OR
//     key:       "contacts",               // the app key (alternative to layout)
//     recordId:  "12345"                   // FileMaker Get(RecordID) of the deleted record, OR
//     recordIds: ["12345","12346"]         // batch
//   }
import { Redis } from '@upstash/redis';
import { REPLICATED } from './_replica.js';

const redis = Redis.fromEnv();
const ALLOWED_DBS = new Set(['High5_Core4', 'High5_Core4_Stage', 'High5_Core4_Dev']);
const KEY = process.env.REPLICA_SYNC_KEY || process.env.QBO_SYNC_KEY;
const rk = (db, layout, suffix) => `repl:${db}:${layout}:${suffix}`;

function authorized(req) {
  return !!KEY && (req.headers['x-sync-key'] === KEY || req.query?.key === KEY);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const { db, layout, key } = req.body || {};
  let recordIds = (req.body?.recordIds) || (req.body?.recordId != null ? [req.body.recordId] : []);
  recordIds = recordIds.map(String).map(s => s.trim()).filter(Boolean);

  if (!db || !ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'valid db required' });

  // Resolve the replicated FMP layout name from either `layout` or the app `key`.
  const replLayout = layout || (key && REPLICATED[key]?.layout);
  const isReplicated = replLayout && Object.values(REPLICATED).some(c => c.layout === replLayout);
  if (!isReplicated) return res.status(400).json({ error: 'unknown or non-replicated layout/key' });

  if (!recordIds.length) return res.status(400).json({ error: 'recordId or recordIds required' });

  try {
    const removed = await redis.hdel(rk(db, replLayout, 'recs'), ...recordIds);
    // keep meta.count honest
    const metaKey = rk(db, replLayout, 'meta');
    const meta = await redis.get(metaKey);
    if (meta) { meta.count = await redis.hlen(rk(db, replLayout, 'recs')); await redis.set(metaKey, meta); }
    return res.status(200).json({ ok: true, db, layout: replLayout, requested: recordIds.length, removed });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
