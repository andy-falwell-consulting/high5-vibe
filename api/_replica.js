// Server-side FileMaker → Redis read replica.
//
// FileMaker's Data API is far too slow to load big layouts on demand (a cold
// full load of Contacts is ~30 min). This mirrors heavy layouts into Upstash
// Redis so the app can load them in one fast call. A cron drives runSync()
// (resumable backfill, then incremental modified-since); the app reads via
// readReplica(). Files starting with _ are not Vercel routes.
import { Redis } from '@upstash/redis';
import { readOverlay, applyOverlay, VIBE_OWNED, recordShadowed, changeKey } from './_vibeStore.js';

const redis = Redis.fromEnv();
const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const FMP_USER = 'admin';
const FMP_PASS = 'itstime';
const ALLOWED_DBS = new Set(['High5_Core4', 'High5_Core4_Stage', 'High5_Core4_Dev']);

// Layouts we replicate. `key` is the app-facing id; `layout` the FMP layout.
// Two kinds:
//  - incremental: has a searchable `modField` (modification timestamp). Backfill
//    once, then pull only records modified since the high-water mark.
//  - snapshot: no usable modification field, so we can't sync incrementally.
//    Backfill, then re-page the whole layout every `refreshMs` (small, rarely
//    changing reference/catalog data).
export const REPLICATED = {
  contacts:    { layout: 'Contacts_New',            modField: 'zz__Modified_On' },
  estimates:   { layout: 'Estimates_New',           modField: 'zz__Modified_On' },
  inspections: { layout: 'Inspections_New',         modField: 'zz__Modified_On' },
  trainings:   { layout: 'trainings_New',           modField: 'zz__Modified_On' },
  rmi:         { layout: 'RMI_New',                 modField: 'zz__Modified_On' },
  projects:    { layout: 'RCD_New',                 modField: 'zz__Modified_On' },
  oelookup:    { layout: 'OELookup_New',            snapshot: true, refreshMs: 6 * 3600 * 1000 },
  products:    { layout: 'Products & Services_New', modField: 'zz__Modified_On' },
};

const rk = (db, layout, suffix) => `repl:${db}:${layout}:${suffix}`;

