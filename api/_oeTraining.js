// OE training — the workshops a contact has attended.
// Files starting with _ are not Vercel routes.
//
//   vibe:{db}:oetrn   contactId → [ { id, courseName, startDate, … }, … ]
//
// PHASE B3. Same shape as the other three child stores: one hash field per
// PARENT contact, not per row, and not on the record's Vibe fragment — because
// `readOverlay` HGETALLs the whole overlay on every records page.
//
// Keyed by `_kft__Contact_ID`, which is the contact's own id and the same value
// Vibe's contact model uses.
//
// WHAT IS STORED, and why it is the whole row rather than the five fields the
// OE Training tab renders: `Workshops_New` is not a training log. It carries
// tuition, food and lodging fees, deposits, balance due, QuickBooks invoice AND
// estimate ids, and a Shopify order id — financial history, in a database being
// retired. Migrating only what the tab displays would quietly lose the rest at
// cutover. At 5,217 rows carrying it costs nothing.
//
// The `wkshp_cntct_*::` related fields are deliberately NOT stored. They belong
// to the contact, not the workshop, and a copy here would go stale the moment
// the contact changed — the same call made for BOM component names and for
// estimate line item names.
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export const oeKey = db => `vibe:${db}:oetrn`;

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const s = v => String(v ?? '').trim();
const n = v => { const x = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(x) ? x : 0; };

/** One FileMaker Workshops_New row → the shape Vibe stores. */
export function toWorkshop(f = {}, fallbackId) {
  const row = {
    id: s(f._kpt__Workshop_ID) || String(fallbackId),
    contactId: s(f._kft__Contact_ID),
    courseName: s(f['Course Name']) || s(f.course_name),
    // Course numbers carry stray carriage returns in the data ("MAP-1301\r").
    courseNumber: s(f['Course Number']).replace(/[\r\n]+/g, ''),
    startDate: s(f['Start Date']), endDate: s(f['End Date']),
    startTime: s(f['Start Time']), endTime: s(f['End Time']),
    hours: s(f['# Hours']),
    instructor: s(f.Instructor),
    status: s(f.Status),
    site: s(f['custom site']) || s(f.Typed_Site),
    // A snapshot of the organization as the workshop recorded it. Kept because
    // it is what the tab shows and it is historically accurate — the contact may
    // since have moved organizations, and a 2013 workshop belongs to whoever ran
    // it then.
    organization: s(f.zz__Display_Organization__ct),
    contactName: s(f.zz__Display_Contact__ct),
    notes: s(f.Notes).replace(/[\r\n]+$/, ''),
  };
  const money = {
    tuitionFee: n(f['Tuition Fee']), foodFee: n(f['Food Fee']),
    lodgingFee: n(f['Lodging Fee']), extraLodgingFee: n(f['Extra Lodging Fee']),
    feeTotal: n(f['Fee Total']), depositDue: n(f['Deposit Due']),
    depositReceived: n(f["Deposit Rec'vd"]), balanceDue: n(f['Balance Due']),
  };
  for (const [k, v] of Object.entries(money)) if (v) row[k] = v;

  const refs = {
    poNumber: s(f['PO #']), checkNumber: s(f['Check Number']),
    qboInvoiceId: s(f._kat__QuickBooks_Invoice_ID),
    qboEstimateId: s(f._kat__QuickBooks_Estimate_ID),
    shopifyOrderId: s(f.shopify_order_id),
    invoiceSent: s(f['Invoice Sent']), confirmationSent: s(f.Confirmation_Email_DTS),
  };
  for (const [k, v] of Object.entries(refs)) if (v) row[k] = v;

  return row;
}

/** Most recent first — a contact's training history reads backwards. */
export const sortWorkshops = rows => [...(rows || [])].sort((a, b) => {
  const d = x => { const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(x?.startDate || ''); return m ? `${m[3]}${m[1]}${m[2]}` : ''; };
  return d(b).localeCompare(d(a));
});

export async function readWorkshops(db, contactId) {
  const v = await redis.hget(oeKey(db), String(contactId));
  const arr = parse(v);
  return Array.isArray(arr) ? arr : [];
}

export async function writeWorkshops(db, contactId, rows) {
  await redis.hset(oeKey(db), { [String(contactId)]: JSON.stringify(rows) });
  return rows;
}
