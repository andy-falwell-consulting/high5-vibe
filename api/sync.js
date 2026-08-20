// FileMaker → Redis replica sync. Driven by Vercel Cron (see vercel.json), and
// callable manually for testing. Runs a bounded slice per invocation: resumable
// backfill first, then incremental modified-since.
//
// GET/POST /api/sync?db=High5_Core4           → sync all replicated layouts
// GET/POST /api/sync?db=High5_Core4&layout=contacts
// GET/POST /api/sync?db=…&layout=estimates&full=1 → re-page that layout in full
//
// NO LONGER ON A CRON. It ran every five minutes — 288 invocations a day, 54%
// of the whole cron schedule and the largest single draw on the Redis command
// budget — which made sense when FileMaker was the system of record. It is not
// any more: Vibe owns its records, and pulling FileMaker's copy 288 times a day
// to find nothing changed is spend without a reader. It is now driven by the
// button in Admin → FMP.
//
// `full=1` is what you want after adding a FIELD to a replicated layout: the
// incremental sync keys on each record's modification date, which a schema
// change does not touch, so the new field would otherwise never reach the app.
// It requires an explicit `layout` — re-paging all eight at once would be a
// large, unintended spend against the Redis command budget.
import { runSync, resetReplica, REPLICATED } from './_replica.js';
import { getGoogleSession } from './_googleSession.js';

// GATED, which it was not before. This endpoint had no auth check at all: any
// caller could start a full re-page of eight layouts and spend the Redis budget
// on demand. That was survivable while nothing pointed at it; putting a button
// on it makes it reachable and worth closing. Same three ways in as
// replica-reconcile, so scripts and any future cron keep working.
const SYNC_KEY = process.env.REPLICA_SYNC_KEY || process.env.QBO_SYNC_KEY;

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  const cron = process.env.CRON_SECRET;
  if (cron && req.headers.authorization === `Bearer ${cron}`) return true;
  return !!(await getGoogleSession(req));
}

// Pro plan: allow a long slice so each run makes real progress on the backfill.
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
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
