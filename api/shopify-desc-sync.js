// Shopify → FileMaker description backfill. Pulls each Shopify-linked product's
// description (descriptionHtml) into Belay's `shopify_description` field on
// Products & Services_New. Shopify is the source of truth — always overwrites.
//
// Resumable + time-bounded per run: pages products that have a Shopify id,
// batch-reads their descriptions from Shopify, writes back to FMP. Drive it with
// a loop that re-calls with the returned `cursor` until `done`.
//
// GET/POST /api/shopify-desc-sync?db=High5_Core4&offset=1   (gated; see authorized())
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { fmpToken, fmUpdate, ALLOWED_DBS } from './_fmp.js';

export const config = { maxDuration: 300 };

const redis = Redis.fromEnv();
const SYNC_KEY = process.env.QBO_SYNC_KEY;
const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const SHOP_API_VERSION = '2025-10';
const LAYOUT = 'Products & Services_New';
const PAGE = 50; // products per FMP page / Shopify nodes() batch

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  const cron = process.env.CRON_SECRET;
  if (cron && req.headers.authorization === `Bearer ${cron}`) return true;
  return !!(await getGoogleSession(req));
}

async function shopifyToken() {
  try { const t = await redis.get('shopify_token'); if (t) return t; } catch { /* redis unavailable */ }
  return process.env.SHOPIFY_TOKEN || null;
}

async function shopGql(store, token, query, variables) {
  const r = await fetch(`https://${store}/admin/api/${SHOP_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.errors?.length) throw new Error(j.errors.map(e => e.message).join('; '));
  return j.data;
}

const toGid = raw => String(raw).startsWith('gid://') ? String(raw) : `gid://shopify/Product/${raw}`;

// One page of products that have a Shopify id. Stable set (we only write a
// non-key field), so offset paging is safe.
async function findLinkedPage(db, token, offset) {
  const r = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${encodeURIComponent(LAYOUT)}/_find`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: [{ _kat__Item_ID_Shopify: '*' }],
      limit: PAGE, offset,
      sort: [{ fieldName: '_kpt__Item_ID', sortOrder: 'ascend' }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (j?.messages?.[0]?.code === '401') return { rows: [], total: 0 };
  return { rows: j?.response?.data || [], total: j?.response?.dataInfo?.foundCount ?? 0 };
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const db = req.query?.db || req.body?.db;
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  const store = process.env.SHOPIFY_STORE;
  const stoken = await shopifyToken();
  if (!store || !stoken) return res.status(500).json({ error: 'Shopify not configured' });

  let cursor = Math.max(1, Number(req.query?.offset || req.body?.offset || 1));
  const started = Date.now();
  const ftoken = await fmpToken(db);

  let processed = 0, updated = 0, missing = 0, errors = 0, total = null;
  try {
    while (Date.now() - started < 260000) {
      const { rows, total: tot } = await findLinkedPage(db, ftoken, cursor);
      if (total == null) total = tot;
      if (!rows.length) { cursor = null; break; }

      // map normalized gid -> record (skip blanks)
      const byGid = new Map();
      for (const r of rows) {
        const raw = r.fieldData?._kat__Item_ID_Shopify;
        if (raw) byGid.set(toGid(raw), r);
      }
      const gids = [...byGid.keys()];
      let descById = new Map();
      if (gids.length) {
        const data = await shopGql(store, stoken,
          `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id descriptionHtml } } }`, { ids: gids });
        descById = new Map((data?.nodes || []).filter(Boolean).map(n => [n.id, n.descriptionHtml || '']));
      }

      for (const [gid, rec] of byGid) {
        processed++;
        if (!descById.has(gid)) { missing++; continue; } // product not in Shopify
        const desc = descById.get(gid);
        if ((rec.fieldData?.shopify_description || '') === desc) continue; // no change
        try { await fmUpdate(db, LAYOUT, rec.recordId, { shopify_description: desc }, ftoken); updated++; }
        catch { errors++; }
      }

      cursor += rows.length;
      if (rows.length < PAGE) { cursor = null; break; } // last page
    }
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e), processed, updated, missing, errors, cursor, total });
  }

  const done = cursor == null;
  return res.status(200).json({ done, processed, updated, missing, errors, cursor: done ? null : cursor, total });
}
