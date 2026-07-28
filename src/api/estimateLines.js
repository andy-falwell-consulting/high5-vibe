// Estimate line items — the `estmt_ESTLI` portal on Estimates_New.
//
// Verified against the live file (2026-07-28). Three things about this portal
// are not obvious from the code and cost real time to establish:
//
//  1. `Amount` is NOT computed on API writes. FileMaker fills it from a script
//     trigger that only fires on human entry in FMP Pro, so we compute
//     quantity x unit price ourselves and write it explicitly. (It also writes
//     to `Total_Input`, which existing rows keep equal to Amount.)
//  2. The parent totals — `zz__Subtotal__xn`, `zz__Tax__xn`, `zz__Total__xn` —
//     reject direct writes with `201 Field cannot be modified`. The only way to
//     correct them is the RECALC_SCRIPT below, run attached to a record
//     request. The standalone /script/ endpoint runs with no record context and
//     silently does nothing, whatever parameter you pass.
//  3. The portal returns rows in DESCENDING Sort_Order, so anything rendering
//     them raw shows the estimate backwards. sortLines() fixes that.
import {
  addPortalRows, updatePortalRow, deletePortalRow, getRecord, getRecordWithScript,
} from './filemaker';

export const LAYOUT = 'Estimates_New';
export const PORTAL = 'estmt_ESTLI';
export const RECALC_SCRIPT = 'ESTMT__Trigger__Sum_Line_Items - API';

// Fields we own on a line. `Taxable`, `Markup` and the zz__ display calcs are
// left alone — nothing in this app sets them.
const FIELDS = ['Item_Name', 'Description', 'Quantity', 'Unit_Price', 'Amount', 'Total_Input', 'Sort_Order'];
const q = f => `${PORTAL}::${f}`;

export const money = v => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** quantity x unit price, rounded to cents. Blank quantity counts as 1 — that's
 *  how the existing data reads (Amount === Unit_Price on qty-less rows). */
export const lineAmount = line => {
  const qty = String(line.Quantity ?? '').trim() === '' ? 1 : money(line.Quantity);
  return Math.round(qty * money(line.Unit_Price) * 100) / 100;
};

/** Portal row -> plain object. */
export function toLine(row) {
  const out = { recordId: row.recordId };
  for (const f of FIELDS) out[f] = row[q(f)] ?? '';
  return out;
}

/** Plain object -> portal payload, with Amount/Total_Input derived. */
export function toRow(line) {
  const amount = lineAmount(line);
  const out = { [q('Amount')]: amount, [q('Total_Input')]: amount };
  for (const f of ['Item_Name', 'Description', 'Quantity', 'Unit_Price', 'Sort_Order']) {
    const v = line[f];
    if (v !== undefined && v !== null && v !== '') out[q(f)] = v;
  }
  return out;
}

/** Ascending Sort_Order — the portal hands them back descending. */
export function sortLines(lines) {
  return [...lines].sort((a, b) => (money(a.Sort_Order) || 0) - (money(b.Sort_Order) || 0));
}

/** Sum of the lines as shown, for the live total next to the stored one. */
export const subtotalOf = lines => Math.round(lines.reduce((t, l) => t + lineAmount(l), 0) * 100) / 100;

/** Next Sort_Order for an appended line. */
export const nextSortOrder = lines =>
  lines.reduce((max, l) => Math.max(max, money(l.Sort_Order) || 0), 0) + 1;

const ok = res => {
  const m = res?.messages?.[0];
  if (m && m.code !== '0') throw new Error(m.message || 'FileMaker write failed');
  return res;
};

export async function listLines(recordId) {
  const d = await getRecord(LAYOUT, recordId);
  return sortLines((d?.response?.data?.[0]?.portalData?.[PORTAL] || []).map(toLine));
}

export async function addLines(recordId, lines) {
  const rows = lines.map(toRow);
  if (!rows.length) return 0;
  ok(await addPortalRows(LAYOUT, recordId, PORTAL, rows));
  return rows.length;
}

export async function updateLine(recordId, lineRecordId, line) {
  return ok(await updatePortalRow(LAYOUT, recordId, PORTAL, lineRecordId, toRow(line)));
}

export async function deleteLine(recordId, lineRecordId) {
  return ok(await deletePortalRow(LAYOUT, recordId, PORTAL, lineRecordId));
}

/**
 * Recalculate the stored totals and return the refreshed record.
 * Must be called after ANY line change, or the estimate keeps a stale total —
 * and that total is what prints, syncs to QuickBooks, and gets quoted from.
 * Throws on a non-zero scriptError so a silent failure can't slip past.
 */
export async function recalcTotals(recordId) {
  const { data, scriptError } = await getRecordWithScript(LAYOUT, recordId, RECALC_SCRIPT);
  if (scriptError && scriptError !== '0') {
    throw new Error(`Totals could not be recalculated (FileMaker script error ${scriptError}). The lines saved, but the estimate total is now out of date.`);
  }
  return data?.response?.data?.[0] || null;
}

/** Build a line from a Products & Services record, at catalog price. */
export function lineFromProduct(product, quantity = 1, sortOrder = 1) {
  const f = product?.fieldData || {};
  return {
    Item_Name: f.Name || '',
    Description: f.Description || '',
    Quantity: quantity,
    Unit_Price: money(f.Unit_Price),
    Sort_Order: sortOrder,
  };
}
