// READ-ONLY reconciliation of Shopify orders against the QuickBooks ledger.
// Answers one question: is any store order missing from the books for a reason
// nobody chose?
//
//   GET /api/shopify-order-reconcile?db=High5_Core4          run it
//       &report=1                                            last stored result, no work
//       &bucket=missing_paid                                  one bucket in full
//       &full=1                                               every bucket in full
//
// WHY THIS EXISTS. Comparing the two systems by hand took an afternoon and
// produced one answer. Shopify order #5822 (YMCA Cape Cod, $1,590, fulfilled)
// had no QuickBooks document under its number — and looked, for a while, like
// $1,590 of delivered training nobody had billed. It had in fact been invoiced
// two weeks EARLIER, to the organisation rather than the person, for $1,570
// rather than $1,590, bundled onto a $2,345 invoice with someone else's Level 2
// place. Nothing about it matched: not the contact, not the price, not the
// total, not the date, not the order number.
//
// The only thing that DID say so was a Shopify tag — "Invoiced through QB" —
// which someone had set deliberately. That tag is machine-readable, so this
// reads it, and reports only the orders where no explanation exists at all.
//
// Auth: x-sync-key header/query (QBO_SYNC_KEY) or a Google session.
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';

export const config = { maxDuration: 300 };

const SHOP_API = '2025-10';
const SYNC_KEY = process.env.QBO_SYNC_KEY;

// The day the Shopify → QuickBooks link went live, measured from the earliest
// "#"-numbered document in the ledger. Orders before it were never meant to
// appear and are not the subject of this report.
const LINK_LIVE_FROM = '2021-02-21';

// What the office writes on an order it has billed directly. Matched loosely
// because it is typed by a person: "Invoiced through QB", "invoiced thru qb".
const INVOICED_TAG = /invoiced\s*(through|thru|in)?\s*qb/i;

const redis = Redis.fromEnv();
const recsKey = db => `txn:${db}:recs`;
const lastKey = db => `vibe:${db}:shoporder:last`;

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}

// ── The two sides ─────────────────────────────────────────────────

/**
 * Every QuickBooks document whose number is a Shopify order name.
 *
 * Read from the mirror rather than QuickBooks: it is already in Redis, already
 * current, and one hash scan costs a fraction of re-reading the ledger.
 */
