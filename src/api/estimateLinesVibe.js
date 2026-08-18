import { getCurrentEnv } from '../config/fmpEnvironments';

// Estimate line items, against Vibe — PHASE B1. Replaces src/api/estimateLines.js.
//
// What changes for a caller, and why it matters:
//
//   - Lines are keyed by the estimate's own `_kpt__Estimate_ID`, not FileMaker's
//     recordId. Every other Vibe store already keys on the business id, and a
//     recordId is a FileMaker internal that dies with it.
//   - **There is no recalcTotals.** The old module had to call a FileMaker
//     script after EVERY line change, because the stored totals rejected direct
//     writes with `201 Field cannot be modified`. Totals now come back with every
//     response, computed from the lines, so they cannot go stale — which they
//     already had on roughly 3% of production estimates, by amounts like +$50.00
//     and -$406.00 (docs/b1-estimate-lines-scope.md).
//   - Amount is recomputed server-side from quantity x unit price on every
//     write, so changing either one cannot leave a stale Amount behind.
//
// The pure helpers below are kept identical to the FileMaker-era module so the
// components that import them do not change.

const qs = estimateId =>
  `db=${encodeURIComponent(getCurrentEnv().db)}&estimateId=${encodeURIComponent(estimateId)}`;

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const post = (estimateId, payload) =>
  fetch(`/api/estimate-lines?${qs(estimateId)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(json);

// ── Pure helpers, unchanged from the FileMaker-era module ────────────────────

export const money = v => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** quantity x unit price, to cents. Blank quantity counts as 1 — that is how the
 *  existing data reads (Amount === Unit_Price on qty-less rows). */
export const lineAmount = line => {
  const qty = String(line?.Quantity ?? '').trim() === '' ? 1 : money(line.Quantity);
  return Math.round(qty * money(line.Unit_Price) * 100) / 100;
};

export const subtotalOf = lines =>
  Math.round((lines || []).reduce((t, l) => t + lineAmount(l), 0) * 100) / 100;

export const sortLines = lines =>
  [...(lines || [])].sort((a, b) => Number(a.Sort_Order || 0) - Number(b.Sort_Order || 0));

export const nextSortOrder = lines =>
  (lines || []).reduce((m, l) => Math.max(m, Number(l.Sort_Order || 0)), 0) + 1;

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

// A Vibe line is already the shape the UI wants — there is no portal row with
// `estmt_ESTLI::` prefixes to unwrap. Kept as a named identity so the callers
// that mapped portal rows through `toLine` keep reading the same way.
export const toLine = line => ({ ...line, recordId: line?.id });

// ── Reads and writes ─────────────────────────────────────────────────────────

/** One estimate's lines, plus the totals computed from them. */
export async function listLines(estimateId) {
  if (!estimateId) return { lines: [], totals: { subtotal: 0, tax: 0, total: 0 } };
  const body = await json(await fetch(`/api/estimate-lines?${qs(estimateId)}`, { credentials: 'include' }));
  return { lines: (body.lines || []).map(toLine), totals: body.totals };
}

export const addLines = (estimateId, lines) => post(estimateId, { action: 'add', lines });
export const updateLine = (estimateId, lineId, changes) => post(estimateId, { action: 'update', lineId, changes });
export const deleteLine = (estimateId, lineId) => post(estimateId, { action: 'remove', lineId });
export const replaceLines = (estimateId, lines) => post(estimateId, { action: 'replace', lines });
