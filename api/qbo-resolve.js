// Resolve a customer name + line item names to QBO ids for the shared
// "Create in QBO" panel. Per line: prefer the product's stored link
// (_kat__Item_ID_QuickBooks); otherwise offer QBO candidates by name so the
// user can pick (and the pick is remembered onto the product).
//   POST { env, customerName, itemNames: [] }
import { getGoogleSession } from './_googleSession.js';
import { qboQuery } from './_qbo.js';
import { fmpToken, fmFind } from './_fmp.js';

export const config = { maxDuration: 60 };

const SYNC_KEY = process.env.QBO_SYNC_KEY;
const FMP_DB = 'High5_Core4';
async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}
const esc = s => String(s == null ? '' : s).replace(/'/g, "\\'").trim();
const envOf = v => (v === 'sandbox' ? 'sandbox' : 'production');

async function matchCustomer(name, env) {
  if (!name) return [];
  const stripped = name.replace(/\s*\([^)]*\)\s*$/, '').trim(); // drop a trailing "(CREC)"
  for (const nm of [name, stripped].filter((v, i, a) => v && a.indexOf(v) === i)) {
    const m = (await qboQuery(`SELECT Id, DisplayName FROM Customer WHERE DisplayName = '${esc(nm)}'`, env)).Customer || [];
    if (m.length) return m.map(c => ({ id: c.Id, name: c.DisplayName }));
  }
  let m = (await qboQuery(`SELECT Id, DisplayName FROM Customer WHERE DisplayName LIKE '%${esc(stripped || name)}%' MAXRESULTS 8`, env)).Customer || [];
  if (!m.length) {
    const firstWords = (stripped || name).split(/\s+/).slice(0, 3).join(' ');
    m = (await qboQuery(`SELECT Id, DisplayName FROM Customer WHERE DisplayName LIKE '%${esc(firstWords)}%' MAXRESULTS 8`, env)).Customer || [];
  }
  return m.map(c => ({ id: c.Id, name: c.DisplayName }));
}
async function candItems(name, env) {
  if (!name) return [];
  let m = (await qboQuery(`SELECT Id, Name, FullyQualifiedName FROM Item WHERE Name = '${esc(name)}'`, env)).Item || [];
  if (!m.length) m = (await qboQuery(`SELECT Id, Name, FullyQualifiedName FROM Item WHERE Name LIKE '%${esc(name)}%' MAXRESULTS 5`, env)).Item || [];
  return m.map(i => ({ id: i.Id, name: i.FullyQualifiedName || i.Name }));
}
async function itemName(id, env) {
  const m = (await qboQuery(`SELECT Id, FullyQualifiedName FROM Item WHERE Id = '${esc(id)}'`, env)).Item || [];
  return m[0]?.FullyQualifiedName || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const { env: e, customerName, itemNames = [] } = req.body || {};
  const env = envOf(e);
  try {
    const fmTok = await fmpToken(FMP_DB);
    // Resolve customer + all lines in parallel (sequential was timing out).
    const [custMatches, items] = await Promise.all([
      matchCustomer(customerName, env),
      Promise.all(itemNames.map(async name => {
        const prod = name ? (await fmFind(FMP_DB, 'Products & Services_New', [{ Name: `==${esc(name)}` }], fmTok, 1))[0] : null;
        const productRecordId = prod?.recordId || null;
        const linkedId = prod?.fieldData?._kat__Item_ID_QuickBooks || null;
        let matched = null, candidates = [];
        if (linkedId) {
          matched = { id: String(linkedId), name: (await itemName(linkedId, env)) || `#${linkedId}`, linked: true };
        } else {
          candidates = await candItems(name, env);
          matched = candidates[0] || null;
        }
        return { query: name, productRecordId, matched, candidates };
      })),
    ]);
    return res.status(200).json({
      env,
      customer: { query: customerName, matched: custMatches[0] || null, matches: custMatches },
      items,
    });
  } catch (err) {
    return res.status(502).json({ error: String(err?.message || err).slice(0, 500) });
  }
}
