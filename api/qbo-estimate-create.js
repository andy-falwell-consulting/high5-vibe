// Create (or delete) a QBO Estimate. env-aware — writes to sandbox or production.
//   GET  ?env=sandbox&peek=1        → a few customers + items (to pick test refs)
//   POST { env, customerId, lines:[{itemId,qty,unitPrice,amount,description}], txnDate, memo, docNumber }
//   POST { env, action:'delete', id, syncToken }
import { getGoogleSession } from './_googleSession.js';
import { qboRequest, qboQuery } from './_qbo.js';

const SYNC_KEY = process.env.QBO_SYNC_KEY;
async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}
const envOf = v => (v === 'sandbox' ? 'sandbox' : 'production');

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });

  if (req.method === 'GET') {
    const env = envOf(req.query?.env);
    if (!req.query?.peek) return res.status(400).json({ error: 'peek=1 required for GET' });
    const cust = await qboQuery('SELECT Id, DisplayName FROM Customer ORDERBY Id MAXRESULTS 5', env);
    const item = await qboQuery('SELECT Id, Name, Type FROM Item ORDERBY Id MAXRESULTS 8', env);
    return res.status(200).json({
      env,
      customers: (cust.Customer || []).map(c => ({ id: c.Id, name: c.DisplayName })),
      items: (item.Item || []).map(i => ({ id: i.Id, name: i.Name, type: i.Type })),
    });
  }

  if (req.method !== 'POST') return res.status(405).end();
  const env = envOf(req.body?.env);

  try {
    if (req.body?.action === 'delete') {
      const { id, syncToken } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });
      const data = await qboRequest('/estimate?operation=delete', 'POST', { Id: String(id), SyncToken: String(syncToken ?? '0') }, env);
      return res.status(200).json({ ok: true, deleted: data.Estimate?.Id || id });
    }

    const { customerId, lines = [], txnDate, memo, docNumber } = req.body || {};
    if (!customerId || !lines.length) return res.status(400).json({ error: 'customerId and at least one line required' });

    const Line = lines.map(l => ({
      DetailType: 'SalesItemLineDetail',
      Amount: Number(l.amount ?? (Number(l.qty || 1) * Number(l.unitPrice || 0))),
      ...(l.description ? { Description: l.description } : {}),
      SalesItemLineDetail: {
        ItemRef: { value: String(l.itemId) },
        ...(l.qty != null ? { Qty: Number(l.qty) } : {}),
        ...(l.unitPrice != null ? { UnitPrice: Number(l.unitPrice) } : {}),
      },
    }));
    const payload = {
      CustomerRef: { value: String(customerId) },
      Line,
      ...(txnDate ? { TxnDate: txnDate } : {}),
      ...(memo ? { CustomerMemo: { value: memo } } : {}),
      ...(docNumber ? { DocNumber: String(docNumber) } : {}),
    };
    const data = await qboRequest('/estimate', 'POST', payload, env);
    const e = data.Estimate || {};
    return res.status(200).json({ ok: true, env, id: e.Id, docNumber: e.DocNumber, total: e.TotalAmt, syncToken: e.SyncToken, customer: e.CustomerRef?.name });
  } catch (err) {
    return res.status(502).json({ ok: false, error: String(err?.message || err).slice(0, 600) });
  }
}
