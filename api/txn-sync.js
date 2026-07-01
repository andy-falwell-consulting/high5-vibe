// QBO → Redis mirror of sales transactions for the Transactions page:
// Invoice, Estimate, CreditMemo, SalesReceipt (Shopify orders land in QBO as
// SalesReceipts). Normalizes each to a common shape and stores it in a Redis
// hash so the page can list/filter/sort fast. Resumable + time-bounded per run:
// per-type backfill, then incremental via LastUpdatedTime. Read via txn-list.
//
// GET/POST /api/txn-sync?db=High5_Core4            run a sync slice
// GET      /api/txn-sync?db=High5_Core4&count=1    just COUNT(*) per type
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { qboQuery } from './_qbo.js';

export const config = { maxDuration: 300 };

const redis = Redis.fromEnv();
const SYNC_KEY = process.env.QBO_SYNC_KEY;
const TYPES = ['Invoice', 'Estimate', 'CreditMemo', 'SalesReceipt'];
const PAGE = 300;

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  const cron = process.env.CRON_SECRET;
  if (cron && req.headers.authorization === `Bearer ${cron}`) return true;
  return !!(await getGoogleSession(req));
}

const recsKey = db => `txn:${db}:recs`;
const metaKey = db => `txn:${db}:meta`;
const today = () => new Date().toISOString().slice(0, 10);

async function getMeta(db) {
  const m = (await redis.get(metaKey(db))) || {};
  for (const t of TYPES) m[t] = m[t] || { phase: 'backfill', cursor: 1, hwm: '', count: 0 };
  return m;
}

function normalize(type, e) {
  const lines = (e.Line || [])
    .filter(l => l.DetailType === 'SalesItemLineDetail')
    .map(l => ({
      desc: l.Description || l.SalesItemLineDetail?.ItemRef?.name || '',
      qty: l.SalesItemLineDetail?.Qty ?? null,
      amount: Number(l.Amount || 0),
      item: l.SalesItemLineDetail?.ItemRef?.name || '',
    }));
  const total = Number(e.TotalAmt || 0);
  const balance = e.Balance != null ? Number(e.Balance) : 0;
  let status;
  if (type === 'Invoice') status = balance <= 0 ? 'Paid' : (e.DueDate && e.DueDate < today() ? 'Overdue' : 'Open');
  else if (type === 'Estimate') status = e.TxnStatus || 'Pending';
  else if (type === 'CreditMemo') status = balance > 0 ? 'Unapplied' : 'Applied';
  else status = 'Paid'; // SalesReceipt
  return {
    type, id: String(e.Id), docNumber: e.DocNumber || '',
    customerId: e.CustomerRef?.value || '', customerName: e.CustomerRef?.name || '',
    date: e.TxnDate || '', dueDate: e.DueDate || '',
    total, balance, status,
    currency: e.CurrencyRef?.value || 'USD',
    updated: e.MetaData?.LastUpdatedTime || '',
    lines,
  };
}

async function storeBatch(db, type, rows) {
  if (!rows.length) return;
  const entries = {};
  for (const e of rows) entries[`${type}:${e.Id}`] = JSON.stringify(normalize(type, e));
  await redis.hset(recsKey(db), entries);
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const db = req.query?.db || req.body?.db || 'High5_Core4';

  try {
    // Fast size check — no writes.
    if (req.query?.count) {
      const out = {};
      for (const t of TYPES) {
        const qr = await qboQuery(`SELECT COUNT(*) FROM ${t}`);
        out[t] = qr.totalCount ?? 0;
      }
      return res.status(200).json({ db, counts: out });
    }

    const started = Date.now();
    const meta = await getMeta(db);
    const only = req.query?.type && TYPES.includes(req.query.type) ? [req.query.type] : TYPES;

    for (const type of only) {
      const m = meta[type];
      while (Date.now() - started < 260000) {
        if (m.phase === 'backfill') {
          const qr = await qboQuery(`SELECT * FROM ${type} ORDERBY Id STARTPOSITION ${m.cursor} MAXRESULTS ${PAGE}`);
          const rows = qr[type] || [];
          await storeBatch(db, type, rows);
          for (const e of rows) { const u = e.MetaData?.LastUpdatedTime; if (u && u > m.hwm) m.hwm = u; }
          m.cursor += rows.length; m.count += rows.length;
          await redis.set(metaKey(db), meta);
          if (rows.length < PAGE) { m.phase = 'idle'; break; }
        } else {
          // incremental: records changed since the high-water mark
          const where = m.hwm ? ` WHERE MetaData.LastUpdatedTime > '${m.hwm}'` : '';
          const qr = await qboQuery(`SELECT * FROM ${type}${where} ORDERBY MetaData.LastUpdatedTime STARTPOSITION 1 MAXRESULTS ${PAGE}`);
          const rows = qr[type] || [];
          await storeBatch(db, type, rows);
          for (const e of rows) { const u = e.MetaData?.LastUpdatedTime; if (u && u > m.hwm) m.hwm = u; }
          await redis.set(metaKey(db), meta);
          break; // one incremental page per type per run
        }
      }
    }

    meta.lastSync = Date.now();
    await redis.set(metaKey(db), meta);
    const summary = Object.fromEntries(TYPES.map(t => [t, { phase: meta[t].phase, count: meta[t].count }]));
    const total = await redis.hlen(recsKey(db));
    return res.status(200).json({ db, done: TYPES.every(t => meta[t].phase !== 'backfill'), stored: total, types: summary });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
