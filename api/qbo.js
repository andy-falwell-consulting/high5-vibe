import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';

const redis = Redis.fromEnv();

// Auth gate: a logged-in user (Google session cookie) OR a server job presenting
// the sync key (x-sync-key header / ?key=, matched against QBO_SYNC_KEY). The
// key path is disabled unless the env var is set.
const SYNC_KEY = process.env.QBO_SYNC_KEY;
async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}
const REALM_ID = process.env.QBO_REALM_ID;
const CLIENT_ID = process.env.QBO_CLIENT_ID;
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;
const QBO_BASE = `https://quickbooks.api.intuit.com/v3/company/${REALM_ID}`;

async function getAccessToken() {
  // Try cached access token first (TTL 55 min)
  const cached = await redis.get('qbo_access_token');
  if (cached) return cached;

  // Get current refresh token (KV takes precedence over env var)
  const refreshToken = (await redis.get('qbo_refresh_token')) || process.env.QBO_REFRESH_TOKEN;

  const resp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });

  const tokens = await resp.json();
  if (!resp.ok || !tokens.access_token) {
    throw new Error(`QBO token refresh failed: ${JSON.stringify(tokens)}`);
  }

  // Persist rotated refresh token and cache access token
  await redis.set('qbo_refresh_token', tokens.refresh_token, { ex: 86400 * 90 });
  await redis.set('qbo_access_token', tokens.access_token, { ex: 55 * 60 });

  return tokens.access_token;
}

async function qboRequest(path, method, body) {
  const token = await getAccessToken();
  const resp = await fetch(`${QBO_BASE}${path}?minorversion=65`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });

  const { action, item, itemId } = req.body;

  try {
    if (action === 'create') {
      const data = await qboRequest('/item', 'POST', item);
      return res.status(200).json(data);
    }

    if (action === 'update') {
      if (!itemId) return res.status(400).json({ error: 'itemId required' });
      // QBO requires SyncToken for optimistic locking — fetch it first
      const existing = await qboRequest(`/item/${itemId}`, 'GET');
      const syncToken = existing.Item?.SyncToken;
      const updated = await qboRequest('/item', 'POST', { ...item, Id: itemId, SyncToken: syncToken, sparse: true });
      return res.status(200).json(updated);
    }

    // Read-only: fetch an invoice by QBO Id, or by DocNumber (ref #).
    if (action === 'get-invoice') {
      const { invoiceId, docNumber } = req.body;
      if (invoiceId) {
        const data = await qboRequest(`/invoice/${invoiceId}`, 'GET');
        return res.status(200).json(data);
      }
      if (docNumber) {
        const token = await getAccessToken();
        const q = `SELECT * FROM Invoice WHERE DocNumber = '${String(docNumber).replace(/'/g, "\\'")}'`;
        const r = await fetch(`${QBO_BASE}/query?query=${encodeURIComponent(q)}&minorversion=65`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        const data = await r.json();
        return res.status(r.ok ? 200 : r.status).json(data);
      }
      return res.status(400).json({ error: 'invoiceId or docNumber required' });
    }

    // Read-only: page the QBO customer list (slim) for reconciliation.
    if (action === 'list-customers') {
      const token = await getAccessToken();
      const start = Number(req.body.start) || 1;
      const max = Math.min(Number(req.body.max) || 1000, 1000);
      const q = `SELECT * FROM Customer STARTPOSITION ${start} MAXRESULTS ${max}`;
      const r = await fetch(`${QBO_BASE}/query?query=${encodeURIComponent(q)}&minorversion=65`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);
      const customers = (data.QueryResponse?.Customer || []).map(c => ({
        id: c.Id, displayName: c.DisplayName, companyName: c.CompanyName,
        fullyQualifiedName: c.FullyQualifiedName, email: c.PrimaryEmailAddr?.Address,
        active: c.Active, city: c.BillAddr?.City, state: c.BillAddr?.CountrySubDivisionCode, job: c.Job,
      }));
      return res.status(200).json({ customers, count: customers.length, start });
    }

    // Read-only: page the QBO invoice list (slim) — DocNumber + customer + totals.
    if (action === 'list-invoices') {
      const token = await getAccessToken();
      const start = Number(req.body.start) || 1;
      const max = Math.min(Number(req.body.max) || 1000, 1000);
      const q = `SELECT * FROM Invoice STARTPOSITION ${start} MAXRESULTS ${max}`;
      const r = await fetch(`${QBO_BASE}/query?query=${encodeURIComponent(q)}&minorversion=65`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);
      const invoices = (data.QueryResponse?.Invoice || []).map(i => ({
        id: i.Id, docNumber: i.DocNumber, customerId: i.CustomerRef?.value,
        customerName: i.CustomerRef?.name, txnDate: i.TxnDate, total: i.TotalAmt,
        balance: i.Balance, updated: i.MetaData?.LastUpdatedTime,
      }));
      return res.status(200).json({ invoices, count: invoices.length, start });
    }

    // Read-only: fetch the styled invoice PDF (base64). The real feature will
    // stream this into a FileMaker container; here it validates access + format.
    if (action === 'invoice-pdf') {
      const { invoiceId } = req.body;
      if (!invoiceId) return res.status(400).json({ error: 'invoiceId required' });
      const token = await getAccessToken();
      const r = await fetch(`${QBO_BASE}/invoice/${invoiceId}/pdf?minorversion=65`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf' },
      });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const buf = Buffer.from(await r.arrayBuffer());
      const out = { ok: true, size: buf.length, isPdf: buf.slice(0, 5).toString('latin1').startsWith('%PDF') };
      if (req.body.base64) out.base64 = buf.toString('base64');
      return res.status(200).json(out);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('QBO error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
