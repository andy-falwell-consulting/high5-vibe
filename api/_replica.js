// Server-side FileMaker → Redis read replica.
//
// FileMaker's Data API is far too slow to load big layouts on demand (a cold
// full load of Contacts is ~30 min). This mirrors heavy layouts into Upstash
// Redis so the app can load them in one fast call. A cron drives runSync()
// (resumable backfill, then incremental modified-since); the app reads via
// readReplica(). Files starting with _ are not Vercel routes.
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const FMP_USER = 'admin';
const FMP_PASS = 'itstime';
const ALLOWED_DBS = new Set(['High5_Core4', 'High5_Core4_Stage', 'High5_Core4_Dev']);

// Layouts we replicate. `key` is the app-facing id; `layout` the FMP layout;
// `modField` a searchable modification timestamp used for incremental sync.
export const REPLICATED = {
  contacts: { layout: 'Contacts_New', modField: 'zz__Modified_On' },
};

const rk = (db, layout, suffix) => `repl:${db}:${layout}:${suffix}`;

async function fmpToken(db) {
  const r = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${db}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${FMP_USER}:${FMP_PASS}`).toString('base64') },
    body: '{}',
  });
  const j = await r.json().catch(() => ({}));
  const token = j?.response?.token;
  if (!token) throw new Error('FMP auth failed: ' + JSON.stringify(j?.messages || j));
  return token;
}

// Slim a record for the list: keep fieldData, drop the heavy portalData (the
// detail view re-fetches the full record on open).
const slim = r => JSON.stringify({ recordId: r.recordId, fieldData: r.fieldData });

// FileMaker timestamp "MM/DD/YYYY HH:MM:SS" → ms (server-local, good enough for
// an incremental high-water mark with a safety buffer).
function fmTs(v) {
  if (!v) return 0;
  const [d, t = '00:00:00'] = String(v).split(' ');
  const [mo, da, yr] = d.split('/');
  if (!yr) return 0;
  return new Date(`${yr}-${mo}-${da}T${t}`).getTime() || 0;
}
const pad = n => String(n).padStart(2, '0');
const toFmDate = ms => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`; };

async function getMeta(db, layout) {
  return (await redis.get(rk(db, layout, 'meta'))) || { phase: 'backfill', cursor: 1, total: null, count: 0, lastModifiedMs: 0, lastSync: 0 };
}

// Run one bounded sync slice. Returns the updated meta. Safe to call repeatedly
// (cron); resumes a backfill, then switches to incremental.
export async function runSync(db, key, budgetMs = 260000) {
  if (!ALLOWED_DBS.has(db)) throw new Error('db not allowed');
  const cfg = REPLICATED[key];
  if (!cfg) throw new Error('layout not replicated: ' + key);
  const { layout, modField } = cfg;
  const started = Date.now();
  const token = await fmpToken(db);
  const meta = await getMeta(db, layout);

  if (meta.phase === 'backfill') {
    while (Date.now() - started < budgetMs) {
      const res = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${encodeURIComponent(layout)}/records?_limit=100&_offset=${meta.cursor}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await res.json().catch(() => ({}));
      const data = j?.response?.data || [];
      if (meta.total == null) meta.total = j?.response?.dataInfo?.foundCount ?? 0;
      if (!data.length) { meta.phase = 'idle'; break; }
      const entries = {};
      for (const r of data) {
        entries[r.recordId] = slim(r);
        const ts = fmTs(r.fieldData?.[modField]);
        if (ts > meta.lastModifiedMs) meta.lastModifiedMs = ts;
      }
      await redis.hset(rk(db, layout, 'recs'), entries);
      meta.cursor += data.length;
      meta.count += data.length;
      // Persist progress every page so a killed slice resumes instead of restarting.
      await redis.set(rk(db, layout, 'meta'), meta);
      if (meta.count >= meta.total) { meta.phase = 'idle'; break; }
    }
  } else {
    // Incremental: pull records modified since the high-water mark (minus a day
    // of slop), upsert them. Idempotent. (Deletions handled by a separate
    // reconcile — not yet implemented.)
    const sinceMs = meta.lastModifiedMs ? meta.lastModifiedMs - 24 * 3600 * 1000 : Date.now() - 7 * 24 * 3600 * 1000;
    const query = [{ [modField]: `>=${toFmDate(sinceMs)}` }];
    let offset = 1;
    while (Date.now() - started < budgetMs) {
      const res = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${encodeURIComponent(layout)}/_find`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, limit: 100, offset }),
      });
      const j = await res.json().catch(() => ({}));
      const code = j?.messages?.[0]?.code;
      if (code === '401') break; // no records modified — nothing to do
      const data = j?.response?.data || [];
      if (!data.length) break;
      const entries = {};
      for (const r of data) {
        entries[r.recordId] = slim(r);
        const ts = fmTs(r.fieldData?.[modField]);
        if (ts > meta.lastModifiedMs) meta.lastModifiedMs = ts;
      }
      await redis.hset(rk(db, layout, 'recs'), entries);
      offset += data.length;
      if (data.length < 100) break;
    }
    meta.count = await redis.hlen(rk(db, layout, 'recs'));
  }

  meta.lastSync = Date.now();
  await redis.set(rk(db, layout, 'meta'), meta);
  return meta;
}

// Cursor-paged read (HSCAN) so each HTTP response stays well under Vercel's
// ~4.5MB body limit. Client starts at cursor '0' and loops until '0' returns.
export async function scanReplica(db, key, cursor = '0', count = 1500) {
  const cfg = REPLICATED[key];
  if (!cfg) throw new Error('layout not replicated: ' + key);
  const [next, flat] = await redis.hscan(rk(db, cfg.layout, 'recs'), cursor, { count });
  const records = [];
  for (let i = 1; i < flat.length; i += 2) {
    const v = flat[i];
    records.push(typeof v === 'string' ? JSON.parse(v) : v);
  }
  return { cursor: String(next), records };
}

export async function getMetaPublic(db, key) {
  const cfg = REPLICATED[key];
  if (!cfg) return null;
  return (await redis.get(rk(db, cfg.layout, 'meta'))) || null;
}
