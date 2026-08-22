// Where a transaction came from, and what it was for.
//
// Two axes, because the obvious single label cannot carry both: an ESTIMATE is
// where a transaction came from, SHOPIFY is how it was sold. A store order whose
// only line is a Level 2 training is genuinely both, and a design that forces a
// choice is wrong half the time. Measured example: invoice #5716, Wellesley High
// School.
//
// WHERE EACH IS COMPUTED, and why they differ:
//
//   ORIGIN is derived HERE, at read time, from evidence the row already carries
//   (links, note, po, docNumber, customerName). Costs no storage, and a rule
//   corrected tomorrow takes effect on the next page load rather than after a
//   re-read of all of QuickBooks.
//
//   LINE OF BUSINESS is computed at SYNC time and stored on the row, because its
//   input is the line items — and those deliberately live in a separate hash
//   that the ledger list does not read (see _txnNormalize.js). Deriving it here
//   would mean reading them back and undoing the 56% bandwidth saving that
//   separation exists for.
//
// Every figure quoted below was measured against the production ledger on
// 2026-08-21; see docs/transaction-source-scope.md.
import { parseStamp } from './_vibeStamp.js';

// ── Origin ────────────────────────────────────────────────────────

export const ORIGIN_LABELS = {
  vibe: 'Created in Vibe',
  estimate: 'From an estimate',
  shopify: 'Shopify order',
  amazon: 'Amazon',
  paypal: 'PayPal',
  bloomerang: 'Bloomerang donation',
  unknown: 'Unknown',
};

// Aggregated channel feeds, matched on the customer QuickBooks files them under.
// A weaker signal than the document number — 4,574 store orders are filed under
// the shopper's own name — so it runs after it.
const CHANNELS = [
  [/shopify/i, 'shopify'],
  [/amazon/i, 'amazon'],
  [/paypal/i, 'paypal'],
];

// "D-3041", tolerating the stray space seen in the CCS references.
const DOC_REF = /\bD-\s?(\d+)/i;

/**
 * @param {object} row a stored transaction row (see _txnNormalize.js)
 * @returns {{kind:string, ref?:string, label:string, why:string, confidence:string}}
 */
export function classifyOrigin(row = {}) {
  const doc = String(row.docNumber || '');
  const note = String(row.note || '');
  const links = Array.isArray(row.links) ? row.links : [];

  // 1. Vibe put it there itself. The only signal that is true by construction
  //    rather than by inference — see _vibeStamp.js.
  const stamp = parseStamp(note);
  if (stamp) return { kind: 'vibe', ref: stamp.id, label: `Vibe ${stamp.kind} ${stamp.id}`, why: 'stamp', confidence: 'certain' };

  // 2. QuickBooks' own link. No matching, no guessing.
  const est = links.find(l => l.t === 'Estimate');
  if (est) return { kind: 'estimate', ref: String(est.id), label: 'From an estimate', why: 'link', confidence: 'certain' };

  // 3. A document number the store wrote. 4,940 sales receipts and 291
  //    invoices, none earlier than 2021-02-21.
  if (doc.startsWith('#')) return { kind: 'shopify', ref: doc, label: `Shopify order ${doc}`, why: 'docNumber', confidence: 'certain' };

  // 4. Bloomerang, the donor platform. 101 invoices, every one a donation.
  if (/^Bloom/i.test(doc)) return { kind: 'bloomerang', ref: doc, label: 'Bloomerang donation', why: 'docNumber', confidence: 'certain' };

  // 5. The aggregated channel customers.
  for (const [re, kind] of CHANNELS) {
    if (re.test(row.customerName || '')) return { kind, label: ORIGIN_LABELS[kind], why: 'customer', confidence: 'certain' };
  }

  // 6. The office typed the estimate number into the memo. Free text, so this
  //    is LIKELY and never certain — found on credit memos in particular
  //    ("T&TD - D-1130"), which QuickBooks does not link to anything.
  const m = DOC_REF.exec(note);
  if (m) return { kind: 'estimate', ref: `D-${m[1]}`, label: `From estimate D-${m[1]}`, why: 'note', confidence: 'likely' };

  // 7. Nothing. Said plainly rather than guessed: roughly 40% of the back
  //    catalogue has no origin recorded anywhere, and inventing one would be
  //    worse than a blank.
  return { kind: 'unknown', label: 'Unknown', why: 'none', confidence: 'unknown' };
}

// ── Line of business ──────────────────────────────────────────────

export const LINE_LABELS = {
  ccs: 'Challenge Course Services',
  training: 'Training & Team Development',
  catalog: 'Catalog',
  rcd: 'RCD Components',
  fundraising: 'Fundraising',
  deposit: 'Deposit',
  shipping: 'Shipping',
  travel: 'Travel',
};

// QuickBooks item names are account paths — "4200 CHALLENGE COURSE
// SERVICES:…" — and the top level names the business line. Matched on the words,
// with the account number stripped, so renumbering the chart of accounts does
// not silently unclassify five years of history.
const PREFIXES = [
  [/CHALLENGE COURSE/i, 'ccs'],
  [/TRAINING/i, 'training'],
  [/CATALOG/i, 'catalog'],
  [/RCD COMPONENTS/i, 'rcd'],
  [/FUNDRAISING/i, 'fundraising'],
  [/^TRAVEL$/i, 'travel'],
];

// Items with no account path. A credit memo is usually a deposit rather than a
// sale of anything — 45 of 50 sampled carried only this — so the flat name is
// the answer, not a failure to find one.
const FLAT = [
  [/deposit/i, 'deposit'],
  [/shipping|freight|handling/i, 'shipping'],
];

// Present on many transactions alongside the real work, and never the point of
// one. Only chosen when there is nothing else.
const ANCILLARY = new Set(['travel', 'shipping']);

const codeFor = item => {
  const name = String(item || '');
  const top = name.includes(':') ? name.split(':')[0] : '';
  if (top) {
    const hit = PREFIXES.find(([re]) => re.test(top));
    if (hit) return hit[1];
    return null;   // an account path we do not recognise
  }
  const flat = FLAT.find(([re]) => re.test(name));
  return flat ? flat[1] : null;
};

/**
 * The business line a transaction belongs to, or null.
 *
 * Weighted by amount rather than taking the first line: an inspection invoice
 * that opens with a $0 "Services" line and a travel charge is still a challenge
 * course job, and the money says so more reliably than the ordering does.
 */
export function lineOfBusiness(lines = []) {
  const totals = new Map();
  for (const l of lines) {
    const code = codeFor(l?.item);
    if (!code) continue;
    totals.set(code, (totals.get(code) || 0) + Math.abs(Number(l.amount) || 0));
  }
  if (!totals.size) return null;

  const substantive = [...totals].filter(([c]) => !ANCILLARY.has(c));
  const pool = substantive.length ? substantive : [...totals];
  // Highest value first; on a tie (every line zero, which happens) the earlier
  // rule order wins, so the result is stable rather than dependent on Map order.
  pool.sort((a, b) => b[1] - a[1]);
  return pool[0][0];
}

/** The compact form the ledger list carries: two codes, nothing else. */
export const compactSource = (row = {}) => {
  const o = classifyOrigin(row);
  const out = { o: o.kind };
  if (row.lob) out.l = row.lob;
  return out;
};

/** The full form the detail pane shows, including why it says what it says. */
export const fullSource = (row = {}) => {
  const origin = classifyOrigin(row);
  return {
    origin,
    line: row.lob || null,
    lineLabel: row.lob ? (LINE_LABELS[row.lob] || row.lob) : null,
  };
};
