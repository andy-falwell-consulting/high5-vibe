// Bill-of-materials lines — the components that make up an assembly product.
// Files starting with _ are not Vercel routes.
//
//   vibe:{db}:bom   parentItemId → [ { id, componentItemId, quantity }, … ]
//
// PHASE B2. Same shape as _inspectionLines.js and _estimateLines.js: one hash
// field per PARENT, not per line, and not on the record's Vibe fragment —
// `readOverlay` HGETALLs the whole overlay on every records page, so lines
// living there would be pulled on every read.
//
// Keyed by the product's own `_kpt__Item_ID`.
//
// A line stores the COMPONENT'S ID, not its name or price. FileMaker's portal
// carried `item_itmli_ITEM__billOfMaterials::Name` and `::Unit_Price` as related
// fields, but those belong to the component product and the app already holds
// every product in its cache — snapshotting them here would create a second
// copy that goes stale the moment a price changes. The UI already computes the
// line total live from unit price x quantity and ignores the stored `::Total`,
// so this follows what it was doing anyway.
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export const bomKey = db => `vibe:${db}:bom`;

export const LINE_FIELDS = ['componentItemId', 'quantity'];

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

export const num = v => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

export async function readLines(db, parentItemId) {
  const v = await redis.hget(bomKey(db), String(parentItemId));
  const arr = parse(v);
  return Array.isArray(arr) ? arr : [];
}

/** Stores `[]` rather than deleting, so "every component removed" stays
 *  distinguishable from "never migrated" — the same trap B1 hit, where
 *  conflating them made deleting the last line resurrect the portal's rows. */
export async function writeLines(db, parentItemId, lines) {
  await redis.hset(bomKey(db), { [String(parentItemId)]: JSON.stringify(lines) });
  return lines;
}

/** Remove Vibe's copy entirely, so the product falls back to FileMaker. */
export async function dropLines(db, parentItemId) {
  return (await redis.hdel(bomKey(db), String(parentItemId))) > 0;
}

export async function linesExist(db, parentItemId) {
  return (await redis.hexists(bomKey(db), String(parentItemId))) === 1;
}

// Components added in Vibe get a VB- id — a bare number came from FileMaker,
// anything prefixed is ours. (VL- is inspection lines, VE- estimate lines.)
export async function nextLineId(db) {
  const n = await redis.incr(`vibe:${db}:seq:bom`);
  return `VB-${100000 + n}`;
}

export function cleanLine(input, id) {
  const out = { id, componentItemId: String(input?.componentItemId ?? '').trim() };
  const q = num(input?.quantity);
  if (q) out.quantity = q;
  return out;
}
