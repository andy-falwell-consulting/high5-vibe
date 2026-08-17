// Move FileMaker's inspection line items into Vibe's own store.
//
//   POST /api/inspection-lines-migrate?db=…&offset=1   → one page of 1,000
//   POST /api/inspection-lines-migrate?db=…&step=finish → group and write
//   GET  /api/inspection-lines-migrate?db=…            → the last report
//
// Staged and then folded, like the contact methods, because the rows land ON
// the inspection: writing page by page would read and rewrite the same
// inspection's array once per line it owns, and the median inspection has 40.
//
// 208,416 rows is too many to hold as one staged hash cheaply, so a page is
// grouped by inspection as it arrives and merged into a staging hash keyed the
// same way the final store is. `finish` then promotes staging to live.
import { fmpToken, ALLOWED_DBS } from './_fmp.js';
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail } from './_admin.js';
import { Redis } from '@upstash/redis';
import { linesKey, LINE_FIELDS, cleanLine } from './_inspectionLines.js';

const redis = Redis.fromEnv();
const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const LAYOUT = 'Script_Use__Inspections_Line_Items';
const PAGE = 1000;

const stageKey = db => `vibe:${db}:inspli:staging`;
const reportKey = db => `vibe:${db}:inspli:report`;

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  if (req.method === 'GET') {
    return res.status(200).json((await redis.get(reportKey(db))) || { note: 'no line-item migration has run' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  try {
    if (req.query?.step === 'finish') {
      // Promote staging to live in one pass. Read in chunks so a 67 MB hash is
      // never fully resident: HSCAN gives batches rather than everything.
      let cursor = '0', inspections = 0, lines = 0;
      do {
        const [next, flat] = await redis.hscan(stageKey(db), cursor, { count: 200 });
        const writes = {};
        for (let i = 0; i < flat.length; i += 2) {
          const arr = parse(flat[i + 1]);
          if (!Array.isArray(arr) || !arr.length) continue;
          writes[String(flat[i])] = JSON.stringify(arr);
          inspections++; lines += arr.length;
        }
        if (Object.keys(writes).length) await redis.hset(linesKey(db), writes);
        cursor = String(next);
      } while (cursor && cursor !== '0');

      await redis.del(stageKey(db));
      const report = { db, at: new Date().toISOString(), by: session.email, inspections, lines };
      await redis.set(reportKey(db), report);
      return res.status(200).json(report);
    }

    const offset = Math.max(1, Number(req.query?.offset) || 1);
    if (offset === 1) await redis.del(stageKey(db));

    const token = await fmpToken(db);
    const url = `${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${LAYOUT}/records?_limit=${PAGE}&_offset=${offset}`;
    const page = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
    const rows = page?.response?.data || [];
    const total = page?.response?.dataInfo?.foundCount ?? null;
    if (!rows.length) return res.status(200).json({ offset, total, done: true });

    // Group this page by inspection first, so each inspection's staged field is
    // read and written once per page rather than once per line.
    const byInspection = new Map();
    let orphan = 0;
    for (const r of rows) {
      const f = r.fieldData;
      const id = String(f._kft__Inspection_ID ?? '').trim();
      // 318 rows across the table have no inspection id. They are counted and
      // left behind rather than filed under a made-up parent — the same call
      // the contact-method migration made for its 2,915.
      if (!id) { orphan++; continue; }
      // FileMaker's own line id is kept, so a re-run overwrites rather than
      // duplicating, and a line stays traceable to the row it came from.
      const line = cleanLine(f, String(f._kpt__Inspection_Line_Item_ID || r.recordId));
      if (Object.keys(line).length <= 1) continue;   // nothing but an id
      if (!byInspection.has(id)) byInspection.set(id, []);
      byInspection.get(id).push({ line, sort: Number(f.Sort_Order || 0) });
    }

    const ids = [...byInspection.keys()];
    const existing = ids.length ? await redis.hmget(stageKey(db), ...ids) : {};
    const bag = Array.isArray(existing)
      ? Object.fromEntries(ids.map((id, i) => [id, existing[i]]))
      : (existing || {});

    const writes = {};
    for (const [id, incoming] of byInspection) {
      const prev = parse(bag[id]);
      const merged = [...(Array.isArray(prev) ? prev : [])];
      const seen = new Set(merged.map(l => String(l.id)));
      // Sort_Order is what FileMaker displays by; the row id breaks ties so a
      // re-run produces the same order.
      incoming.sort((a, b) => (a.sort - b.sort) || String(a.line.id).localeCompare(String(b.line.id)));
      for (const { line } of incoming) if (!seen.has(String(line.id))) merged.push(line);
      writes[id] = JSON.stringify(merged);
    }
    if (Object.keys(writes).length) await redis.hset(stageKey(db), writes);

    return res.status(200).json({
      offset, total, read: rows.length, inspectionsTouched: byInspection.size, orphan,
      nextOffset: offset + rows.length, done: rows.length < PAGE, fields: LINE_FIELDS,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
