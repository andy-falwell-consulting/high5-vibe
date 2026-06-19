export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { action, productId, product } = req.body;
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;

  if (!store || !token) return res.status(500).json({ error: 'Shopify not configured' });
  if (action === 'debug') return res.status(200).json({ store, tokenPrefix: token.slice(0, 8) + '...' });


  const base = `https://${store}/admin/api/2024-01`;
  const headers = {
    'X-Shopify-Access-Token': token,
    'Content-Type': 'application/json',
  };

  try {
    let upstream;

    if (action === 'create') {
      upstream = await fetch(`${base}/products.json`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ product }),
      });
    } else if (action === 'update') {
      if (!productId) return res.status(400).json({ error: 'productId required for update' });
      upstream = await fetch(`${base}/products/${productId}.json`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ product }),
      });
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }

    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(data);
    console.log('Shopify response variants:', JSON.stringify(data.product?.variants?.map(v => ({ id: v.id, sku: v.sku })) ?? []));
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
