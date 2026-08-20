// Operations Lead per CCS project — a VIBE-ONLY field.
//
// Deliberately not a FileMaker field: there is no `Operations Lead` on RCD_New
// and no schema change was wanted, so this lives in Redis the same way the
// Kanban board membership (kanban-board.js) and the phase N/A flags
// (na-flags.js) do. Consequence to be aware of: it is invisible in FMP Pro and
// absent from FileMaker reports, exports and backups.
//
// Stored as ONE hash per environment rather than a key per record, because the
// board renders ~40 cards at once and needs every value in a single round trip.
// One HGETALL per board load keeps this far away from the Upstash command
// budget that was blown in July (see the cron notes in CLAUDE.md).
//
//   GET  /api/ops-lead?db=High5_Core4                        → { leads: {recordId: name}, roster }
//   POST /api/ops-lead?db=High5_Core4 { recordId, name }     → set, or clear when name is ''
//   POST /api/ops-lead?db=High5_Core4 { recordId, auto:true } → assign from the caller's session
//
// The roster lives here rather than in src/ because api/ and src/ are kept as
// separate module trees (no api file imports from src). Clients read it off the
// GET response so the two can never drift; they may keep a copy purely as a
// first-render fallback.
//
// Auth: a Google session (same as the rest of the app), or x-sync-key for
// scripts/debugging (matches kanban-board.js / na-flags.js).
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';

const redis = Redis.fromEnv();
const SYNC_KEY = process.env.QBO_SYNC_KEY;

export const ROSTER = ['Ian', 'Krister', 'Jamie', 'Todd', 'Kyle'];
// Namespaced by KIND, because both CCS and Trainings identify records by
// FileMaker recordId and those are only unique WITHIN a table. RCD recordId
// 5373 and trainings recordId 5373 are different records, so a single shared
// hash would silently show one record's lead on another's card.
//
// 'ccs' keeps the original unsuffixed key so the assignments already made are
// untouched — a rename here would have quietly dropped every existing lead.
const KINDS = new Set(['ccs', 'trainings']);
const keyFor = (db, kind) => (kind === 'ccs' ? `ops:lead:${db}` : `ops:lead:${kind}:${db}`);

// Auto-assign resolves the caller's FIRST name against the roster: a match is
// assigned, anything else is left blank. That is the agreed behaviour for
// people who create CCS records but are not on the list (Colin Morton and Tom
// Woodbury between them created 73 records since 2024), and it avoids pinning
// the feature to a hardcoded set of email addresses.
//
// Caveat inherent to the roster, not to this code: it holds one "Jamie" while
// the file historically has two people by that name, so first-name matching
// cannot tell them apart if both ever have logins.
function autoLeadFor(session) {
  const first = String(session?.name || '').trim().split(/\s+/)[0] || '';
  return ROSTER.find(n => n.toLowerCase() === first.toLowerCase()) || '';
}

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  const keyed = !!(SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY));
  if (!session && !keyed) return res.status(401).json({ error: 'unauthorized' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });
  // Defaults to 'ccs' so every existing caller keeps working unchanged.
  const kind = String(req.query?.kind || 'ccs');
  if (!KINDS.has(kind)) return res.status(400).json({ error: `kind must be one of ${[...KINDS].join(', ')}` });
  const key = keyFor(db, kind);

  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const recordId = String(body.recordId || '').trim();
      if (!recordId) return res.status(400).json({ error: 'recordId required' });

      if (body.auto) {
        // Resolved server-side from the session so the creator is who actually
        // called, not whatever a client claims. HSETNX so a re-run — or a
        // retried create — can never clobber a lead someone set by hand.
        const name = autoLeadFor(session);
        if (name) await redis.hsetnx(key, recordId, name);
        return res.status(200).json({ recordId, name, auto: true, roster: ROSTER });
      }

      const name = String(body.name || '').trim();
      if (name && !ROSTER.includes(name)) return res.status(400).json({ error: 'not on the roster' });
      if (name) await redis.hset(key, { [recordId]: name });
      else await redis.hdel(key, recordId);
      return res.status(200).json({ recordId, name, roster: ROSTER });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
    const leads = (await redis.hgetall(key)) || {};
    return res.status(200).json({ leads, roster: ROSTER });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
