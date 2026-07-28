// Full QBO item catalog (read-only) — used to plan/drive product→item
// reconciliation. GET ?env=production
import { getGoogleSession } from './_googleSession.js';
import { qboQuery, getAccessToken, qboBase } from './_qbo.js';

export const config = { maxDuration: 60 };

const SYNC_KEY = process.env.QBO_SYNC_KEY;
async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}

// Raw probe: SELECT * FROM Item at a chosen minorversion, so we can see EVERY
// field the API returns (incl. Sku) and count how many items carry a Sku.
// GET ?raw=1&mv=75&limit=5
async function rawProbe(env, mv, limit) {
  const token = await getAccessToken(env);
  const q = sql => fetch(`${qboBase(env)}/query?query=${encodeURIComponent(sql)}&minorversion=${mv}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }).then(r => r.json());
  const sample = (await q(`SELECT * FROM Item MAXRESULTS ${limit}`))?.QueryResponse?.Item || [];
  let withSku = 0, scanned = 0;
  for (let pos = 1, guard = 0; guard < 40; guard++) {
    const page = (await q(`SELECT * FROM Item STARTPOSITION ${pos} MAXRESULTS 1000`))?.QueryResponse?.Item || [];
    scanned += page.length;
    withSku += page.filter(i => String(i.Sku ?? '').trim()).length;
    if (page.length < 1000) break;
    pos += page.length;
  }
  return { mv, scanned, withSku, sampleKeys: sample[0] ? Object.keys(sample[0]) : [], sample };
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const env = req.query?.env === 'sandbox' ? 'sandbox' : 'production';
  if (req.query?.raw === '1') {
    try { return res.status(200).json(await rawProbe(env, Number(req.query?.mv || 75), Number(req.query?.limit || 3))); }
    catch (e) { return res.status(502).json({ error: String(e?.message || e).slice(0, 600) }); }
  }
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
