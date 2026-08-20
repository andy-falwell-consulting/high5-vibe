import { getCurrentEnv } from '../config/fmpEnvironments';

// Product drift between Vibe, QuickBooks and Shopify.
// See docs/product-sync-audit.md for what drifts and why.

const qs = extra => `db=${encodeURIComponent(getCurrentEnv().db)}${extra}`;

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

/** The STORED result of the last run. Cheap — does no reconciliation.
 *  Returns `{ last, history, buckets }`; `last` is null before the first run. */
export const getDriftReport = () =>
  fetch(`/api/product-reconcile?${qs('&report=1')}`, { credentials: 'include' }).then(json);

/** Run a fresh reconciliation NOW. Pages FileMaker, QuickBooks and Shopify and
 *  takes up to two minutes — which is why the dashboard reads the stored report
 *  instead, and this is behind a button someone has to press. */
export const runReconcile = () =>
  fetch(`/api/product-reconcile?${qs('')}`, { credentials: 'include' }).then(json);

/** Human labels. The bucket keys are precise and unreadable. */
export const BUCKET_LABEL = {
  qbo_price_drift: 'QuickBooks price differs',
  qbo_name_drift: 'QuickBooks name differs',
  qbo_link_broken: 'QuickBooks link broken',
  shop_price_drift: 'Shopify price differs',
  shop_link_broken: 'Shopify link broken',
  fm_sku_dupe: 'Duplicate SKU in Vibe',
  qbo_sku_dupe: 'Duplicate SKU in QuickBooks',
  shop_sku_dupe: 'Duplicate SKU in Shopify',
  qbo_linkable: 'Matches a QuickBooks item, not linked',
  shop_linkable: 'Matches a Shopify variant, not linked',
};

// ── Fixing ──────────────────────────────────────────────────────────────────
//
// Both actions run through the SAME endpoints the per-product sync buttons
// already use — /api/qbo, /api/shopify, and updateVibeRecord. Deliberately no
// new server-side sync machinery: those paths are proven and idempotent, and a
// second way to write to QuickBooks would be a second way to get it wrong.

/** Record a link that already exists in fact.
 *
 *  The SAFE action. The product and the QuickBooks item / Shopify variant
 *  already share a SKU — this only stores the id, so nothing in either external
 *  system is written or overwritten. It is reversible by clearing the field.
 */
export async function linkRecord(updateVibeRecord, layout, row, target) {
  const cand = target === 'qbo' ? row.qboCandidates?.[0] : row.shopCandidates?.[0];
  if (!cand) throw new Error('no candidate to link');
  const updates = target === 'qbo'
    ? { _kat__Item_ID_QuickBooks: String(cand.id) }
    : { _kat__Item_ID_Shopify: String(cand.productId), _kat__Item_Variant_Id: String(cand.variantId || '') };
  await updateVibeRecord(layout, row.recordId, updates);
  return updates;
}

/** True when a bucket's rows can be linked rather than pushed. */
export const isLinkable = bucket => bucket === 'qbo_linkable' || bucket === 'shop_linkable';

/** True when a bucket needs a person to decide, so no bulk action is offered. */
export const needsJudgement = bucket => bucket.endsWith('_sku_dupe');

/** Which side of a drift row differs, for display. Returns null for buckets
 *  where "ours vs theirs" is not the shape of the problem. */
export function compareValues(bucket, row) {
  if (bucket === 'qbo_name_drift') return { field: 'Name', ours: row.name, theirs: row.qboName };
  if (bucket === 'qbo_price_drift') return { field: 'Price', ours: row.fmPrice, theirs: row.qboPrice, money: true };
  if (bucket === 'shop_price_drift') return { field: 'Price', ours: row.fmPrice, theirs: row.shopPrice, money: true };
  if (bucket.endsWith('_link_broken')) return { field: 'Stored id', ours: row.storedId, theirs: '(not found)' };
  return null;
}