async function loadQboByOrderName(db) {
  const byName = new Map();
  let cursor = '0';
  do {
    const [next, flat] = await redis.hscan(recsKey(db), cursor, { count: 5000 });
    for (let i = 1; i < flat.length; i += 2) {
      const r = typeof flat[i] === 'string' ? JSON.parse(flat[i]) : flat[i];
      const doc = String(r?.docNumber || '');
      // Only "#1234" is an order name. A plain number is an ordinary invoice,
      // and 223 receipts filed under "Shopify Sales" carry no order number at
      // all — those are summary postings and cannot be matched by name.
      if (!/^#\d+$/.test(doc)) continue;
      const list = byName.get(doc) || [];
      list.push({ type: r.type, id: r.id, total: r.total, date: r.date, customer: r.customerName });
      byName.set(doc, list);
    }
    cursor = String(next);
  } while (cursor !== '0');
  return byName;
}

async function loadShopifyOrders(deadline) {
  const store = process.env.SHOPIFY_STORE;
  const token = (await redis.get('shopify_token').catch(() => null)) || process.env.SHOPIFY_TOKEN;
  if (!store || !token) throw new Error('Shopify not configured');

  const gql = async (query, variables) => {
    const r = await fetch(`https://${store}/admin/api/${SHOP_API}/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json().catch(() => ({}));
    // Shopify answers a cost overrun with THROTTLED rather than a 429. One
    // unhurried retry beats failing a five-thousand-order report.
    if (j.errors?.some(e => /throttl/i.test(e.message || ''))) {
      await new Promise(s => setTimeout(s, 4000));
      return gql(query, variables);
    }
    if (j.errors?.length) throw new Error(j.errors.map(e => e.message).join('; '));
    return j.data;
  };

  const out = [];
  let cursor = null;
  for (let guard = 0; guard < 120; guard++) {
    if (Date.now() > deadline) throw new Error(`timed out after ${out.length} orders`);
    const d = await gql(`query($c:String,$q:String){ orders(first:250, after:$c, query:$q, sortKey:CREATED_AT){
      pageInfo{ hasNextPage endCursor }
      nodes{ name createdAt cancelledAt displayFinancialStatus tags
             totalPriceSet{ shopMoney{ amount } } customer{ email } } } }`,
      { c: cursor, q: `created_at:>='${LINK_LIVE_FROM}'` });
    for (const o of d.orders.nodes) {
      out.push({
        name: o.name,
        date: String(o.createdAt || '').slice(0, 10),
        cancelled: !!o.cancelledAt,
        status: o.displayFinancialStatus || '',
        total: Number(o.totalPriceSet?.shopMoney?.amount || 0),
        tags: o.tags || [],
        email: o.customer?.email || '',
      });
    }
    if (!d.orders.pageInfo.hasNextPage) break;
    cursor = d.orders.pageInfo.endCursor;
  }
  return out;
}

// ── Classification ────────────────────────────────────────────────

// Order matters: the first explanation that fits wins, so an order is never
// counted twice and the exception buckets hold only what nothing else explains.
function classify(order, qboDocs) {
  if (qboDocs) return qboDocs.length > 1 ? 'duplicated' : 'matched';
  if (order.cancelled) return 'cancelled';
  // A zero-value order is a comp, a staff freebie or a test. It is CORRECT for
  // it to produce no accounting document.
  if (!(order.total > 0)) return 'zero_value';
  if (order.tags.some(t => INVOICED_TAG.test(t))) return 'invoiced_in_qb';
  // Nothing explains these two. They are the whole point of the report.
  return /pending|unpaid|partially_paid/i.test(order.status) ? 'missing_unpaid' : 'missing_paid';
}

const EXCEPTIONS = ['missing_paid', 'missing_unpaid', 'duplicated'];

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const db = String(req.query?.db || 'High5_Core4');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  // A dashboard must never trigger a five-thousand-order sweep to show a number.
  if (req.query?.report) {
    const last = await redis.get(lastKey(db));
    return res.status(200).json({ db, last: last || null });
  }

  let qboByName, orders;
  try {
    const deadline = Date.now() + 240000;
    [qboByName, orders] = await Promise.all([loadQboByOrderName(db), loadShopifyOrders(deadline)]);
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 400) });
  }

  const buckets = { matched: [], duplicated: [], cancelled: [], zero_value: [], invoiced_in_qb: [], missing_paid: [], missing_unpaid: [] };
  for (const o of orders) {
    const docs = qboByName.get(o.name);
    const bucket = classify(o, docs);
    buckets[bucket].push({
      order: o.name, date: o.date, total: o.total, status: o.status, email: o.email,
      ...(docs ? { qbo: docs.map(d => `${d.type} ${d.id} $${d.total} ${d.date}`) } : {}),
    });
  }

  const money = rows => Math.round(rows.reduce((t, r) => t + (r.total || 0), 0) * 100) / 100;
  const summary = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
  const exceptions = EXCEPTIONS.reduce((t, k) => t + buckets[k].length, 0);

  // Exceptions in the STORED result, so the Admin tab can show them without
  // re-running a five-thousand-order sweep. 121 rows is about 15 KB; the
  // explained buckets run to thousands and are deliberately left out.
  const rows = Object.fromEntries(EXCEPTIONS.map(k => [k, buckets[k]]));

  // The year an exception falls in is the only thing that makes this readable.
  // 96% of the value is 2021-22, and a headline that never moves gets ignored
  // within a week — so the tab leads on what is RECENT and files the rest as a
  // backlog.
  const byYear = {};
  for (const k of EXCEPTIONS) {
    for (const r of buckets[k]) {
      const y = String(r.date || '').slice(0, 4) || 'unknown';
      byYear[y] = byYear[y] || { count: 0, value: 0 };
      byYear[y].count += 1;
      byYear[y].value = Math.round((byYear[y].value + (r.total || 0)) * 100) / 100;
    }
  }

  const result = {
    at: new Date().toISOString(),
    ordersSince: LINK_LIVE_FROM,
    orders: orders.length,
    summary,
    exceptions,
    unexplainedValue: { paid: money(buckets.missing_paid), unpaid: money(buckets.missing_unpaid) },
    byYear,
    rows,
  };
  // The RESULT is stored, never the source data — this owns no records.
  await redis.set(lastKey(db), result).catch(() => {});

  if (req.query?.bucket && buckets[req.query.bucket]) {
    return res.status(200).json({ db, bucket: req.query.bucket, count: buckets[req.query.bucket].length, rows: buckets[req.query.bucket] });
  }
  if (req.query?.full === '1') return res.status(200).json({ db, ...result, buckets });
  // Exceptions in full, everything else as a count: the explained buckets run to
  // thousands of rows and there is nothing in them to act on.
  return res.status(200).json({ db, ...result });
}
