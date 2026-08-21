// Inspection line items, backed by Vibe's own store (api/_inspectionLines.js).
//
// NOT YET IN USE. Inspections.jsx still calls inspectionLines.js, which writes
// FileMaker portals. This sits alongside it deliberately: the two take
// different parent identifiers — a FileMaker recordId there, the inspection's
// own _kpt__Inspection_ID here — so quietly swapping the implementation behind
// the same exports would have written every line under a bogus key rather than
// failing. The swap is its own change, once the migration has run and there is
// something to read.
//
// The exported surface is unchanged on purpose — `listLines`, `addLines`,
// `updateLine`, `deleteLine`, `copyLines` take and return the same shapes — so
// Inspections.jsx did not have to be rewritten around a new data layer.
//
// Two things change underneath:
//   - A line is addressed by its own id, not a FileMaker portal recordId, and
//     an inspection is addressed by its _kpt__Inspection_ID rather than
//     FileMaker's recordId. Both are FileMaker's values where they came from
//     FileMaker, so nothing was renumbered.
//   - The 101 "Record is missing" trap is gone. Portal writes failed when the
//     parent had no _kpt__Inspection_ID yet, which is why copying required
//     create → read back the id → write lines. Here the id IS the key, so
//     there is nothing to read back.
import { getCurrentEnv } from '../config/fmpEnvironments';
import { CATEGORIES, categoryRank } from '../config/inspectionCopy';
import { pinnedByInspectionId } from './offlineStore';

export const LAYOUT = 'Inspections_New';
export const PORTAL = 'inspt_INSPLI';   // kept: the report still reads portalData for legacy records
export const PORTAL_LIMIT = 2000;

export { CATEGORIES, ELEMENT_GRADES, EQUIPMENT } from '../config/inspectionCopy';

// The line fields this app owns. `ITEM::Name` also appears in the portal but
// belongs to a different table occurrence (a related item record), so it is
// read-only here and deliberately not copied.
export const LINE_FIELDS = ['Description', 'Quantity', 'Equipment', 'Element_Grade', 'Category', 'Flag_Checkbox'];

/** Stored line -> the shape the UI has always used. */
export function toLine(row) {
  const out = { recordId: row.id, itemName: row.itemName || '' };
  for (const f of LINE_FIELDS) out[f] = row[f] ?? '';
  return out;
}

/** UI line -> stored shape (only the fields we own, only ones with a value). */
export function toRow(line) {
  const out = {};
  for (const f of LINE_FIELDS) {
    const v = line[f];
    if (v !== undefined && v !== null && v !== '') out[f] = v;
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

const qs = id => `db=${encodeURIComponent(getCurrentEnv().db)}&inspectionId=${encodeURIComponent(id)}`;

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const post = (inspectionId, payload) =>
  fetch(`/api/inspection-lines?${qs(inspectionId)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(json);

/**
 * Read one inspection's lines, falling back to the offline copy.
 *
 * The fallback is not a nicety. Without it an inspection taken offline opens in
 * the field showing its header and the words "No line items" — which is not
 * "we couldn't load them", it is a positive claim that the course has nothing
 * on it. A 44-row inspection reading as empty is the worst possible failure
 * here, so a network error consults what "Take offline" downloaded before it
 * reports anything at all.
 */
export async function listLines(inspectionId) {
  if (!inspectionId) return [];
  try {
    const body = await json(await fetch(`/api/inspection-lines?${qs(inspectionId)}`, { credentials: 'include' }));
    return (body.lines || []).map(toLine);
  } catch (e) {
    const pin = await pinnedByInspectionId(getCurrentEnv().db, LAYOUT, inspectionId).catch(() => null);
    // Already in UI shape — pinning stores what listLines returned.
    if (pin?.lines) return pin.lines;
    throw e;
  }
}

/**
 * Write an inspection's ENTIRE findings array in one request, keeping ids.
 *
 * This is what an ordinary save uses, online and offline alike. It replaces a
 * loop of per-row add/update/remove calls that made one HTTP request per edited
 * line — 44 sequential round trips on a typical inspection — and, worse, could
 * half-apply: a connection dropped in the middle left an inspection in a state
 * nobody chose and no retry could safely repeat. Sending the whole array is
 * idempotent, so a replayed queue entry cannot double-apply.
 *
 * Rows keep their `recordId` as the stored id. Rows added in a session carry a
 * `new:` key instead, which the server treats as no id and mints a real one
 * for — see the `sync` action in api/inspection-lines.js.
 */
export async function syncLines(inspectionId, lines) {
  const rows = (lines || []).map(l => {
    const row = toRow(l);
    const id = l.recordId ?? l.id;
    return id && !String(id).startsWith('new:') ? { ...row, id: String(id) } : row;
  });
  const body = await post(inspectionId, { action: 'sync', lines: rows });
  return (body.lines || []).map(toLine);
}

// addLines / updateLine / deleteLine are gone, with the save loop that used
// them. They wrote one row per request — 44 sequential round trips on a typical
// inspection — and could half-apply if the connection dropped mid-loop, leaving
// an inspection in a state nobody chose and no retry could safely repeat.
// `syncLines` replaces all three. The endpoint still accepts add/update/remove
// for anything that needs a single row later; nothing does today.

/**
 * Copy every line from one inspection onto another, in canonical category
 * order. Returns the copied lines as read back from the target, so the caller
 * can flag them "carried over" by their new ids.
 *
 * The target no longer has to exist in FileMaker first: the old portal write
 * failed with 101 "Record is missing" until the parent had been created and its
 * id read back, which is why this was a three-step dance.
 */
export async function copyLines(sourceInspectionId, targetInspectionId) {
  const source = await listLines(sourceInspectionId);
  if (!source.length) return [];
  const body = await post(targetInspectionId, { action: 'replace', lines: sortLines(source).map(toRow) });
  return (body.lines || []).map(toLine);
}
