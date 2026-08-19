// Move FileMaker's invoice history into Vibe's own store — PHASE B4.
//
//   POST /api/invoices-migrate?db=…&offset=1     → one page of 1,000
//   POST /api/invoices-migrate?db=…&step=finish  → promote staging to live
//   GET  /api/invoices-migrate?db=…              → the last report
//
// Reads `Invoices_New` — 13,140 rows, peeking in 659ms with none of the
// aggregate-calculation cost that made the BOM table unpageable.
//
// The finish step accumulates its counts through a progress key from the start.
// B3's did not, and reported 289 contacts against 2,689 actually stored —
// describing only its final pass while looking like a total.
import { fmpToken, ALLOWED_DBS } from './_fmp.js';
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail } from './_admin.js';
import { Redis } from '@upstash/redis';
import { invoiceKey, toInvoice, sortInvoices } from './_invoices.js';

const redis = Redis.fromEnv();
const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const LAYOUT = 'Invoices_New';
const PAGE = 1000;

const stageKey = db => `vibe:${db}:invo:staging`;
const reportKey = db => `vibe:${db}:invo:report`;
const progressKey = db => `vibe:${db}:invo:finish`;

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  if (req.method === 'GET') {
    return res.status(200).json((await redis.get(reportKey(db))) || { note: 'no invoice migration has run' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  try {
    if (req.query?.step === 'finish') {
      let cursor = String(req.query?.cursor ?? '0');
      const progress = (await redis.get(progressKey(db))) || { contacts: 0, invoices: 0 };
      let contacts = 0, invoices = 0, fields = 0;
      const startedAt = Date.now();

      do {
        const [next, flat] = await redis.hscan(stageKey(db), cursor, { count: 200 });
        const writes = {};
        for (let i = 0; i < flat.length; i += 2) {
          const arr = parse(flat[i + 1]);
          if (!Array.isArray(arr) || !arr.length) continue;
          writes[String(flat[i])] = JSON.stringify(sortInvoices(arr));
          contacts++; invoices += arr.length; fields++;
        }
        if (Object.keys(writes).length) await redis.hset(invoiceKey(db), writes);
        cursor = String(next);
      } while (cursor && cursor !== '0' && fields < 800 && Date.now() - startedAt < 120000);

      const totals = { contacts: progress.contacts + contacts, invoices: progress.invoices + invoices };
      if (cursor && cursor !== '0') {
        await redis.set(progressKey(db), totals);
        return res.status(200).json({ step: 'finish', done: false, cursor, ...totals });
      }
      await redis.del(stageKey(db), progressKey(db));
      const report = {
        db, at: new Date().toISOString(), by: session.email,
        ...totals, stored: await redis.hlen(invoiceKey(db)),
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
      const inv = toInvoice(r.fieldData, r.recordId);
      // An invoice with no contact cannot be shown on a contact page. Counted,
      // not filed under a made-up parent — the call every migration here has
      // made.
      if (!inv.contactId) { noContact++; continue; }
      if (!byContact.has(inv.contactId)) byContact.set(inv.contactId, []);
      byContact.get(inv.contactId).push(inv);
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
      const seen = new Set(merged.map(x => String(x.id)));
      for (const inv of incoming) if (!seen.has(String(inv.id))) { merged.push(inv); seen.add(String(inv.id)); }
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
