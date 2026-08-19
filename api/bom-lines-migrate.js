// Move FileMaker's bill-of-materials lines into Vibe's own store — PHASE B2.
//
//   POST /api/bom-lines-migrate?db=…&offset=1     → one page of 1,000
//   POST /api/bom-lines-migrate?db=…&step=finish  → promote staging to live
//   GET  /api/bom-lines-migrate?db=…              → the last report
//
// Reads the `BOM` layout, NOT `Item_ITMLI_billOfMaterials`. Both sit on the same
// table, but the latter carries table-wide aggregate calculations (`s_Cost`,
// `s_Total`) that FileMaker recomputes for every row it returns: a 1,000-row
// page takes over 30 seconds there against 1.7 on `BOM`. Same data, eighteen
// times the cost.
import { fmpToken, ALLOWED_DBS } from './_fmp.js';
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail } from './_admin.js';
import { Redis } from '@upstash/redis';
import { bomKey, cleanLine } from './_bomLines.js';

const redis = Redis.fromEnv();
const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const LAYOUT = 'BOM';
const PAGE = 1000;

const stageKey = db => `vibe:${db}:bom:staging`;
const reportKey = db => `vibe:${db}:bom:report`;
const progressKey = db => `vibe:${db}:bom:finish`;

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

// Ten products hold 114,150 of the table's 125,047 rows — 91.3% — and the
// counts are not credible as bills of materials: "Pick A Postcard" has 29,124
// components, the first of which is a 1.5-inch pulley. The remaining 1,069
// parents average 10.2 lines, which is an ordinary BOM.
//
// Decided 2026-08-19 (Andy): migrate the tail, leave these behind for a
// decision. They are listed by id rather than caught by a row-count threshold
// so the exclusion is explicit and auditable — a rule would also silently drop
// a legitimately large assembly built later. Nothing is deleted in FileMaker;
// they are simply not copied.
const EXCLUDED_PARENTS = new Map([
  ['1803', 'Pick A Postcard — 29,124 lines'],
  ['1793', 'Body Parts Debrief Kit; Deluxe — 20,750'],
  ['2054', 'Blocked Perspective Box Empty — 17,833'],
  ['2072', 'Omega Steel Screw Lock Carabiner — 12,692'],
  ['1787', 'Discount by the Dollar — 10,370'],
  ['1967', "8x8x12' Treated Lumber — 10,288"],
  ['1770', 'Zoom — 5,182'],
  ['1871', 'NE Ropes 3/8" KMIII Black 600ft — 3,111'],
  ['1874', 'NE Ropes 3/8" KMIII Orange/Blue 600ft — 3,111'],
  ['1721', 'Atomik Climbing Hold Elementary Pkg 2 — 1,689'],
]);

// Anything else this large is new runaway data, not something the list above
// anticipated. Reported rather than skipped: the migration should surface it,
// not quietly decide about it.
const SUSPICIOUS_LINES = 500;

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  if (req.method === 'GET') {
    return res.status(200).json((await redis.get(reportKey(db))) || { note: 'no BOM migration has run' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  try {
    if (req.query?.step === 'finish') {
      const startedAt = Date.now();
      let cursor = String(req.query?.cursor ?? '0');
      const progress = (await redis.get(progressKey(db))) || { products: 0, lines: 0 };
      let products = 0, lines = 0, fields = 0;
      const suspicious = [];

      do {
        const [next, flat] = await redis.hscan(stageKey(db), cursor, { count: 200 });
        const writes = {};
        for (let i = 0; i < flat.length; i += 2) {
          const arr = parse(flat[i + 1]);
          if (!Array.isArray(arr) || !arr.length) continue;
          if (arr.length >= SUSPICIOUS_LINES) suspicious.push({ parentItemId: String(flat[i]), lines: arr.length });
          writes[String(flat[i])] = JSON.stringify(arr);
          products++; lines += arr.length; fields++;
        }
        if (Object.keys(writes).length) await redis.hset(bomKey(db), writes);
        cursor = String(next);
      } while (cursor && cursor !== '0' && fields < 800 && Date.now() - startedAt < 120000);

      const totals = { products: progress.products + products, lines: progress.lines + lines };
      if (cursor && cursor !== '0') {
        await redis.set(progressKey(db), totals);
        return res.status(200).json({ step: 'finish', done: false, cursor, ...totals, suspicious });
      }
      await redis.del(stageKey(db), progressKey(db));
      const report = {
        db, at: new Date().toISOString(), by: session.email, ...totals,
        stored: await redis.hlen(bomKey(db)),
        excluded: [...EXCLUDED_PARENTS.entries()].map(([id, why]) => ({ parentItemId: id, why })),
        suspicious,
      };
      await redis.set(reportKey(db), report);
      return res.status(200).json({ step: 'finish', done: true, ...report });
    }

    const offset = Math.max(1, Number(req.query?.offset) || 1);
    if (offset === 1) await redis.del(stageKey(db));

    const token = await fmpToken(db);
    const url = `${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${LAYOUT}/records?_limit=${PAGE}&_offset=${offset}`;
    const page = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
    const rows = page?.response?.data || [];
    const total = page?.response?.dataInfo?.foundCount ?? null;
    const msg = page?.messages?.[0];

    if (!rows.length) {
      if (msg?.code && !['0', '401', '101'].includes(String(msg.code))) {
        return res.status(502).json({ offset, done: false, code: msg.code, error: msg.message });
      }
      return res.status(200).json({ offset, total, done: true });
    }

    const byParent = new Map();
    let skippedExcluded = 0, noParent = 0, noComponent = 0;
    for (const r of rows) {
      const f = r.fieldData;
      const parent = String(f._kft__Item_ID__parent ?? '').trim();
      if (!parent) { noParent++; continue; }
      if (EXCLUDED_PARENTS.has(parent)) { skippedExcluded++; continue; }
      const component = String(f._kft__Item_ID__assemblyLine ?? '').trim();
      // A line with no component names nothing — it cannot be rendered and
      // cannot be priced. Counted rather than carried.
      if (!component) { noComponent++; continue; }
      const line = cleanLine(
        { componentItemId: component, quantity: f.Quantity },
        String(f._kpt__Item_Line_Item_ID || r.recordId),
      );
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(line);
    }

    const ids = [...byParent.keys()];
    const existing = ids.length ? await redis.hmget(stageKey(db), ...ids) : {};
    const bag = Array.isArray(existing)
      ? Object.fromEntries(ids.map((id, i) => [id, existing[i]]))
      : (existing || {});

    const writes = {};
    for (const [id, incoming] of byParent) {
      const prev = parse(bag[id]);
      const merged = [...(Array.isArray(prev) ? prev : [])];
      const seen = new Set(merged.map(l => String(l.id)));
      for (const l of incoming) if (!seen.has(String(l.id))) { merged.push(l); seen.add(String(l.id)); }
      writes[id] = JSON.stringify(merged);
    }
    if (Object.keys(writes).length) await redis.hset(stageKey(db), writes);

    return res.status(200).json({
      offset, total, read: rows.length, productsTouched: byParent.size,
      skippedExcluded, noParent, noComponent,
      nextOffset: offset + rows.length, done: rows.length < PAGE,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
