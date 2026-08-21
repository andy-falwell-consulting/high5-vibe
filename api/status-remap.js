// Remap retired Trainings statuses onto current ones.
//
//   GET  /api/status-remap?db=High5_Core4              → the plan, writes NOTHING
//   POST /api/status-remap?db=High5_Core4&confirm=yes  → applies it
//
// Admin-only, and read-only by default. Five statuses were retired on
// 2026-08-20 (see src/config/trainingStatus.js, LEGACY_STATUSES) and 84 records
// still carry one. Those records display correctly and keep their status; this
// is how they stop being legacy.
//
// WRITES THROUGH VIBE'S OVERLAY, not FileMaker. trainings_New is in VIBE_OWNED,
// so a write to the FileMaker row would be shadowed by any existing fragment
// and appear to do nothing. writeFragment is the same call the record editor
// makes, so these edits are attributed and reversible exactly like a human's.
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail } from './_admin.js';
import { ALLOWED_DBS } from './_fmp.js';
import { writeFragment, readOverlay, mergeRecord } from './_vibeStore.js';

export const config = { maxDuration: 300 };

const redis = Redis.fromEnv();
const LAYOUT = 'trainings_New';

// Retired status → what it becomes. A value mapped to null is retired but NOT
// yet decided: the plan reports it so the remaining work is visible, and the
// apply step leaves it alone.
//
// 'Ready to Bill' → 'Waiting on $ & Signed TC' (Andy, 2026-08-20). Both mean
// "the work is done and we have not been paid", so the mapping is honest.
//
// Worth knowing before running it: 'Waiting on $ & Signed TC' is a PIPELINE
// STAGE, so these records become IN-FLIGHT. All four are 2013–2014 trainings
// last touched between 2014 and 2021, so they will start appearing as live
// pipeline work and in the Kanban's seedable set. That is what the mapping
// asks for; it is not a side effect anyone should discover later.
export const STATUS_REMAP = {
  'Ready to Bill': 'Waiting on $ & Signed TC',
  'Keene EOL/C&S': null,
  'Covid': null,
  'OE': null,
  'Business Development': null,
};

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

/** Every record whose CURRENT status (replica merged with overlay) is retired. */
async function findLegacy(db) {
  const overlay = await readOverlay(db, LAYOUT);
  const out = [];
  let cursor = '0';
  do {
    const [next, flat] = await redis.hscan(`repl:${db}:${LAYOUT}:recs`, cursor, { count: 1000 });
    for (let i = 1; i < flat.length; i += 2) {
      const base = parse(flat[i]);
      if (!base) continue;
      const id = String(base.recordId);
      // The overlay is what the app actually shows, so it is what must be
      // read — a status already edited in Vibe is not the replica's value.
      const rec = overlay.has(id) ? mergeRecord(base, overlay.get(id)) : base;
      if (rec?.__deleted) continue;
      const status = String(rec?.fieldData?.Status ?? '').trim();
      if (status in STATUS_REMAP) {
        out.push({
          recordId: id,
          id: rec.fieldData?._kpt__TrainingProposal_ID ?? null,
          org: rec.fieldData?.zz__Display_Organization__ct || '—',
          start: rec.fieldData?.['Start Date'] || '',
          from: status,
          to: STATUS_REMAP[status],
        });
      }
    }
    cursor = String(next);
  } while (cursor !== '0');
  return out;
}

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });
  const commit = req.method === 'POST' && req.query?.confirm === 'yes';

  try {
    const found = await findLegacy(db);
    const mapped = found.filter(r => r.to);
    const undecided = found.filter(r => !r.to);

    const byStatus = {};
    for (const r of found) {
      byStatus[r.from] = byStatus[r.from] || { from: r.from, to: r.to, records: 0 };
      byStatus[r.from].records++;
    }

    if (!commit) {
      return res.status(200).json({
        mode: 'plan (nothing written)',
        total: found.length,
        willChange: mapped.length,
        undecided: undecided.length,
        byStatus: Object.values(byStatus),
        sample: mapped.slice(0, 25),
      });
    }

    const done = [];
    const failed = [];
    for (const r of mapped) {
      try {
        await writeFragment(db, LAYOUT, r.recordId, { Status: r.to }, session.email);
        done.push({ recordId: r.recordId, org: r.org, from: r.from, to: r.to });
      } catch (e) {
        failed.push({ recordId: r.recordId, why: String(e?.message || e).slice(0, 160) });
      }
    }
    return res.status(200).json({
      mode: 'applied',
      changed: done.length,
      undecided: undecided.length,
      failed,
      by: session.email,
      records: done,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
