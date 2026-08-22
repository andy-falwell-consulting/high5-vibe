// QBO → Redis mirror of sales transactions for the Transactions page:
// Invoice, Estimate, CreditMemo, SalesReceipt (Shopify orders land in QBO as
// SalesReceipts). Normalizes each to a common shape and stores it in a Redis
// hash so the page can list/filter/sort fast. Resumable + time-bounded per run:
// per-type backfill, then incremental via LastUpdatedTime. Read via txn-list.
//
// GET/POST /api/txn-sync?db=High5_Core4            run a sync slice
// GET      /api/txn-sync?db=High5_Core4&count=1    just COUNT(*) per type
// POST     /api/txn-sync?db=High5_Core4&reset=1    start the backfill again
// POST     /api/txn-sync?db=High5_Core4&lob=1       recompute line-of-business
//                                                   from stored lines, no QBO
//
// TWO HASHES SINCE v1.0.505. The row and its line items are stored separately
// (see api/_txnNormalize.js): the ledger list reads every row and needs none of
// the lines, and shipping them was 62% of a 21 MB read on every load.
//
// `reset=1` is how the split and the newly-captured source fields reach records
// that were mirrored under the old shape — it puts every type back into
// backfill so the next runs rewrite all 34,452. Reads stay correct throughout,
// because api/transactions.js understands both shapes.
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { qboQuery } from './_qbo.js';
import { normalizeRow, normalizeLines, TYPES } from './_txnNormalize.js';
import { lineOfBusiness } from './_txnSource.js';

export const config = { maxDuration: 300 };

const redis = Redis.fromEnv();
const SYNC_KEY = process.env.QBO_SYNC_KEY;
const PAGE = 300;

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  const cron = process.env.CRON_SECRET;
  if (cron && req.headers.authorization === `Bearer ${cron}`) return true;
  return !!(await getGoogleSession(req));
}

const recsKey = db => `txn:${db}:recs`;
const linesKey = db => `txn:${db}:lines`;
const metaKey = db => `txn:${db}:meta`;

async function getMeta(db) {
  const m = (await redis.get(metaKey(db))) || {};
  for (const t of TYPES) m[t] = m[t] || { phase: 'backfill', cursor: 1, hwm: '', count: 0 };
  return m;
}

async function storeBatch(db, type, rows) {
  if (!rows.length) return;
  const recs = {};
  const lines = {};
  const empty = [];
  for (const e of rows) {
    const key = `${type}:${e.Id}`;
    const li = normalizeLines(e);
    const row = normalizeRow(type, e);
    // Computed here and STORED, unlike origin which is derived at read time.
    // Its input is the line items, and those live in a hash the ledger list
    // deliberately does not read — deriving it later would mean reading them
    // back and undoing the saving that separation exists for.
    const lob = lineOfBusiness(li);
    if (lob) row.lob = lob;
    recs[key] = JSON.stringify(row);
    // A transaction whose lines have gone must not keep the old ones: this runs
    // again over records that already exist, so an edit that removed every line
    // has to remove them here too.
    if (li.length) lines[key] = JSON.stringify(li);
    else empty.push(key);
  }
  await redis.hset(recsKey(db), recs);
  if (Object.keys(lines).length) await redis.hset(linesKey(db), lines);
  if (empty.length) await redis.hdel(linesKey(db), ...empty);
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

    // Recompute the stored line of business from the lines already mirrored.
    // Touches QuickBooks not at all — it reads one hash and patches the other —
    // so a change to the classification rules costs a fraction of a re-sync.
    // Resumable on its own HSCAN cursor.
    if (req.query?.lob) {
      const startedAt = Date.now();
      let cursor = String(req.query.cursor ?? '0');
      let seen = 0, set = 0, cleared = 0;
      do {
        const [next, flat] = await redis.hscan(linesKey(db), cursor, { count: 400 });
        const patch = {};
        for (let i = 0; i < flat.length; i += 2) {
          const key = String(flat[i]);
          const lines = typeof flat[i + 1] === 'string' ? JSON.parse(flat[i + 1]) : flat[i + 1];
          const raw = await redis.hget(recsKey(db), key);
          if (!raw) continue;
          const row = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const lob = lineOfBusiness(lines || []);
          seen++;
          if (lob === (row.lob || null)) continue;
          if (lob) { row.lob = lob; set++; } else { delete row.lob; cleared++; }
          patch[key] = JSON.stringify(row);
        }
        if (Object.keys(patch).length) await redis.hset(recsKey(db), patch);
        cursor = String(next);
      } while (cursor !== '0' && Date.now() - startedAt < 240000);
      return res.status(200).json({ db, lob: true, seen, set, cleared, cursor, done: cursor === '0' });
    }

    const started = Date.now();
    const meta = await getMeta(db);

    const only = req.query?.type && TYPES.includes(req.query.type) ? [req.query.type] : TYPES;

    // Rewrite existing records under the current shape. Deliberately explicit —
    // it re-reads every record of the chosen types from QuickBooks over the
    // following runs, so a stray request must not be able to start it.
    //
    // Honours `type`, so the change can be proved on one type before the other
    // three follow: CreditMemo is 1,443 records against Invoice's 18,440.
    if (req.query?.reset) {
      for (const t of only) meta[t] = { phase: 'backfill', cursor: 1, hwm: '', count: 0 };
      await redis.set(metaKey(db), meta);
    }

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
    const [total, storedLines] = await Promise.all([redis.hlen(recsKey(db)), redis.hlen(linesKey(db))]);
    return res.status(200).json({ db, done: TYPES.every(t => meta[t].phase !== 'backfill'), stored: total, storedLines, types: summary });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