// Record a page of writes in the change index. ZADD takes them all in one
// command, so indexing a 100-record page costs one round trip rather than 100.
async function indexBatch(db, layout, stamps) {
  if (!stamps.length) return;
  try {
    await redis.zadd(changeKey(db, layout), ...stamps.map(s => ({ score: s.at, member: String(s.id) })));
  } catch { /* the index is an optimisation; a miss costs a stale row, not a wrong one */ }
}


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
  const { layout, modField, snapshot, refreshMs = 6 * 3600 * 1000 } = cfg;
  const started = Date.now();
  const meta = await getMeta(db, layout);

  // Snapshot layouts can't sync incrementally (no modField). When idle, kick a
  // fresh full re-page only once the data has gone stale; otherwise no-op so we
  // don't re-page a rarely-changing layout every cron tick.
  if (snapshot && meta.phase === 'idle') {
    if (Date.now() - (meta.lastSync || 0) < refreshMs) return meta;
    meta.phase = 'backfill';
    meta.cursor = 1;
    meta.count = 0;
    meta.total = null; // re-read foundCount in case records were added/removed
  }

  const token = await fmpToken(db);

  if (meta.phase === 'backfill') {
    while (Date.now() - started < budgetMs) {
      const res = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${encodeURIComponent(layout)}/records?_limit=100&_offset=${meta.cursor}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await res.json().catch(() => ({}));
      const data = j?.response?.data || [];
      if (meta.total == null) meta.total = j?.response?.dataInfo?.foundCount ?? 0;
      if (!data.length) { meta.phase = 'idle'; break; }
      const entries = {};
      const stamps = [];
      for (const r of data) {
        entries[r.recordId] = slim(r);
        const ts = modField ? fmTs(r.fieldData?.[modField]) : 0;
        if (ts > meta.lastModifiedMs) meta.lastModifiedMs = ts;
        // FileMaker's own modification time, not now — so a client asking
        // "what changed since X" gets the truth about WHEN it changed, and a
        // backfill of old records does not look like a flood of fresh edits.
        stamps.push({ id: r.recordId, at: ts || Date.now() });
      }
      await redis.hset(rk(db, layout, 'recs'), entries);
      await indexBatch(db, layout, stamps);
      meta.cursor += data.length;
      meta.count += data.length;
      // Persist progress every page so a killed slice resumes instead of restarting.
      await redis.set(rk(db, layout, 'meta'), meta);
      if (meta.total != null && meta.count >= meta.total) { meta.phase = 'idle'; break; }
    }
  } else if (!snapshot) {
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
      // Before overwriting, note any FileMaker change to a field Vibe has
      // overridden — that change is about to become invisible under the
      // overlay, and silently losing it is the one real cost of one-way sync.
      // Only for layouts Vibe owns: everything else has no overlay to hide
      // behind, and an extra HGETALL per sync per layout is not free.
      if (VIBE_OWNED.has(layout)) {
        const overlay = await readOverlay(db, layout);
        if (overlay.size) {
          const ids = data.map(r => String(r.recordId)).filter(id => overlay.has(id));
          if (ids.length) {
            const raw = await redis.hmget(rk(db, layout, 'recs'), ...ids);
            const previous = new Map();
            ids.forEach((id, i) => {
              const v = Array.isArray(raw) ? raw[i] : raw?.[id];
              if (v) previous.set(id, typeof v === 'string' ? JSON.parse(v) : v);
            });
            await recordShadowed(db, layout, data, previous, overlay);
          }
        }
      }

      const entries = {};
      const stamps = [];
      for (const r of data) {
        entries[r.recordId] = slim(r);
        const ts = fmTs(r.fieldData?.[modField]);
        if (ts > meta.lastModifiedMs) meta.lastModifiedMs = ts;
        stamps.push({ id: r.recordId, at: ts || Date.now() });
      }
      await redis.hset(rk(db, layout, 'recs'), entries);
      await indexBatch(db, layout, stamps);
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
//
// Vibe's own edits are overlaid on the way out (see _vibeStore.js), so every
// caller — the whole app — sees merged data without knowing this layer exists.
// With an empty overlay this is a no-op and the result is byte-identical to the
// raw replica.
export async function scanReplica(db, key, cursor = '0', count = 1500) {
  const cfg = REPLICATED[key];
  if (!cfg) throw new Error('layout not replicated: ' + key);
  const [next, flat] = await redis.hscan(rk(db, cfg.layout, 'recs'), cursor, { count });
  const records = [];
  for (let i = 1; i < flat.length; i += 2) {
    const v = flat[i];
    records.push(typeof v === 'string' ? JSON.parse(v) : v);
  }
  const nextCursor = String(next);
  const overlay = await readOverlay(db, cfg.layout);
  return { cursor: nextCursor, records: applyOverlay(records, overlay, nextCursor === '0') };
}

// How much of a layout has to have changed before an incremental refresh stops
// being worth it. Above this the ZRANGE + HMGET costs more round trips than one
// clean HSCAN, so we say so and let the caller do a full pull instead.
const INCREMENTAL_MAX_SHARE = 0.3;

/** What changed in this layout since `sinceMs`.
 *
 *  The point of the whole change index: a refresh reads the records that
 *  actually moved instead of re-reading the entire hash. Contacts is 15,592
 *  records and 26 MB; on a normal day perhaps a dozen of them changed.
 *
 *  Returns `{ mode: 'incremental', records, removed, now }`, or
 *  `{ mode: 'full' }` when an incremental answer would be wrong or wasteful:
 *
 *    - no index yet (nothing has been written since this shipped)
 *    - `sinceMs` predates the index, so changes before it are unknowable
 *    - more than INCREMENTAL_MAX_SHARE of the layout changed
 *
 *  `removed` carries ids the client must DROP, which is the half an
 *  "everything that changed" list cannot express on its own: a record deleted
 *  in FileMaker is gone from the hash, and one tombstoned in Vibe is hidden by
 *  the overlay. Both are in the index — they changed — so both are detected
 *  here by their absence from the merged result rather than needing a separate
 *  deletions feed.
 */
export async function changesSince(db, key, sinceMs) {
  const cfg = REPLICATED[key];
  if (!cfg) throw new Error('layout not replicated: ' + key);
  const layout = cfg.layout;
  const since = Number(sinceMs) || 0;
  if (!since) return { mode: 'full' };

  const ck = changeKey(db, layout);
  const now = Date.now();

  // An index that does not exist, or that starts after the client's watermark,
  // cannot answer the question — anything older than its first entry is
  // invisible to it, and quietly returning "nothing changed" would strand the
  // client on stale data forever.
  let oldest;
  try {
    const head = await redis.zrange(ck, 0, 0, { withScores: true });
    if (!head || !head.length) return { mode: 'full' };
    oldest = Number(Array.isArray(head[0]) ? head[0][1] : head[1]);
  } catch { return { mode: 'full' }; }
  if (!(oldest <= since)) return { mode: 'full' };

  let ids;
  try {
    ids = await redis.zrange(ck, `(${since}`, '+inf', { byScore: true });
  } catch { return { mode: 'full' }; }
  ids = (ids || []).map(String);
  if (!ids.length) return { mode: 'incremental', records: [], removed: [], now };

  const total = await redis.hlen(rk(db, layout, 'recs')).catch(() => 0);
  if (total && ids.length > total * INCREMENTAL_MAX_SHARE) return { mode: 'full' };

  const raw = await redis.hmget(rk(db, layout, 'recs'), ...ids);
  const present = [];
  const removed = [];
  ids.forEach((id, i) => {
    const v = Array.isArray(raw) ? raw[i] : raw?.[id];
    if (v == null) removed.push(id);                       // deleted in FileMaker
    else present.push(typeof v === 'string' ? JSON.parse(v) : v);
  });

  // isLastPage=true so applyOverlay also appends Vibe-born records — a record
  // created in Vibe has no replica row, so it can only arrive this way.
  const overlay = await readOverlay(db, layout);
  const merged = applyOverlay(present, overlay, true);

  // Anything the overlay hid (a tombstone) is a removal from the client's point
  // of view, and it is only detectable as "was in the changed set, is not in
  // the merged result".
  const survived = new Set(merged.map(r => String(r.recordId)));
  for (const id of ids) if (!survived.has(id) && !removed.includes(id)) removed.push(id);

  return { mode: 'incremental', records: merged, removed, now };
}

export async function getMetaPublic(db, key) {
  const cfg = REPLICATED[key];
  if (!cfg) return null;
  return (await redis.get(rk(db, cfg.layout, 'meta'))) || null;
}

// Force the next runSync to re-page the whole layout from FileMaker.
//
// Incremental layouts ask FileMaker "what changed since?", and adding a FIELD
// to a layout changes no record's modification date — so the replica keeps
// serving the old, narrower field set indefinitely and the new field simply
// never appears in the app. That is not hypothetical: _kft__Contact_ID was
// placed on Estimates_New on 2026-08-17 and stayed invisible until this existed.
//
// The stored records are left in place rather than deleted, so the app keeps
// reading the old set while the re-page runs instead of seeing an empty layout.
export async function resetReplica(db, key) {
  const cfg = REPLICATED[key];
  if (!cfg) throw new Error('layout not replicated: ' + key);
  const meta = (await redis.get(rk(db, cfg.layout, 'meta'))) || {};
  const next = { ...meta, phase: 'backfill', cursor: 1, count: 0, total: null, lastModifiedMs: 0 };
  await redis.set(rk(db, cfg.layout, 'meta'), next);
  return next;
}
