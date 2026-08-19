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

// The ORIGINAL store: one field per contact, holding that contact's whole array
// of workshops. Built for the OE Training tab on a contact record, where reading
// by contact is the only access pattern there is.
//
// Kept as a read fallback during the changeover and nowhere near the write path.
export const oeKey = db => `vibe:${db}:oetrn`;

// The NORMALISED store — one row, two indexes.
//
// The contact-keyed shape cannot serve a session page: showing the roster for
// one course means pulling all 2,689 contact buckets and regrouping, on every
// load. Storing the row twice instead — once per contact, once per course —
// would let the two copies drift, and the failure mode is a roster that
// disagrees with the contact's own tab about who is on a course.
//
// So the row lives in exactly ONE place and the indexes hold ids only.
export const recKey = db => `vibe:${db}:oetrn:rec`;         // workshopId -> row
export const byContactKey = db => `vibe:${db}:oetrn:bycontact`; // contactId -> [workshopId]
export const byCourseKey = db => `vibe:${db}:oetrn:bycourse`;   // courseKey -> [workshopId]

/** Course numbers carry stray carriage returns and inconsistent case in the
 *  real data ("MAP-1301\r", "sym-2012"). Index on a normalised form so a
 *  session's roster is not split across three spellings of its own code. */
export const courseKey = v => String(v ?? '').replace(/[\r\n]+/g, '').trim().toUpperCase();

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

/** Rows for a list of workshop ids, in the order given. */
export async function readByIds(db, ids) {
  const list = (ids || []).map(String).filter(Boolean);
  if (!list.length) return [];
  const raw = await redis.hmget(recKey(db), ...list);
  // hmget returns an object keyed by field when given many fields on this
  // client, and an array on others — handle both rather than assume.
  const pick = Array.isArray(raw)
    ? i => raw[i]
    : i => raw?.[list[i]];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const row = parse(pick(i));
    if (row) out.push(row);
  }
  return out;
}

async function idsFrom(db, key, field) {
  const v = parse(await redis.hget(key, String(field)));
  return Array.isArray(v) ? v : null;
}

/** One contact's workshops.
 *
 *  Reads the normalised store, and falls back to the original contact-keyed
 *  hash for as long as that is the only place a given contact's rows exist.
 *  That fallback is what lets the rebuild happen without a flag day — the tab
 *  keeps working whether or not the rebuild has run. Delete it once the rebuild
 *  is confirmed. */
export async function readWorkshops(db, contactId) {
  const ids = await idsFrom(db, byContactKey(db), contactId);
  if (ids) return readByIds(db, ids);
  const legacy = parse(await redis.hget(oeKey(db), String(contactId)));
  return Array.isArray(legacy) ? legacy : [];
}

/** One course session's roster. Has no legacy fallback by design — the old
 *  store cannot answer this question at all, which is why this exists. */
export async function readCourse(db, course) {
  const ids = await idsFrom(db, byCourseKey(db), courseKey(course));
  return ids ? readByIds(db, ids) : [];
}

/** Every course session Vibe holds registrations for, with its roster size.
 *  One HGETALL over an index of ids — the rows themselves are not read. */
export async function listCourses(db) {
  const all = await redis.hgetall(byCourseKey(db));
  const out = [];
  for (const [course, raw] of Object.entries(all || {})) {
    const ids = parse(raw);
    if (Array.isArray(ids) && ids.length) out.push({ course, count: ids.length });
  }
  return out.sort((a, b) => b.course.localeCompare(a.course));
}

/** Write one row and keep both indexes in step.
 *
 *  Read-modify-write on the index rather than a blind append, so re-writing a
 *  row that is already indexed does not duplicate its id. */
export async function writeWorkshop(db, row) {
  const id = String(row?.id ?? '').trim();
  if (!id) throw new Error('workshop row has no id');
  await redis.hset(recKey(db), { [id]: JSON.stringify(row) });

  const addTo = async (key, field) => {
    if (!field) return;
    const ids = (await idsFrom(db, key, field)) || [];
    if (!ids.includes(id)) await redis.hset(key, { [String(field)]: JSON.stringify([...ids, id]) });
  };
  await addTo(byContactKey(db), row.contactId);
  await addTo(byCourseKey(db), courseKey(row.courseNumber));
  return row;
}

/** Replace a contact's whole set — kept for the migration's finish step, which
 *  writes a contact at a time. */
export async function writeWorkshops(db, contactId, rows) {
  for (const r of rows || []) await writeWorkshop(db, { ...r, contactId: String(contactId) });
  return rows;
}
