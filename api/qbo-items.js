// Full QBO item catalog (read-only) — used to plan/drive product→item
// reconciliation. GET ?env=production
import { getGoogleSession } from './_googleSession.js';
import { qboQuery } from './_qbo.js';

export const config = { maxDuration: 60 };

const SYNC_KEY = process.env.QBO_SYNC_KEY;
async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const env = req.query?.env === 'sandbox' ? 'sandbox' : 'production';
  try {
    let items = [], pos = 1;
    for (let guard = 0; guard < 20; guard++) {
      const page = (await qboQuery(`SELECT Id, Name, FullyQualifiedName, Type, Active FROM Item STARTPOSITION ${pos} MAXRESULTS 1000`, env)).Item || [];
      items.push(...page);
      if (page.length < 1000) break;
      pos += page.length;
    }
    return res.status(200).json({
      env,
      count: items.length,
      items: items.map(i => ({ id: i.Id, name: i.FullyQualifiedName || i.Name, type: i.Type, active: i.Active })),
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 500) });
  }
}
