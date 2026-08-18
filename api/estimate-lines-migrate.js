// Move FileMaker's estimate line items into Vibe's own store — PHASE B1.
//
//   POST /api/estimate-lines-migrate?db=…&offset=1        → one page of 1,000
//   POST /api/estimate-lines-migrate?db=…&offset=1&peek=1 → READ ONLY, writes nothing
//   POST /api/estimate-lines-migrate?db=…&step=finish     → promote staging to live
//   GET  /api/estimate-lines-migrate?db=…                 → the last report
//
// Deliberately the same shape as api/inspection-lines-migrate.js, which moved
// 208,416 rows: read the line-item table's OWN layout a page at a time, group
// each page by parent, stage it, then promote. Estimate lines cannot be read
// from the portal instead — the replica's list scan carries no portalData at
// all, and per-record portal reads would cost one round trip per estimate and
// truncate at FileMaker's default 50 rows.
//
// `peek=1` exists because the shape of `estimate_li_vibe` was not knowable from
// this side. It pages the layout and reports what came back WITHOUT touching
// Redis, so the field names — above all the parent key — can be confirmed
// before anything is migrated. Reading a layout to find out what is on it
// should not require being willing to write.
import { fmpToken, ALLOWED_DBS } from './_fmp.js';
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail } from './_admin.js';
import { Redis } from '@upstash/redis';
import { linesKey, cleanLine } from './_estimateLines.js';

const redis = Redis.fromEnv();
const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const LAYOUT = 'estimate_li_vibe';
const PAGE = 1000;

const stageKey = db => `vibe:${db}:estli:staging`;
const reportKey = db => `vibe:${db}:estli:report`;
const progressKey = db => `vibe:${db}:estli:finish`;

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

// Which field on a line points at its estimate. Confirmed by `peek` rather than
// assumed: the naming pattern would suggest `_kft__Estimate_ID`, but the
// contact-method tables showed that a plausible name is not evidence.
const PARENT_KEYS = ['_kft__Estimate_ID', '_kf__Estimate_ID', '_kft__ESTMT_ID'];
const parentIdOf = f => {
  for (const k of PARENT_KEYS) {
    const v = String(f?.[k] ?? '').trim();
    if (v) return v;
  }
  return '';
};

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  if (req.method === 'GET') {
    return res.status(200).json((await redis.get(reportKey(db))) || { note: 'no estimate line migration has run' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  try {
    if (req.query?.step === 'finish') {
      const startedAt = Date.now();
      const BUDGET_MS = 120000;
      const FIELD_BUDGET = 800;
      let cursor = String(req.query?.cursor ?? '0');
      const progress = (await redis.get(progressKey(db))) || { estimates: 0, lines: 0 };
      let estimates = 0, lines = 0, fields = 0;

      do {
        const [next, flat] = await redis.hscan(stageKey(db), cursor, { count: 200 });
        const writes = {};
        for (let i = 0; i < flat.length; i += 2) {
          const arr = parse(flat[i + 1]);
          if (!Array.isArray(arr) || !arr.length) continue;
          writes[String(flat[i])] = JSON.stringify(arr);
          estimates++; lines += arr.length; fields++;
        }
        if (Object.keys(writes).length) await redis.hset(linesKey(db), writes);
        cursor = String(next);
      } while (cursor && cursor !== '0' && fields < FIELD_BUDGET && Date.now() - startedAt < BUDGET_MS);

      const totals = { estimates: progress.estimates + estimates, lines: progress.lines + lines };
      if (!(!cursor || cursor === '0')) {
        await redis.set(progressKey(db), totals);
        return res.status(200).json({ step: 'finish', done: false, cursor, ...totals });
      }
      await redis.del(stageKey(db), progressKey(db));
      const report = { db, at: new Date().toISOString(), by: session.email, ...totals, stored: await redis.hlen(linesKey(db)) };
      await redis.set(reportKey(db), report);
      return res.status(200).json({ step: 'finish', done: true, ...report });
    }

    const offset = Math.max(1, Number(req.query?.offset) || 1);
    const peek = !!req.query?.peek;

    const token = await fmpToken(db);
    const url = `${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${LAYOUT}/records?_limit=${peek ? 3 : PAGE}&_offset=${offset}`;
    const page = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
    const rows = page?.response?.data || [];
    const total = page?.response?.dataInfo?.foundCount ?? null;
    const msg = page?.messages?.[0];

    // Same distinction as the contacts migration (v1.0.384): zero rows with no
    // found count is a refused read, not the end of the pages.
    if (!rows.length) {
      if (msg?.code && !['0', '401', '101'].includes(String(msg.code))) {
        return res.status(502).json({ offset, done: false, code: msg.code, error: msg.message });
      }
      return res.status(200).json({ offset, total, done: true });
    }

    if (peek) {
      const f = rows[0].fieldData || {};
      return res.status(200).json({
        peek: true, layout: LAYOUT, total, wroteNothing: true,
        fieldNames: Object.keys(f),
        parentKeyFound: parentIdOf(f) ? PARENT_KEYS.find(k => String(f[k] ?? '').trim()) : null,
        sampleRows: rows.map(r => r.fieldData),
      });
    }

    if (offset === 1) await redis.del(stageKey(db));

    const byEstimate = new Map();
    let orphan = 0;
    for (const r of rows) {
      const f = r.fieldData;
      const id = parentIdOf(f);
      // No estimate id means nothing can own it — counted, not filed under a
      // made-up parent. The same call the inspection and contact-method
      // migrations made for their orphans.
      if (!id) { orphan++; continue; }
      const line = cleanLine(f, String(f._kpt__Estimate_Line_Item_ID || r.recordId));
      if (Object.keys(line).length <= 1) continue;
      if (!byEstimate.has(id)) byEstimate.set(id, []);
      byEstimate.get(id).push(line);
    }

    const ids = [...byEstimate.keys()];
    const existing = ids.length ? await redis.hmget(stageKey(db), ...ids) : {};
    const bag = Array.isArray(existing)
      ? Object.fromEntries(ids.map((id, i) => [id, existing[i]]))
      : (existing || {});

    const writes = {};
    for (const [id, incoming] of byEstimate) {
      const prev = parse(bag[id]);
      const merged = [...(Array.isArray(prev) ? prev : [])];
      const seen = new Set(merged.map(l => String(l.id)));
      for (const l of incoming) if (!seen.has(String(l.id))) { merged.push(l); seen.add(String(l.id)); }
      merged.sort((a, b) => Number(a.Sort_Order || 0) - Number(b.Sort_Order || 0)
        || String(a.id).localeCompare(String(b.id)));
      writes[id] = JSON.stringify(merged);
    }
    if (Object.keys(writes).length) await redis.hset(stageKey(db), writes);

    return res.status(200).json({
      offset, total, read: rows.length, estimatesTouched: byEstimate.size, orphan,
      nextOffset: offset + rows.length, done: rows.length < PAGE,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
