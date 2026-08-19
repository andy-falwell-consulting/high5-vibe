// Invoices — a contact's billing history.
// Files starting with _ are not Vercel routes.
//
//   vibe:{db}:invo   contactId → [ { id, date, total, … }, … ]
//
// PHASE B4. Same shape as the other child stores: one hash field per PARENT
// contact, not per row, and not on the record's Vibe fragment — `readOverlay`
// HGETALLs the whole overlay on every records page.
//
// WHAT THIS IS, AND IS NOT. FileMaker's `Invoices_New` is HISTORICAL. The QBO
// invoice mirror (api/qbo-invoice-sync.js) writes QuickBooks invoices into it,
// and that sync is deferred in production behind QBO_SYNC_ALLOW_PROD — so live
// invoicing happens in QuickBooks and surfaces through the Transactions module.
// This store preserves the 13,140 invoices that would otherwise be lost when
// FileMaker is retired. It is not, and should not become, a live billing view.
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export const invoiceKey = db => `vibe:${db}:invo`;

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const s = v => String(v ?? '').trim();
const n = v => { const x = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(x) ? x : 0; };

/** One FileMaker Invoices_New row → the shape Vibe stores. */
export function toInvoice(f = {}, fallbackId) {
  const row = {
    id: s(f._kpt__Invoice_ID) || String(fallbackId),
    contactId: s(f._kft__Contact_ID),
    date: s(f.Date),
    // A snapshot of who it was billed to, as the invoice recorded it. Kept for
    // the same reason the workshop's organization is: an invoice belongs to
    // whoever it was raised against at the time, not to wherever that contact
    // sits now.
    billedTo: s(f.zz__Display_Contact__ct),
  };
  const money = {
    subtotal: n(f.zz__Subtotal__xn), tax: n(f.zz__Tax__xn), total: n(f.zz__Total__xn),
    taxRate: n(f.Tax_Rate),
  };
  for (const [k, v] of Object.entries(money)) if (v) row[k] = v;

  // `zz__Paid_In_Full__cr` is a FileMaker calc; anything non-empty means paid.
  if (s(f.zz__Paid_In_Full__cr)) row.paidInFull = true;

  const refs = {
    poNumber: s(f.PO_Number), memo: s(f.Memo),
    quickbooksRef: s(f.QuickBooks_Reference_Number),
    customerMessage: s(f.Customer_Message),
  };
  for (const [k, v] of Object.entries(refs)) if (v) row[k] = v;

  return row;
}

/** Most recent first — billing history reads backwards. */
export const sortInvoices = rows => [...(rows || [])].sort((a, b) => {
  const d = x => { const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(x?.date || ''); return m ? `${m[3]}${m[1]}${m[2]}` : ''; };
  return d(b).localeCompare(d(a));
});

export async function readInvoices(db, contactId) {
  const v = await redis.hget(invoiceKey(db), String(contactId));
  const arr = parse(v);
  return Array.isArray(arr) ? arr : [];
}

export async function writeInvoices(db, contactId, rows) {
  await redis.hset(invoiceKey(db), { [String(contactId)]: JSON.stringify(rows) });
  return rows;
}
