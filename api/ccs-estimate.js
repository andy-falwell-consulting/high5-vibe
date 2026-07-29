// Live QBO financials for a CCS/project record — estimates AND invoices.
//
// Estimates link by DocNumber "D-####", stored (free-text, often with notes
// appended) in the RCD_New repeating field `_kat__QuickBooks_Estimate_ID`
// (populated on 71% of CCS records). Invoices link by the plain reference in
// `_kat__QuickBooks_Invoice_ID` (60.8%). Both are read straight from QBO, so
// the CCS Workspace shows live figures without duplicating anything into
// FileMaker or running a bulk write-back.
//
// Why not the FileMaker portals: `Portal__Invoices` / `Portal__Payments` on
// RCD_New are filtered by GLOBAL fields (GLBL::Portal_Filter_*). Globals are
// session state — they're set when a human works the layout in FMP Pro, and a
// Data API session never gets them. The result over the API is 1,125 hollow
// invoice rows (real row ids, every field blank) and zero payment rows, which
// is why the KPI tiles read '—' on every record. Those portals also resolve
// through the CONTACT, so even working they'd show every invoice for the
// client rather than this project's.
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

// Invoice references are plain digits ("64995"), unlike the D-prefixed estimate
// tokens — pull every number of 3+ digits so trailing notes don't break it.
const parseInvoiceRefs = s => [...new Set([...String(s || '').matchAll(/\b(\d{3,})\b/g)].map(m => m[1]))];

// Map a raw QBO Invoice to the slim shape the UI needs. `Balance` is what's
// still owed, so paid = total - balance (no inference required).
function slimInvoice(i) {
  const total = n(i.TotalAmt);
  const balance = n(i.Balance);
  return {
    docNumber: i.DocNumber || '',
    qboId: i.Id,
    total,
    balance,
    paid: Math.round((total - balance) * 100) / 100,
    date: i.TxnDate || '',
    dueDate: i.DueDate || '',
    customer: i.CustomerRef?.name || '',
  };
}

// Read the CCS record's estimate + invoice id reps and parse both.
async function refsFromRecord(db, recordId) {
  const token = await fmpToken(db);
  const r = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/RCD_New/records/${recordId}`,
    { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  const fd = j?.response?.data?.[0]?.fieldData;
  if (!fd) return { docs: [], invoiceRefs: [], org: null };
  const rawEst = [1, 2, 3, 4, 5].map(i => fd[`_kat__QuickBooks_Estimate_ID(${i})`]).filter(Boolean).join(' ');
  const rawInv = [1, 2, 3].map(i => fd[`_kat__QuickBooks_Invoice_ID(${i})`]).filter(Boolean).join(' ');
  return {
    docs: parseDocs(rawEst),
    invoiceRefs: parseInvoiceRefs(rawInv),
    org: fd.zz__Display_Organization__ct || fd.zz__Display_Contact__ct || null,
  };
}

// The stored invoice reference is a bare number, and it isn't documented whether
// that's QBO's DocNumber or its internal Id — the file holds both shapes.
//
// Resolution is DocNumber-FIRST, and the Id query only covers references that
// DocNumber did not resolve. Querying both and merging is wrong: a single
// reference can legitimately match one invoice's DocNumber AND a different
// invoice's Id. Record 15741 does exactly that — ref "81092" is invoice 81092
// ($148,435.01) and also the internal Id of invoice 77334 ($695) — so merging
// silently added $695 of an unrelated invoice to the project's total.
async function fetchInvoices(refs) {
  if (!refs.length) return [];
  const quote = list => list.map(v => `'${v}'`).join(',');

  const byDoc = await qboQuery(`SELECT * FROM Invoice WHERE DocNumber IN (${quote(refs)})`).catch(() => ({}));
  const found = (byDoc.Invoice || []).map(slimInvoice);
  const resolved = new Set(found.map(i => i.docNumber));

  const unresolved = refs.filter(r => !resolved.has(r));
  if (unresolved.length) {
    const byId = await qboQuery(`SELECT * FROM Invoice WHERE Id IN (${quote(unresolved)})`).catch(() => ({}));
    for (const inv of byId.Invoice || []) {
      if (!found.some(f => f.qboId === inv.Id)) found.push(slimInvoice(inv));
    }
  }
  return found;
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  try {
    let docs, invoiceRefs = [], org = null;
    if (req.query?.doc) {
      docs = parseDocs(req.query.doc);
    } else {
      const db = req.query?.db || 'High5_Core4';
      if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });
      if (!req.query?.recordId) return res.status(400).json({ error: 'recordId or doc required' });
      ({ docs, invoiceRefs, org } = await refsFromRecord(db, String(req.query.recordId)));
    }

    // Estimates and invoices are independent — a record can have either, both,
    // or neither, so fetch in parallel and never let one failure hide the other.
    const [ordered, invoices] = await Promise.all([
      (async () => {
        if (!docs.length) return [];
        const inList = docs.map(d => `'${d}'`).join(',');
        const qr = await qboQuery(`SELECT * FROM Estimate WHERE DocNumber IN (${inList})`);
        const estimates = (qr.Estimate || []).map(slim);
        // Preserve the record's D# order; flag any that didn't resolve in QBO.
        const byDoc = Object.fromEntries(estimates.map(e => [e.docNumber, e]));
        return docs.map(d => byDoc[d] || { docNumber: d, missing: true });
      })(),
      fetchInvoices(invoiceRefs),
    ]);

    // Roll up here so the KPI tiles just render. `estimated` prefers the
    // estimate total and falls back to what was actually invoiced, matching how
    // the workspace previously behaved. null (not 0) means "nothing linked" —
    // the UI shows an em dash rather than a misleading $0.00.
    const sum = (arr, k) => arr.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    const estimated = docs.length ? sum(ordered.filter(e => !e.missing), 'total') : null;
    const invoiced = invoiceRefs.length ? sum(invoices, 'total') : null;
    const totals = {
      estimated: estimated || invoiced,
      invoiced,
      received: invoiceRefs.length ? sum(invoices, 'paid') : null,
      balanceDue: invoiceRefs.length ? sum(invoices, 'balance') : null,
    };

    return res.status(200).json({ org, docs, estimates: ordered, invoiceRefs, invoices, totals });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 400) });
  }
}
