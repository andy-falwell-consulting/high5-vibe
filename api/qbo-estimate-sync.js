// QuickBooks → FileMaker, status-only, for estimates already pushed from Vibe.
// Scope (explicit user decision, 2026-07-10): QBO and the Estimates_New record
// are the SAME estimate once qbo_estimate_id is set — not a separate mirror.
// This sync pulls back ONLY QBO's TxnStatus (Pending/Accepted/Closed/Rejected)
// into `qbo_estimate_status`. It never touches totals or line items — FMP stays
// authoritative for those, since Estimates.jsx has no line-item editing UI and
// QBO was only ever a one-way push target for estimate content.
//
// GET/POST /api/qbo-estimate-sync?db=High5_Core4_Dev   (gated; see authorized())
import { getGoogleSession } from './_googleSession.js';
import { qboQuery } from './_qbo.js';
import { fmpToken, fmFind, fmUpdate, ALLOWED_DBS } from './_fmp.js';

export const config = { maxDuration: 120 };

const SYNC_KEY = process.env.QBO_SYNC_KEY;
const LAYOUT = 'Estimates_New';
const QBO_BATCH = 25; // ids per QBO WHERE-IN query

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  const cron = process.env.CRON_SECRET;
  if (cron && req.headers.authorization === `Bearer ${cron}`) return true;
  return !!(await getGoogleSession(req));
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

export async function runEstimateStatusSync(db) {
  if (!ALLOWED_DBS.has(db)) throw new Error('db not allowed');
  const token = await fmpToken(db);

  // Every Estimates_New record already linked to QBO. Soft-capped at 500 — the
  // linked set only grows by explicit human push (CreateInQBO), so this is
  // generous headroom, not a real limit; if ever exceeded, the remainder picks
  // up on the next run.
  const linked = await fmFind(db, LAYOUT, [{ qbo_estimate_id: '*' }], token, 500);
  if (!linked.length) return { checked: 0, updated: 0, unchanged: 0, failed: 0 };

  const byQboId = new Map(linked.map(r => [String(r.fieldData.qbo_estimate_id), r]));
  let updated = 0, unchanged = 0, failed = 0;

  for (const ids of chunk([...byQboId.keys()], QBO_BATCH)) {
    const inList = ids.map(id => `'${id}'`).join(',');
    let statuses;
    try {
      const qr = await qboQuery(`SELECT Id, TxnStatus FROM Estimate WHERE Id IN (${inList})`);
      statuses = qr.Estimate || [];
    } catch {
      failed += ids.length;
      continue;
    }
    for (const est of statuses) {
      const rec = byQboId.get(String(est.Id));
      if (!rec) continue;
      const fresh = est.TxnStatus || '';
      if (fresh === (rec.fieldData.qbo_estimate_status || '')) { unchanged++; continue; }
      try {
        await fmUpdate(db, LAYOUT, rec.recordId, { qbo_estimate_status: fresh }, token);
        updated++;
      } catch { failed++; }
    }
  }

  return { checked: byQboId.size, updated, unchanged, failed };
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const db = req.query.db || 'High5_Core4_Dev';
  if (db === 'High5_Core4' && process.env.QBO_SYNC_ALLOW_PROD !== '1') {
    return res.status(403).json({ error: 'production sync disabled (set QBO_SYNC_ALLOW_PROD=1 to enable)' });
  }
  try {
    const result = await runEstimateStatusSync(db);
    return res.status(200).json({ db, ...result });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
