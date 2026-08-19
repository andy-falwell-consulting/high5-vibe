import { getCurrentEnv } from '../config/fmpEnvironments';

// A product's bill of materials, against Vibe — PHASE B2.
//
// Replaces the three FileMaker portal writes in ProductsAndServicesV2.jsx:
// createRecord('Item_ITMLI_billOfMaterials'), updatePortalRow and
// deletePortalRow.
//
// A line is { id, componentItemId, quantity }. It deliberately does NOT carry
// the component's name or price: those belong to the component product, the app
// already holds every product in its cache, and a copy here would go stale the
// moment a price changed. The UI already resolved them live and ignored
// FileMaker's stored ::Total, so nothing is lost.
const qs = itemId =>
  `db=${encodeURIComponent(getCurrentEnv().db)}&itemId=${encodeURIComponent(itemId)}`;

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const post = (itemId, payload) =>
  fetch(`/api/bom-lines?${qs(itemId)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(json);

/** A product's components, plus whether Vibe has ever seen this product.
 *
 *  `migrated: false` means fall back to the FileMaker portal. That is the state
 *  of every product the tail-only migration deliberately skipped (the ten
 *  runaway parents), every product whose BOM rows named no component, and every
 *  product in an environment the migration has not run against. */
export async function listBom(itemId) {
  const empty = { lines: [], migrated: false };
  if (!itemId) return empty;
  try {
    const body = await json(await fetch(`/api/bom-lines?${qs(itemId)}`, { credentials: 'include' }));
    return { lines: body.lines || [], migrated: !!body.migrated };
  } catch {
    // A failed read must not look like an emptied bill of materials.
    return empty;
  }
}

export const addBomLines = (itemId, lines) => post(itemId, { action: 'add', lines });
export const updateBomLine = (itemId, lineId, changes) => post(itemId, { action: 'update', lineId, changes });
export const removeBomLine = (itemId, lineId) => post(itemId, { action: 'remove', lineId });
export const replaceBomLines = (itemId, lines) => post(itemId, { action: 'replace', lines });
