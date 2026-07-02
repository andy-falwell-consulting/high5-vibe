// READ-ONLY three-way product reconciliation: FileMaker (Belay) ↔ QuickBooks
// Online items ↔ Shopify products/variants. Answers "are the three systems in
// lock-step for shared records?" without mutating anything.
//
// The join key is the SKU (a real business key present in all three: FMP
// `SKU`, QBO Item `Sku`, Shopify variant `sku`). Explicit stored link ids
// (`_kat__Item_ID_QuickBooks`, `_kat__Item_ID_Shopify`) are trusted first; SKU
// is used to find records that SHOULD be linked but aren't, and to detect
// field drift (price / name) on records that are linked.
//
// GET /api/product-reconcile?db=High5_Core4        summary + capped samples
//     &full=1                                      include full per-bucket lists
//     &bucket=<name>                               dump one bucket in full
// Auth: x-sync-key header/query (QBO_SYNC_KEY) or a Google session.
import { getGoogleSession } from './_googleSession.js';
import { fmpToken, ALLOWED_DBS } from './_fmp.js';
import { getAccessToken, qboBase } from './_qbo.js';

export const config = { maxDuration: 120 };

const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const LAYOUT = 'Products & Services_New';
const SHOP_API = '2025-10';
const SYNC_KEY = process.env.QBO_SYNC_KEY;

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}

const normSku = s => String(s ?? '').trim().toUpperCase();
const normName = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const digits = s => (String(s ?? '').match(/\d+/g) || []).join('');       // gid/URL → numeric id
const money = v => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const priceDrift = (a, b) => { const x = money(a), y = money(b); return x != null && y != null && Math.abs(x - y) >= 0.005; };

