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
