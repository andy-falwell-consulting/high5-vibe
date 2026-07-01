// Live QBO customer search for the Create-in-QBO customer picker.
//   GET /api/qbo-customer-search?env=production&q=academy
import { getGoogleSession } from './_googleSession.js';
import { qboQuery } from './_qbo.js';

export const config = { maxDuration: 30 };

const SYNC_KEY = process.env.QBO_SYNC_KEY;
async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}
const esc = s => String(s == null ? '' : s).replace(/'/g, "\\'").trim();

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const env = req.query?.env === 'sandbox' ? 'sandbox' : 'production';
  const q = String(req.query?.q || '').trim();
  if (q.length < 2) return res.status(200).json({ customers: [] });
  try {
    const m = (await qboQuery(`SELECT Id, DisplayName FROM Customer WHERE DisplayName LIKE '%${esc(q)}%' ORDERBY DisplayName MAXRESULTS 20`, env)).Customer || [];
    return res.status(200).json({ customers: m.map(c => ({ id: c.Id, name: c.DisplayName })) });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