// ── FileMaker: page every product ───────────────────────────────────
// Use _find with `portal: []` to suppress the BOM portals — a GET /records
// returns every product's full bill-of-materials portal, which balloons the
// payload and stalls the whole run. We only need flat fields here.
async function loadFmProducts(db, token) {
  const out = [];
  for (let offset = 1, guard = 0; guard < 200; guard++) {
    const r = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${encodeURIComponent(LAYOUT)}/_find`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: [{ _kpt__Item_ID: '*' }], portal: [], limit: 500, offset }),
    });
    const j = await r.json().catch(() => ({}));
    if (j?.messages?.[0]?.code === '401') break; // no more records
    const rows = j?.response?.data || [];
    if (!rows.length) break;
    for (const rec of rows) {
      const f = rec.fieldData || {};
      out.push({
        recordId: rec.recordId,
        itemId: f._kpt__Item_ID,
        name: f.Name || '',
        sku: f.SKU || '',
        price: f.Unit_Price,
        qboId: String(f._kat__Item_ID_QuickBooks || '').trim(),
        shopifyId: String(f._kat__Item_ID_Shopify || '').trim(),
        variantId: String(f._kat__Item_Variant_Id || '').trim(),
      });
    }
    if (rows.length < 500) break;
    offset += rows.length;
  }
  return out;
}

// ── QBO: page every item ────────────────────────────────────────────
// minorversion 75 is REQUIRED for the Item `Sku` field to be returned (the
// shared qboQuery helper pins 65, which silently omits it).
async function loadQboItems() {
  const token = await getAccessToken('production');
  const q = sql => fetch(`${qboBase('production')}/query?query=${encodeURIComponent(sql)}&minorversion=75`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }).then(r => r.json());
  const out = [];
  for (let pos = 1, guard = 0; guard < 40; guard++) {
    // SELECT * — QBO returns Sku with the wildcard but omits it from an explicit
    // projected column list (a documented quirk), even at minorversion 75.
    const page = (await q(`SELECT * FROM Item STARTPOSITION ${pos} MAXRESULTS 1000`))?.QueryResponse?.Item || [];
    for (const i of page) out.push({ id: String(i.Id), name: i.Name || '', sku: i.Sku || '', type: i.Type, active: i.Active !== false, price: i.UnitPrice });
    if (page.length < 1000) break;
    pos += page.length;
  }
  return out;
}

// ── Shopify: page every product + its variants ──────────────────────
async function loadShopifyVariants() {
  const store = process.env.SHOPIFY_STORE;
  const token = (await import('@upstash/redis').then(m => m.Redis.fromEnv().get('shopify_token').catch(() => null))) || process.env.SHOPIFY_TOKEN;
  if (!store || !token) throw new Error('Shopify not configured');
  const gql = async (query, variables) => {
    const r = await fetch(`https://${store}/admin/api/${SHOP_API}/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.errors?.length) throw new Error(j.errors.map(e => e.message).join('; '));
    return j.data;
  };
  const out = [];
  let cursor = null;
  for (let guard = 0; guard < 80; guard++) {
    const d = await gql(`query($c:String){ products(first:100, after:$c){ pageInfo{ hasNextPage endCursor }
      nodes{ id title status variants(first:50){ nodes{ id sku price } } } } }`, { c: cursor });
    for (const p of d.products.nodes) {
      for (const v of p.variants.nodes) {
        out.push({ productId: p.id, variantId: v.id, sku: v.sku || '', price: v.price, title: p.title || '', status: p.status });
      }
    }
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
  return out;
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const db = req.query?.db || 'High5_Core4';
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  let fm, qbo, shop;
  try {
    const token = await fmpToken(db);
    [fm, qbo, shop] = await Promise.all([loadFmProducts(db, token), loadQboItems(), loadShopifyVariants()]);
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 500) });
  }

  // Index QBO + Shopify by id and by normalized SKU (note SKU collisions).
  const qById = new Map(qbo.map(i => [i.id, i]));
  const qBySku = new Map(); for (const i of qbo) { const k = normSku(i.sku); if (k) (qBySku.get(k) || qBySku.set(k, []).get(k)).push(i); }
  // Shopify is variant-grained: key by VARIANT id (a product can hold many
  // variants at different prices). Product id only groups them.
  const sByVariant = new Map(shop.map(v => [digits(v.variantId), v]));
  const sByProduct = new Map(); for (const v of shop) { const k = digits(v.productId); if (k) (sByProduct.get(k) || sByProduct.set(k, []).get(k)).push(v); }
  const sBySku = new Map(); for (const v of shop) { const k = normSku(v.sku); if (k) (sBySku.get(k) || sBySku.set(k, []).get(k)).push(v); }

  const B = {
    qbo_linked_clean: [], qbo_link_broken: [], qbo_linkable: [], qbo_price_drift: [], qbo_name_drift: [], qbo_no_match: [],
    shop_linked_clean: [], shop_link_broken: [], shop_linkable: [], shop_price_drift: [], shop_no_match: [],
    fm_no_sku: [], fm_sku_dupe: [], qbo_orphan: [], shop_orphan: [], qbo_sku_dupe: [], shop_sku_dupe: [],
  };

  // FM SKU collisions
  const fmBySku = new Map(); for (const p of fm) { const k = normSku(p.sku); if (k) (fmBySku.get(k) || fmBySku.set(k, []).get(k)).push(p); }
  for (const [k, ps] of fmBySku) if (ps.length > 1) B.fm_sku_dupe.push({ sku: k, recordIds: ps.map(p => p.recordId) });
  for (const [k, is] of qBySku) if (is.length > 1) B.qbo_sku_dupe.push({ sku: k, ids: is.map(i => i.id) });
  for (const [k, vs] of sBySku) if (vs.length > 1) B.shop_sku_dupe.push({ sku: k, productIds: vs.map(v => v.productId) });

  const matchedQ = new Set(), matchedS = new Set();

  for (const p of fm) {
    const sk = normSku(p.sku);
    if (!sk) B.fm_no_sku.push({ recordId: p.recordId, name: p.name });
    const row = { recordId: p.recordId, sku: p.sku, name: p.name, price: p.price };

    // ---- QBO side ----
    if (p.qboId) {
      const q = qById.get(digits(p.qboId)) || qById.get(p.qboId);
      if (!q) B.qbo_link_broken.push({ ...row, storedId: p.qboId });
      else {
        matchedQ.add(q.id);
        if (priceDrift(p.price, q.price)) B.qbo_price_drift.push({ ...row, fmPrice: money(p.price), qboPrice: money(q.price), qboId: q.id });
        else if (normName(p.name) && normName(q.name) && normName(p.name) !== normName(q.name)) B.qbo_name_drift.push({ ...row, qboName: q.name, qboId: q.id });
        else B.qbo_linked_clean.push({ recordId: p.recordId, sku: p.sku, qboId: q.id });
      }
    } else if (sk && qBySku.has(sk)) {
      const cands = qBySku.get(sk); cands.forEach(c => matchedQ.add(c.id));
      B.qbo_linkable.push({ ...row, qboCandidates: cands.map(c => ({ id: c.id, name: c.name, price: money(c.price) })) });
    } else {
      B.qbo_no_match.push({ ...row });
    }

    // ---- Shopify side ----
    if (p.shopifyId) {
      // Resolve the exact variant: prefer the stored variant id, then the SKU
      // within the linked product, then (single-variant products) the lone variant.
      const prodVars = sByProduct.get(digits(p.shopifyId)) || [];
      let v = (p.variantId && sByVariant.get(digits(p.variantId)))
        || (sk && prodVars.find(x => normSku(x.sku) === sk))
        || (prodVars.length === 1 ? prodVars[0] : null);
      if (!v) B.shop_link_broken.push({ ...row, storedId: p.shopifyId, reason: prodVars.length ? 'variant-unresolved' : 'product-missing' });
      else {
        matchedS.add(digits(v.variantId));
        if (priceDrift(p.price, v.price)) B.shop_price_drift.push({ ...row, fmPrice: money(p.price), shopPrice: money(v.price), productId: v.productId, variantId: v.variantId });
        else B.shop_linked_clean.push({ recordId: p.recordId, sku: p.sku, variantId: v.variantId });
      }
    } else if (sk && sBySku.has(sk)) {
      const cands = sBySku.get(sk); cands.forEach(c => matchedS.add(digits(c.variantId)));
      B.shop_linkable.push({ ...row, shopCandidates: cands.map(c => ({ productId: c.productId, variantId: c.variantId, title: c.title, price: money(c.price), status: c.status })) });
    } else {
      B.shop_no_match.push({ ...row });
    }
  }

  // Orphans: live in QBO/Shopify with a SKU but no FM product references them.
  for (const i of qbo) if (normSku(i.sku) && !matchedQ.has(i.id) && !fmBySku.has(normSku(i.sku))) B.qbo_orphan.push({ id: i.id, name: i.name, sku: i.sku, active: i.active, price: money(i.price) });
  for (const v of shop) if (normSku(v.sku) && !matchedS.has(digits(v.variantId)) && !fmBySku.has(normSku(v.sku))) B.shop_orphan.push({ productId: v.productId, variantId: v.variantId, title: v.title, sku: v.sku, status: v.status, price: money(v.price) });

  const summary = Object.fromEntries(Object.entries(B).map(([k, v]) => [k, v.length]));
  summary._totals = {
    fm_products: fm.length, qbo_items: qbo.length, shopify_variants: shop.length,
    fm_with_sku: fm.filter(p => normSku(p.sku)).length,
    qbo_with_sku: qbo.filter(i => normSku(i.sku)).length,
    shop_with_sku: shop.filter(v => normSku(v.sku)).length,
  };

  if (req.query?.bucket && B[req.query.bucket]) return res.status(200).json({ db, bucket: req.query.bucket, count: B[req.query.bucket].length, rows: B[req.query.bucket] });
  if (req.query?.full === '1') return res.status(200).json({ db, summary, buckets: B });
  const sample = Object.fromEntries(Object.entries(B).map(([k, v]) => [k, v.slice(0, 8)]));
  return res.status(200).json({ db, summary, sample });
}
