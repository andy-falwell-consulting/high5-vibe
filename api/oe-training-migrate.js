// Move FileMaker's workshop attendance into Vibe's own store — PHASE B3.
//
//   POST /api/oe-training-migrate?db=…&offset=1     → one page of 500
//   POST /api/oe-training-migrate?db=…&step=finish  → promote staging to live
//   GET  /api/oe-training-migrate?db=…              → the last report
//
// Reads `Workshops_New` — 5,217 rows, and the only layout that exposes this
// table to the Data API. It carries related contact fields
// (`wkshp_cntct_site_ADDR__*`, `wkshp_cntct_PHONE__*`) and `Address_Block_Billing`,
// which FileMaker resolves per row: a 1,000-row page takes ~15 seconds. That is
// fine over 6 pages and would not be over 126 — the lesson from B2, where the
// same shape made a bigger table unpageable.
//
// PAGE is 500 rather than 1,000 to keep each request comfortably inside
// Vercel's ceiling at that per-row cost.
import { fmpToken, ALLOWED_DBS } from './_fmp.js';
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail } from './_admin.js';
import { Redis } from '@upstash/redis';
import { oeKey, toWorkshop, sortWorkshops } from './_oeTraining.js';

const redis = Redis.fromEnv();
const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const LAYOUT = 'Workshops_New';
const PAGE = 500;

const stageKey = db => `vibe:${db}:oetrn:staging`;
const reportKey = db => `vibe:${db}:oetrn:report`;

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  if (req.method === 'GET') {
    return res.status(200).json((await redis.get(reportKey(db))) || { note: 'no OE training migration has run' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  try {
    if (req.query?.step === 'finish') {
      let cursor = String(req.query?.cursor ?? '0');
      let contacts = 0, workshops = 0, fields = 0;
      const startedAt = Date.now();
      do {
        const [next, flat] = await redis.hscan(stageKey(db), cursor, { count: 200 });
        const writes = {};
        for (let i = 0; i < flat.length; i += 2) {
          const arr = parse(flat[i + 1]);
          if (!Array.isArray(arr) || !arr.length) continue;
          writes[String(flat[i])] = JSON.stringify(sortWorkshops(arr));
          contacts++; workshops += arr.length; fields++;
        }
        if (Object.keys(writes).length) await redis.hset(oeKey(db), writes);
        cursor = String(next);
      } while (cursor && cursor !== '0' && fields < 800 && Date.now() - startedAt < 120000);

      if (cursor && cursor !== '0') {
        return res.status(200).json({ step: 'finish', done: false, cursor, contacts, workshops });
      }
      await redis.del(stageKey(db));
      const report = {
        db, at: new Date().toISOString(), by: session.email,
        contacts, workshops, stored: await redis.hlen(oeKey(db)),
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

    const byContact = new Map();
    let noContact = 0;
    for (const r of rows) {
      const w = toWorkshop(r.fieldData, r.recordId);
      // A workshop with no contact belongs to nobody and cannot be shown on a
      // contact page. Counted, not filed under a made-up parent — the same call
      // the other three migrations made.
      if (!w.contactId) { noContact++; continue; }
      if (!byContact.has(w.contactId)) byContact.set(w.contactId, []);
      byContact.get(w.contactId).push(w);
    }

    const ids = [...byContact.keys()];
    const existing = ids.length ? await redis.hmget(stageKey(db), ...ids) : {};
    const bag = Array.isArray(existing)
      ? Object.fromEntries(ids.map((id, i) => [id, existing[i]]))
      : (existing || {});

    const writes = {};
    for (const [id, incoming] of byContact) {
      const prev = parse(bag[id]);
      const merged = [...(Array.isArray(prev) ? prev : [])];
      const seen = new Set(merged.map(w => String(w.id)));
      for (const w of incoming) if (!seen.has(String(w.id))) { merged.push(w); seen.add(String(w.id)); }
      writes[id] = JSON.stringify(merged);
    }
    if (Object.keys(writes).length) await redis.hset(stageKey(db), writes);

    return res.status(200).json({
      offset, total, read: rows.length, contactsTouched: byContact.size, noContact,
      nextOffset: offset + rows.length, done: rows.length < PAGE,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
