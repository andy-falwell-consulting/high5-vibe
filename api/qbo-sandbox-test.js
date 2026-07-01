// Read-only sandbox connectivity check. Confirms the QBO_SANDBOX_* creds +
// realm work by reading the sandbox company and a few customers. No writes.
// GET /api/qbo-sandbox-test  (gated: sync key or Google session)
import { getGoogleSession } from './_googleSession.js';
import { qboQuery, qboBase } from './_qbo.js';

const SYNC_KEY = process.env.QBO_SYNC_KEY;
async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const present = {
    QBO_SANDBOX_CLIENT_ID: !!process.env.QBO_SANDBOX_CLIENT_ID,
    QBO_SANDBOX_CLIENT_SECRET: !!process.env.QBO_SANDBOX_CLIENT_SECRET,
    QBO_SANDBOX_REALM_ID: !!process.env.QBO_SANDBOX_REALM_ID,
    QBO_SANDBOX_REFRESH_TOKEN: !!process.env.QBO_SANDBOX_REFRESH_TOKEN,
  };
  try {
    const ci = await qboQuery('SELECT * FROM CompanyInfo', 'sandbox');
    const cust = await qboQuery('SELECT Id, DisplayName FROM Customer ORDERBY Id MAXRESULTS 5', 'sandbox');
    return res.status(200).json({
      ok: true,
      base: qboBase('sandbox'),
      envPresent: present,
      company: ci.CompanyInfo?.[0]?.CompanyName ?? null,
      country: ci.CompanyInfo?.[0]?.Country ?? null,
      customerSample: (cust.Customer || []).map(c => ({ id: c.Id, name: c.DisplayName })),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, base: qboBase('sandbox'), envPresent: present, error: String(e?.message || e).slice(0, 500) });
  }
}
