// Live QBO estimate lookup for a CCS/project record. The link is the estimate
// DocNumber "D-####", stored (free-text, often with notes appended) in the
// RCD_New repeating field `_kat__QuickBooks_Estimate_ID`. We parse the D-token
// out of that field and pull the CURRENT estimate straight from QBO, so the
// CCS Workspace can show live status/total without duplicating anything into
// FileMaker or running a bulk write-back.
//
//   GET /api/ccs-estimate?db=High5_Core4&recordId=10253   (resolve via FMP)
//   GET /api/ccs-estimate?doc=D-3041                       (direct lookup, no FMP)
// Auth: x-sync-key header/query (QBO_SYNC_KEY) or a Google session.
import { getGoogleSession } from './_googleSession.js';
import { fmpToken, ALLOWED_DBS } from './_fmp.js';
import { qboQuery } from './_qbo.js';

export const config = { maxDuration: 30 };

const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const SYNC_KEY = process.env.QBO_SYNC_KEY;

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}

// Pull every "D-####" token out of a free-text value (handles a stray space
// after the dash, and multiple tokens like "D-1040 - Outdoor, Was D-7171").
const parseDocs = s => [...new Set([...String(s || '').matchAll(/D-\s?(\d+)/gi)].map(m => `D-${m[1]}`))];

const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

// Map a raw QBO Estimate to the slim shape the UI needs.
function slim(e) {
  return {
    docNumber: e.DocNumber || '',
    qboId: e.Id,
    status: e.TxnStatus || '',            // Pending | Accepted | Closed | Rejected
    total: n(e.TotalAmt),
    date: e.TxnDate || '',
    expiration: e.ExpirationDate || '',
    acceptedDate: e.AcceptedDate || '',
    customer: e.CustomerRef?.name || '',
    updated: e.MetaData?.LastUpdatedTime || '',
  };
}

// Read the CCS record's estimate-id reps (1-3 are placed on RCD_New) and parse.
async function docsFromRecord(db, recordId) {
  const token = await fmpToken(db);
  const r = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/RCD_New/records/${recordId}`,
    { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  const fd = j?.response?.data?.[0]?.fieldData;
  if (!fd) return { docs: [], org: null };
  const raw = [1, 2, 3, 4, 5].map(i => fd[`_kat__QuickBooks_Estimate_ID(${i})`]).filter(Boolean).join(' ');
  return { docs: parseDocs(raw), org: fd.zz__Display_Organization__ct || fd.zz__Display_Contact__ct || null };
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  try {
    let docs, org = null;
    if (req.query?.doc) {
      docs = parseDocs(req.query.doc);
    } else {
      const db = req.query?.db || 'High5_Core4';
      if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });
      if (!req.query?.recordId) return res.status(400).json({ error: 'recordId or doc required' });
      ({ docs, org } = await docsFromRecord(db, String(req.query.recordId)));
    }

    if (!docs.length) return res.status(200).json({ org, docs: [], estimates: [] });

    // One QBO query for all this record's D#s. DocNumbers are safe (D + digits).
    const inList = docs.map(d => `'${d}'`).join(',');
    const qr = await qboQuery(`SELECT * FROM Estimate WHERE DocNumber IN (${inList})`);
    const estimates = (qr.Estimate || []).map(slim);
    // Preserve the record's D# order; flag any that didn't resolve in QBO.
    const byDoc = Object.fromEntries(estimates.map(e => [e.docNumber, e]));
    const ordered = docs.map(d => byDoc[d] || { docNumber: d, missing: true });
    return res.status(200).json({ org, docs, estimates: ordered });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 400) });
  }
}
