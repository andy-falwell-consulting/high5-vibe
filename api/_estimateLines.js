// Estimate line items — the rows that make up an estimate's total.
// Files starting with _ are not Vercel routes.
//
//   vibe:{db}:estli   estimateId → [ { id, Item_Name, Unit_Price, … }, … ]
//
// PHASE B1 of docs/decoupling-plan.md. Shaped deliberately like
// _inspectionLines.js — one hash field per PARENT, not per line, and not on the
// record's Vibe fragment. The reason is the same and is about the read path,
// not size: `readOverlay` in _vibeStore.js does an HGETALL of the whole overlay
// hash on every records page, so putting line items there would pull every
// estimate's lines on every read. Here they come back with a single HGET when
// an estimate is opened, and never in bulk.
//
// Keyed by the estimate's own `_kpt__Estimate_ID`, not FileMaker's recordId —
// recordIds are FileMaker internals that die with it, and every other Vibe
// store already keys on the business id.
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export const linesKey = db => `vibe:${db}:estli`;

// The fields this app owns on a line.
//
// `Amount` is stored rather than derived, because FileMaker's own rows store it
// and the two must agree for a migrated line and a new one to be
// indistinguishable. It is still COMPUTED on write (see lineAmount) rather than
// trusted from input — FileMaker never computed it on API writes either, which
// is why src/api/estimateLines.js has always written it explicitly.
//
// `Taxable` is carried even though it is set on 0 of 263 sampled production
// lines. Dropping it would bake "we never charge tax" into the data model; see
// the totals note below.
export const LINE_FIELDS = ['Item_Name', 'Description', 'Quantity', 'Unit_Price', 'Amount', 'Taxable', 'Sort_Order'];

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

export const money = v => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** quantity x unit price, to cents. A blank quantity counts as 1 — that is how
 *  the existing data reads (Amount === Unit_Price on qty-less rows). Same rule
 *  as the FileMaker-era helper it replaces, kept identical on purpose. */
export const lineAmount = line => {
  const qty = String(line?.Quantity ?? '').trim() === '' ? 1 : money(line.Quantity);
  return Math.round(qty * money(line.Unit_Price) * 100) / 100;
};

// The totals FileMaker's `ESTMT__Trigger__Sum_Line_Items - API` script used to
// maintain, computed here instead.
//
// Measured across all 2,818 production estimates before writing this: tax is 0
// on every one, no sampled line has Taxable set, and Total = Subtotal + Tax
// with zero exceptions (docs/b1-estimate-lines-scope.md).
//
// So `taxRate` defaults to 0 and every existing estimate totals identically to
// its stored value. It is a PARAMETER rather than a hard-coded zero on purpose:
// `Taxable` is a live checkbox in FileMaker that nobody has yet ticked, and
// hard-coding the zero would silently under-charge the first estimate that
// needs tax. Arriving at 0 by arithmetic stays correct on the day that changes.
// No rate is stored anywhere in the file — it has to be supplied.
// A subtotal MARKER row is a display artefact, not a line to be added up —
// counting one would double the amounts above it. FileMaker has the concept
// (`zz__Is_Subtotal__cn` on est_li_vibe_2) but it is set on 0 of 234 sampled
// production lines, so none exist today. Excluded anyway: the cost is one
// filter, and the failure it prevents is an estimate whose total silently
// doubles.
const isSubtotalRow = l => Number(l?.Is_Subtotal) === 1;

export function totalsFor(lines, { taxRate = 0 } = {}) {
  const real = (lines || []).filter(l => !isSubtotalRow(l));
  const subtotal = real.reduce((a, l) => a + money(l.Amount), 0);
  const taxable = real.reduce(
    (a, l) => a + (Number(l.Taxable) ? money(l.Amount) : 0), 0);
  const tax = Math.round(taxable * taxRate * 100) / 100;
  const round = n => Math.round(n * 100) / 100;
  return { subtotal: round(subtotal), tax: round(tax), total: round(subtotal + tax) };
}

export async function readLines(db, estimateId) {
  const v = await redis.hget(linesKey(db), String(estimateId));
  const arr = parse(v);
  return Array.isArray(arr) ? arr : [];
}

// An emptied estimate stores `[]` rather than deleting its field.
//
// Deleting would make "every line was removed" indistinguishable from "never
// migrated", and the two must behave differently: an un-migrated estimate falls
// back to FileMaker's portal rows, while an emptied one must show nothing. If
// they were conflated, deleting the last line would make all the old lines
// reappear. `linesExist` is what the read path asks.
export async function writeLines(db, estimateId, lines) {
  await redis.hset(linesKey(db), { [String(estimateId)]: JSON.stringify(lines) });
  return lines;
}

/** Whether this estimate has a Vibe record at all — migrated, or edited here. */
export async function linesExist(db, estimateId) {
  return (await redis.hexists(linesKey(db), String(estimateId))) === 1;
}

// Lines added in Vibe get a VE- id — a bare number came from FileMaker, anything
// prefixed is ours. (Inspection lines use VL-; keeping them distinct means an id
// alone says which store it belongs to.)
export async function nextLineId(db) {
  const n = await redis.incr(`vibe:${db}:seq:estli`);
  return `VE-${100000 + n}`;
}

// Only the owned fields, only ones with a value, with Amount recomputed rather
// than trusted — so a migrated line and a newly added one are the same shape.
export function cleanLine(input, id) {
  const out = { id };
  for (const f of LINE_FIELDS) {
    const v = input?.[f];
    if (v !== undefined && v !== null && String(v) !== '') out[f] = v;
  }
  const amt = lineAmount(out);
  if (amt) out.Amount = amt;
  return out;
}

// The portal returns rows in DESCENDING Sort_Order, so anything rendering them
// raw shows the estimate backwards. Kept from the FileMaker-era helper.
export const sortLines = lines =>
  [...(lines || [])].sort((a, b) => Number(a.Sort_Order || 0) - Number(b.Sort_Order || 0));
