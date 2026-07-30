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

// ── Customer-match guard ─────────────────────────────────────────
// A stored reference can resolve to a QBO record belonging to a completely
// different client. Measured on 40 CCS records carrying an estimate reference:
// 30 estimates resolved to another customer entirely (e.g. Ashokan Center's
// "D-3199" is Gateway Healthcare, Inc, dated 2013 — eleven years before that
// project). Invoices are far cleaner: the only two "mismatches" in the same
// sample were the same school written two ways.
//
// So a resolved record is NOT proof it belongs to this project. Every returned
// estimate/invoice is tagged `customerMatch` and anything suspect is excluded
// from the roll-up totals — better an em dash than another client's money
// quoted as fact on this job.
//
// Comparison is deliberately loose: org names differ harmlessly between systems
// ("Greece Athena M.S./H.S." vs "Greece Athena High School"), so we strip
// punctuation and accept either name containing the other, plus a shared
// distinctive-word test for cases like "Camp Wabasso" / "4-H Camp Wabasso".
const STOP_WORDS = new Set(['the', 'of', 'and', 'inc', 'llc', 'school', 'schools', 'high', 'middle',
  'elementary', 'center', 'centre', 'college', 'university', 'district', 'camp', 'ymca', 'academy']);
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function customerMatches(qboCustomer, projectOrg) {
  const a = normName(qboCustomer), b = normName(projectOrg);
  if (!a || !b) return null;                       // nothing to compare against
  const ca = a.replace(/ /g, ''), cb = b.replace(/ /g, '');
  if (ca.includes(cb) || cb.includes(ca)) return true;
  // Fall back to a shared distinctive word (ignoring generic org vocabulary).
  const wordsA = new Set(a.split(' ').filter(w => w.length > 3 && !STOP_WORDS.has(w)));
  const wordsB = a === b ? wordsA : new Set(b.split(' ').filter(w => w.length > 3 && !STOP_WORDS.has(w)));
  for (const w of wordsA) if (wordsB.has(w)) return true;
  return false;
}

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

// Payments applied to a set of invoices.
//
// A QBO Payment can settle several invoices at once — often across different
// projects — so `TotalAmt` is NOT what this project received. Each payment Line
// carries its own amount and the invoice it was applied to, so we sum only the
// lines pointing at these invoices. Showing TotalAmt here would overstate a
// project whenever a client paid for two jobs on one cheque.
function slimPayment(p, invoiceIds) {
  const applied = (p.Line || []).reduce((t, ln) => {
    const hits = (ln.LinkedTxn || []).some(lt => lt.TxnType === 'Invoice' && invoiceIds.has(String(lt.TxnId)));
    return hits ? t + n(ln.Amount) : t;
  }, 0);
  return {
    qboId: p.Id,
    date: p.TxnDate || '',
    method: p.PaymentMethodRef?.name || '',
    reference: p.PaymentRefNum || '',
    amount: Math.round(applied * 100) / 100,   // applied to THIS project
    paymentTotal: n(p.TotalAmt),               // the whole payment, for context
  };
}

