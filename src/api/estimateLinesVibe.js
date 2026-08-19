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

// A FileMaker portal row -> the shape the UI wants.
//
// The ONLY thing kept from the FileMaker-era module, and only because an
// estimate the migration never reached still renders from its portal rows —
// which is every estimate in an environment where `est_li_vibe_2` does not
// exist. Reading, never writing.
const PORTAL_FIELDS = ['Item_Name', 'Description', 'Quantity', 'Unit_Price', 'Amount', 'Total_Input', 'Sort_Order'];
export function portalRowToLine(row) {
  const out = { recordId: row.recordId };
  for (const f of PORTAL_FIELDS) out[f] = row[`estmt_ESTLI::${f}`] ?? '';
  return out;
}

// A Vibe line is already the shape the UI wants — there is no portal row with
// `estmt_ESTLI::` prefixes to unwrap. Kept as a named identity so the callers
// that mapped portal rows through `toLine` keep reading the same way.
export const toLine = line => ({ ...line, recordId: line?.id });

// ── Reads and writes ─────────────────────────────────────────────────────────

/** One estimate's lines, the totals computed from them, and whether Vibe has
 *  ever seen this estimate.
 *
 *  `migrated: false` means fall back to FileMaker's portal rows — the migration
 *  reads a layout that exists only in Production, so a Dev estimate has no Vibe
 *  lines and never will. An estimate whose lines were all DELETED still reports
 *  `migrated: true` with an empty array, so removing the last line does not make
 *  the old ones reappear from the portal. */
export async function listLines(estimateId) {
  const empty = { lines: [], totals: { subtotal: 0, tax: 0, total: 0 }, migrated: false };
  if (!estimateId) return empty;
  try {
    const body = await json(await fetch(`/api/estimate-lines?${qs(estimateId)}`, { credentials: 'include' }));
    return { lines: (body.lines || []).map(toLine), totals: body.totals, migrated: !!body.migrated };
  } catch {
    // A failed read must not look like an emptied estimate — fall back.
    return empty;
  }
}

/** Seed Vibe from FileMaker's portal rows, for an estimate the migration never
 *  reached. Called on the first WRITE to such an estimate: without it, editing
 *  one line would create a Vibe record holding only that line and silently drop
 *  the rest. */
export const seedFromPortal = (estimateId, lines) => replaceLines(estimateId, lines);

/** Every estimate's computed total, keyed by `_kpt__Estimate_ID`.
 *  One call for the whole list — see the endpoint for why. */
export async function allTotals() {
  try {
    const body = await json(await fetch(
      `/api/estimate-lines?db=${encodeURIComponent(getCurrentEnv().db)}&totals=1`, { credentials: 'include' }));
    return body.totals || {};
  } catch { return {}; }
}

export const addLines = (estimateId, lines) => post(estimateId, { action: 'add', lines });
export const updateLine = (estimateId, lineId, changes) => post(estimateId, { action: 'update', lineId, changes });
export const deleteLine = (estimateId, lineId) => post(estimateId, { action: 'remove', lineId });
export const replaceLines = (estimateId, lines) => post(estimateId, { action: 'replace', lines });
