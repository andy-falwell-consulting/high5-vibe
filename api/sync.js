// FileMaker → Redis replica sync. Driven by Vercel Cron (see vercel.json), and
// callable manually for testing. Runs a bounded slice per invocation: resumable
// backfill first, then incremental modified-since.
//
// GET/POST /api/sync?db=High5_Core4           → sync all replicated layouts
// GET/POST /api/sync?db=High5_Core4&layout=contacts
// GET/POST /api/sync?db=…&layout=estimates&full=1 → re-page that layout in full
//
// `full=1` is what you want after adding a FIELD to a replicated layout: the
// incremental sync keys on each record's modification date, which a schema
// change does not touch, so the new field would otherwise never reach the app.
// It requires an explicit `layout` — re-paging all eight at once would be a
// large, unintended spend against the Redis command budget.
import { runSync, resetReplica, REPLICATED } from './_replica.js';

// Pro plan: allow a long slice so each run makes real progress on the backfill.
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  const db = req.query.db || 'High5_Core4';
  const only = req.query.layout;
  const keys = only ? [only] : Object.keys(REPLICATED);

  const full = req.query.full === '1' || req.query.full === 'true';
  if (full) {
    if (!only) return res.status(400).json({ error: 'full=1 requires an explicit &layout=' });
    if (!REPLICATED[only]) return res.status(400).json({ error: 'not replicated: ' + only });
    await resetReplica(db, only);
  }

  // Shared deadline with headroom under maxDuration (300s). Each layout gets a
  // fair share of the *remaining* time, so already-synced layouts (incremental
  // no-op / fresh snapshot) return almost instantly and hand their budget to
  // whichever layouts are still backfilling.
  const deadline = Date.now() + 270000;
  const out = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!REPLICATED[key]) { out[key] = { error: 'not replicated' }; continue; }
    const budget = Math.max(0, Math.floor((deadline - Date.now()) / (keys.length - i)));
    try {
      const meta = await runSync(db, key, budget);
      out[key] = { phase: meta.phase, count: meta.count, total: meta.total, lastSync: meta.lastSync };
    } catch (e) {
      out[key] = { error: String(e?.message || e) };
    }
  }
  return res.status(200).json({ db, result: out });
}