async function fetchPayments(rawInvoices) {
  const invoiceIds = new Set(rawInvoices.map(i => String(i.Id)));
  const paymentIds = new Set();
  for (const inv of rawInvoices) {
    for (const lt of inv.LinkedTxn || []) {
      if (lt.TxnType === 'Payment' && lt.TxnId) paymentIds.add(String(lt.TxnId));
    }
  }
  if (!paymentIds.size) return [];
  const list = [...paymentIds].map(v => `'${v}'`).join(',');
  const q = await qboQuery(`SELECT * FROM Payment WHERE Id IN (${list})`).catch(() => ({}));
  return (q.Payment || [])
    .map(p => slimPayment(p, invoiceIds))
    .filter(p => p.amount > 0)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
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
// Returns { raw, invoices } — `raw` keeps the QBO objects so linked payments
// can be resolved from their LinkedTxn without a second round trip.
async function fetchInvoices(refs) {
  if (!refs.length) return { raw: [], invoices: [] };
  const quote = list => list.map(v => `'${v}'`).join(',');

  const byDoc = await qboQuery(`SELECT * FROM Invoice WHERE DocNumber IN (${quote(refs)})`).catch(() => ({}));
  const raw = [...(byDoc.Invoice || [])];
  const resolved = new Set(raw.map(i => i.DocNumber));

  const unresolved = refs.filter(r => !resolved.has(r));
  if (unresolved.length) {
    const byId = await qboQuery(`SELECT * FROM Invoice WHERE Id IN (${quote(unresolved)})`).catch(() => ({}));
    for (const inv of byId.Invoice || []) {
      if (!raw.some(f => f.Id === inv.Id)) raw.push(inv);
    }
  }
  return { raw, invoices: raw.map(slimInvoice) };
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
    const [ordered, invResult] = await Promise.all([
      (async () => {
        if (!docs.length) return [];
        const inList = docs.map(d => `'${d}'`).join(',');
        const qr = await qboQuery(`SELECT * FROM Estimate WHERE DocNumber IN (${inList})`);
        const estimates = (qr.Estimate || []).map(slim);
        // A D# is NOT unique in QBO. The sequence has been reused over the
        // years, so a single "D-4281" can be several unrelated estimates a
        // decade apart — which is how a 2026 project ends up showing a 2015
        // estimate for a different customer. Keep only the most recent by
        // TxnDate; a higher QBO Id breaks a tie, and an undated record loses
        // to a dated one. (This was Object.fromEntries, which kept whichever
        // row QBO happened to return last — arbitrary, not newest.)
        const byDoc = {};
        for (const e of estimates) {
          const prev = byDoc[e.docNumber];
          const newer = !prev
            || e.date > prev.date
            || (e.date === prev.date && Number(e.qboId) > Number(prev.qboId));
          if (newer) byDoc[e.docNumber] = e;
        }
        // Preserve the record's D# order; flag any that didn't resolve in QBO.
        return docs.map(d => byDoc[d] || { docNumber: d, missing: true });
      })(),
      fetchInvoices(invoiceRefs),
    ]);
    const { raw: rawInvoices, invoices: rawSlimInvoices } = invResult;
    // Payments hang off the invoices, so this can only run once they're known.
    const payments = await fetchPayments(rawInvoices);

    // Tag every resolved record with whether its QBO customer actually matches
    // this project. `null` = couldn't compare (a name was missing) — treated as
    // trusted, since refusing to show a figure over absent metadata would be
    // worse than showing it.
    const tag = r => (r.missing ? r : { ...r, customerMatch: customerMatches(r.customer, org) });
    const estimates = ordered.map(tag);
    const invoices = rawSlimInvoices.map(tag);

    const trusted = r => !r.missing && r.customerMatch !== false;
    const goodEstimates = estimates.filter(trusted);
    const goodInvoices = invoices.filter(trusted);
    const mismatched = {
      estimates: estimates.filter(e => e.customerMatch === false).length,
      invoices: invoices.filter(i => i.customerMatch === false).length,
    };

    // Roll up from TRUSTED records only. A reference pointing at another
    // client's record must not contribute to this project's money — better an
    // em dash than a confident wrong total. null = nothing usable linked.
    const sum = (arr, k) => arr.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    const estimated = goodEstimates.length ? sum(goodEstimates, 'total') : null;
    const invoiced = goodInvoices.length ? sum(goodInvoices, 'total') : null;
    const totals = {
      estimated: estimated ?? invoiced,
      invoiced,
      received: goodInvoices.length ? sum(goodInvoices, 'paid') : null,
      balanceDue: goodInvoices.length ? sum(goodInvoices, 'balance') : null,
    };

    return res.status(200).json({
      org, docs, estimates, invoiceRefs, invoices, payments, totals, mismatched,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 400) });
  }
}
