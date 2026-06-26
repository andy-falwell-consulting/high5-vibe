import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const API_VERSION = '2025-10';

// Prefer the OAuth token stored in Redis (set by /api/shopify-callback); fall
// back to the static SHOPIFY_TOKEN env var.
async function resolveToken() {
  try { const t = await redis.get('shopify_token'); if (t) return { token: t, source: 'oauth' }; } catch { /* redis unavailable */ }
  return { token: process.env.SHOPIFY_TOKEN || null, source: process.env.SHOPIFY_TOKEN ? 'env' : null };
}

// ── GraphQL Admin API ────────────────────────────────────────────
// We use GraphQL (not REST) because the product/variant REST endpoints are
// deprecated, our records already store GraphQL GIDs, and bulk-variant mutations
// update a single variant in place — so re-syncing a multi-variant product never
// deletes its siblings (which the REST whole-product PUT did).
async function gql(store, token, query, variables) {
  const r = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await r.json().catch(() => ({}));
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data;
}

function throwOnUserErrors(payload, label) {
  const ue = payload?.userErrors;
  if (ue?.length) throw new Error(`${label}: ${ue.map(e => `${(e.field || []).join('.')} ${e.message}`.trim()).join('; ')}`);
}

// Set price + SKU on one variant, in place — never touches sibling variants.
async function updateVariantInPlace(store, token, productId, variantId, { price, sku }) {
  const variant = { id: variantId, price: String(price ?? '0') };
  if (sku != null && sku !== '') variant.inventoryItem = { sku: String(sku) };
  const data = await gql(store, token, `
    mutation BulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id sku price }
        userErrors { field message }
      }
    }`, { productId, variants: [variant] });
  throwOnUserErrors(data.productVariantsBulkUpdate, 'variant update');
  return data.productVariantsBulkUpdate.productVariants?.[0] || null;
}

// Find the variant on a product whose SKU matches (robust against a stale stored
// variant id). Returns null when no SKU match — caller falls back to a given id.
async function resolveVariantIdBySku(store, token, productId, sku) {
  if (!sku) return null;
  const data = await gql(store, token, `
    query($id: ID!) { product(id: $id) { variants(first: 100) { nodes { id sku } } } }`, { id: productId });
  const nodes = data.product?.variants?.nodes || [];
  return nodes.find(v => String(v.sku) === String(sku))?.id || null;
}

async function createProduct(store, token, { title, descriptionHtml, status, price, sku }) {
  const data = await gql(store, token, `
    mutation Create($input: ProductInput!) {
      productCreate(input: $input) {
        product { id variants(first: 1) { nodes { id } } }
        userErrors { field message }
      }
    }`, { input: { title, descriptionHtml: descriptionHtml || '', status: String(status || 'draft').toUpperCase() } });
  throwOnUserErrors(data.productCreate, 'product create');
  const productId = data.productCreate.product.id;
  const variantId = data.productCreate.product.variants.nodes[0]?.id || null;
  if (variantId) await updateVariantInPlace(store, token, productId, variantId, { price, sku });
  return { productId, variantId };
}

async function updateProduct(store, token, { productId, variantId, title, descriptionHtml, price, sku }) {
  const data = await gql(store, token, `
    mutation Update($input: ProductInput!) {
      productUpdate(input: $input) { product { id } userErrors { field message } }
    }`, { input: { id: productId, title, descriptionHtml: descriptionHtml || '' } });
  throwOnUserErrors(data.productUpdate, 'product update');
  // Prefer the live SKU match; fall back to the stored variant id.
  const vId = (await resolveVariantIdBySku(store, token, productId, sku)) || variantId;
  if (!vId) throw new Error('No matching variant to update (check SKU / variant id)');
  const v = await updateVariantInPlace(store, token, productId, vId, { price, sku });
  return { productId, variantId: v?.id || vId };
}

async function deleteProduct(store, token, productId) {
  const data = await gql(store, token, `
    mutation Delete($input: ProductDeleteInput!) {
      productDelete(input: $input) { deletedProductId userErrors { field message } }
    }`, { input: { id: productId } });
  throwOnUserErrors(data.productDelete, 'product delete');
  return { deletedProductId: data.productDelete.deletedProductId };
}

export default async function handler(req, res) {
  const store = process.env.SHOPIFY_STORE;
  const { token, source: tokenSource } = await resolveToken();

  // Read-only health check — safe to open in a browser at /api/shopify. Verifies
  // the GraphQL endpoint, token, and scope by querying the shop.
  if (req.method === 'GET') {
    const apiKey = process.env.SHOPIFY_API_KEY || process.env.SHOPIFY_CLIENT_ID;
    const apiSecret = process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
    const out = {
      api: 'graphql',
      configured: !!(store && token),
      store: store || null,
      tokenSource,
      tokenPrefix: token ? token.slice(0, 6) + '…' : null,
      tokenLength: token ? token.length : 0,
      oauth: { storeSet: !!store, apiKeySet: !!apiKey, apiSecretSet: !!apiSecret, ready: !!(store && apiKey && apiSecret) },
    };
    if (out.configured) {
      try {
        const data = await gql(store, token, `{ shop { name myshopifyDomain } }`, {});
        out.ok = true;
        out.shopName = data.shop?.name || null;
      } catch (e) { out.ok = false; out.shopError = String(e?.message || e).slice(0, 400); }
    }
    return res.status(200).json(out);
  }

  if (req.method !== 'POST') return res.status(405).end();

  const { action } = req.body || {};
  if (!store || !token) return res.status(500).json({ error: 'Shopify not configured' });
  if (action === 'debug') return res.status(200).json({ store, tokenPrefix: token.slice(0, 8) + '...' });

  try {
    if (action === 'create') {
      return res.status(200).json(await createProduct(store, token, req.body));
    } else if (action === 'update') {
      if (!req.body.productId) return res.status(400).json({ error: 'productId required for update' });
      return res.status(200).json(await updateProduct(store, token, req.body));
    } else if (action === 'delete') {
      if (!req.body.productId) return res.status(400).json({ error: 'productId required for delete' });
      return res.status(200).json(await deleteProduct(store, token, req.body.productId));
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
