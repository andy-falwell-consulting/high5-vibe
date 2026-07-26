// Inspection line items — the findings that make up an inspection report.
// They live in the `inspt_INSPLI` portal on Inspections_New; there is no
// standalone layout for them in this app, so every write goes through the
// parent record's portal.
//
// Verified against the live file (2026-07-26):
//   - many rows can be added in ONE PATCH (addPortalRows)
//   - a row updates by its own recordId, no modId needed
//   - a row deletes via fieldData.deleteRelated using the TABLE OCCURRENCE name
//   - updates fail with 101 "Record is missing" if the parent has no
//     _kpt__Inspection_ID yet, so a copy must create the parent first, read
//     back its ID, and only then write lines.
import { addPortalRows, updatePortalRow, deletePortalRow, getRecordWithPortals } from './filemaker';
import { CATEGORIES, categoryRank } from '../config/inspectionCopy';

export const LAYOUT = 'Inspections_New';
export const PORTAL = 'inspt_INSPLI';
export const PORTAL_LIMIT = 2000;   // the portal default caps at 50

export { CATEGORIES, ELEMENT_GRADES, EQUIPMENT } from '../config/inspectionCopy';

// The line fields this app owns. `ITEM::Name` also appears in the portal but
// belongs to a different table occurrence (a related item record), so it is
// read-only here and deliberately not copied.
export const LINE_FIELDS = ['Description', 'Quantity', 'Equipment', 'Element_Grade', 'Category', 'Flag_Checkbox'];

const q = f => `${PORTAL}::${f}`;

/** Portal row -> plain object keyed by bare field name, plus its recordId. */
export function toLine(row) {
  const out = { recordId: row.recordId, itemName: row['ITEM::Name'] || '' };
  for (const f of LINE_FIELDS) out[f] = row[q(f)] ?? '';
  return out;
}

/** Plain object -> portal row payload (only the fields we own). */
export function toRow(line) {
  const out = {};
  for (const f of LINE_FIELDS) {
    const v = line[f];
    if (v !== undefined && v !== null && v !== '') out[q(f)] = v;
  }
  return out;
}

// Sort by the canonical category order, so screen and PDF group identically.
// Categories not on the value list (historical drift) sort after the known
// ones, alphabetically, rather than being dropped or silently reordered.
export function sortLines(lines) {
  return [...lines].sort((a, b) => {
    const ra = categoryRank(a.Category), rb = categoryRank(b.Category);
    if (ra !== rb) return ra - rb;
    if (ra === CATEGORIES.length) return String(a.Category || '').localeCompare(String(b.Category || ''));
    return 0;   // stable within a category — preserves the order lines were entered
  });
}

/** Group sorted lines into [{ category, lines }] for rendering. */
export function groupByCategory(lines) {
  const out = [];
  for (const l of sortLines(lines)) {
    const c = l.Category || '(uncategorised)';
    if (out.length && out[out.length - 1].category === c) out[out.length - 1].lines.push(l);
    else out.push({ category: c, lines: [l] });
  }
  return out;
}

const ok = res => {
  const m = res?.messages?.[0];
  if (m && m.code !== '0') throw new Error(m.message || 'FileMaker write failed');
  return res;
};

/** Read one inspection's lines (full portal, past the 50-row default). */
export async function listLines(recordId) {
  const d = await getRecordWithPortals(LAYOUT, recordId, { [PORTAL]: PORTAL_LIMIT });
  const rows = d?.response?.data?.[0]?.portalData?.[PORTAL] || [];
  return rows.map(toLine);
}

/** Add lines in a single request. Returns the number written. */
export async function addLines(recordId, lines) {
  const rows = lines.map(toRow).filter(r => Object.keys(r).length);
  if (!rows.length) return 0;
  ok(await addPortalRows(LAYOUT, recordId, PORTAL, rows));
  return rows.length;
}

export async function updateLine(recordId, lineRecordId, changes) {
  return ok(await updatePortalRow(LAYOUT, recordId, PORTAL, lineRecordId, toRow(changes)));
}

export async function deleteLine(recordId, lineRecordId) {
  return ok(await deletePortalRow(LAYOUT, recordId, PORTAL, lineRecordId));
}

/**
 * Copy every line from one inspection onto another, in canonical category
 * order. The target must already exist and have a _kpt__Inspection_ID.
 * Returns the copied lines as read back from the target, so the caller can
 * flag them "carried over" by their new recordIds.
 */
export async function copyLines(sourceRecordId, targetRecordId) {
  const source = await listLines(sourceRecordId);
  if (!source.length) return [];
  await addLines(targetRecordId, sortLines(source));
  return listLines(targetRecordId);
}
