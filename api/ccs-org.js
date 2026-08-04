// Organization assignment for a CCS project — a VIBE-ONLY field.
//
// WHY THIS EXISTS
// A CCS record's organization is not writable over the FileMaker Data API.
// Verified across both environments: every organization field on every
// API-visible layout is a CALCULATION (RCD_New, RCD_List and Contacts_New all
// report `class=calculation` for zz__Display_Organization__ct, and a PATCH
// returns "201 Field cannot be modified"). The only writable candidates are
// Name_Organization on the contact itself, which renames an organization
// rather than assigning one. The stored key that actually drives it is on no
// layout, so the Data API can neither read nor write it.
//
// So the assignment lives in Redis, the same way the Kanban board membership
// (kanban-board.js), the phase N/A flags (na-flags.js) and the Operations Lead
// (ops-lead.js) do. Consequence: FileMaker does not see it. A CCS record
// assigned here shows the new organization in Vibe and the old one (or none)
// in FMP Pro.
//
// If the stored FileMaker key is ever identified, this endpoint can be swapped
// for a script call without the UI changing — the client only needs an
// organization contact id either way.
//
// Stored as ONE hash per environment rather than a key per record: the list and
// board render hundreds of rows at once and need every value in a single
// HGETALL, which keeps this clear of the Upstash command budget.
//
//   GET  /api/ccs-org?db=High5_Core4                          → { orgs: {recordId: contactId} }
//   POST /api/ccs-org?db=High5_Core4 { recordId, contactId }  → set, or clear when contactId is ''
//
// Auth: a Google session, or x-sync-key for scripts (matches ops-lead.js).
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';

const redis = Redis.fromEnv();
const SYNC_KEY = process.env.QBO_SYNC_KEY;
const keyFor = db => `ccs:org:${db}`;

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
      const recordId = String(body.recordId || '').trim();
      if (!recordId) return res.status(400).json({ error: 'recordId required' });
      const contactId = String(body.contactId || '').trim();
      // Only the id is stored, never the name — so a rename in FileMaker flows
      // through instead of leaving a stale label behind.
      if (contactId) await redis.hset(key, { [recordId]: contactId });
      else await redis.hdel(key, recordId);
      return res.status(200).json({ recordId, contactId });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
    return res.status(200).json({ orgs: (await redis.hgetall(key)) || {} });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
