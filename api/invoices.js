// One contact's invoice history — PHASE B4. READ ONLY.
//
//   GET /api/invoices?db=…&contactId=69026
//
// No write path, deliberately: nothing in the app writes invoices. Live
// invoicing happens in QuickBooks and surfaces through the Transactions module;
// this is the historical record that would otherwise be lost with FileMaker.
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { readInvoices, sortInvoices } from './_invoices.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!(await getGoogleSession(req))) return res.status(401).json({ error: 'Not authenticated' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  const contactId = String(req.query?.contactId || '').trim();
  if (!contactId) return res.status(400).json({ error: 'contactId required' });

  try {
    const invoices = sortInvoices(await readInvoices(db, contactId));
    const total = invoices.reduce((a, i) => a + (Number(i.total) || 0), 0);
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({
      contactId, invoices, count: invoices.length,
      billedTotal: Math.round(total * 100) / 100,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
