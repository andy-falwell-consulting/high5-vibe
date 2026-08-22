import { getCurrentEnv } from '../config/fmpEnvironments';

// Shopify orders reconciled against the QuickBooks ledger.
// See the header of api/shopify-order-reconcile.js for what each bucket means
// and why the "Invoiced through QB" tag is the thing that makes it possible.

const qs = extra => `db=${encodeURIComponent(getCurrentEnv().db)}${extra}`;

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

/** The STORED result of the last run. Cheap — reconciles nothing. */
export const getOrderReport = () =>
  fetch(`/api/shopify-order-reconcile?${qs('&report=1')}`, { credentials: 'include' }).then(json);

/** Run it now. Pages every Shopify order since the link went live, so it takes
 *  a minute or two — which is why the tab reads the stored result and this sits
 *  behind a button someone has to press. */
export const runOrderReconcile = () =>
  fetch(`/api/shopify-order-reconcile?${qs('')}`, { credentials: 'include' }).then(json);

// The bucket keys are precise and unreadable; these say what a person would.
export const ORDER_BUCKET_LABEL = {
  missing_paid: 'Paid, with no document',
  missing_unpaid: 'Fulfilled and unpaid, with no document',
  duplicated: 'Two documents for one order',
  matched: 'Matched to a document',
  invoiced_in_qb: 'Tagged “invoiced through QB”',
  cancelled: 'Cancelled',
  zero_value: 'Zero value — a comp or a test',
};

// What each exception means, in the words someone would need to act on it.
export const ORDER_BUCKET_WHY = {
  missing_paid: 'Money moved in the store and no QuickBooks document carries the order number. Most are historical, and an order CAN be invoiced properly under a different customer, amount and date with nothing linking the two — so treat these as unexplained rather than unbilled.',
  missing_unpaid: 'Fulfilled but never paid in the store, and nothing says it was billed elsewhere. These are usually training places sold on account.',
  duplicated: 'Two QuickBooks documents carry the same order number. Worth a look: the amounts rarely agree with each other or with the order.',
};

/** The current calendar year, and the one before it — everything older is a
 *  backlog nobody is going to work through, and burying this year's two
 *  exceptions under 2021's seventy is how a report gets ignored. */
export function splitRecent(byYear = {}, recentFrom) {
  const cut = recentFrom ?? new Date().getFullYear() - 1;
  const recent = { count: 0, value: 0 };
  const backlog = { count: 0, value: 0 };
  for (const [year, v] of Object.entries(byYear)) {
    const t = Number(year) >= cut ? recent : backlog;
    t.count += v.count;
    t.value = Math.round((t.value + v.value) * 100) / 100;
  }
  return { recent, backlog, cut };
}
