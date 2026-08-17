// Normalise every stored phone number to E.164, with extensions split out.
//
//   POST /api/contacts-phones-normalise?db=…[&cursor=0][&dryRun=1]
//   GET  /api/contacts-phones-normalise?db=…    → the last report
//
// Cursor-paged over both contact hashes, so it never holds 15,582 records at
// once and can be resumed. dryRun=1 counts and flags without writing, which is
// how the numbers below were checked before anything was changed.
//
// Measured across the 14,423 stored numbers before this was written:
//   14,336 (99.4%) are plain 10-digit NANP
//    1,390 carry an extension, every one using the `x` form
//       87 are truncated ('(207', '(378) 732-4') and parse to nothing
//        0 are international
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { isAdminEmail } from './_admin.js';
import { Redis } from '@upstash/redis';
import { K } from './_contacts.js';
import { normalisePhoneInput, isE164 } from './_phone.js';

const redis = Redis.fromEnv();
const reportKey = db => `vibe:${db}:contacts:phones:report`;
const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

// An extension this long is not an extension. 64 of them are exactly ten
// digits — '(508) 485-8020 x5085616306' is a second phone number typed into
// the box. They are migrated exactly as stored and listed here instead of
// being guessed at: inventing a second phone line from an assumption would
// leave no way to tell what a person wrote from what Vibe made up.
const SUSPICIOUS_EXT_DIGITS = 6;

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  if (req.method === 'GET') {
    return res.status(200).json((await redis.get(reportKey(db))) || { note: 'phones have not been normalised' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const dryRun = !!req.query?.dryRun;
  const which = String(req.query?.which || 'person');   // 'person' then 'organization'
  const key = which === 'organization' ? K.org(db) : K.person(db);

  try {
    const [next, flat] = await redis.hscan(key, String(req.query?.cursor ?? '0'), { count: 300 });
    const writes = {};
    let scanned = 0, phones = 0, converted = 0, extracted = 0, unparseable = 0, already = 0;
    const flagged = [], unparseableSamples = [];

    for (let i = 1; i < flat.length; i += 2) {
      const e = parse(flat[i]);
      if (!e) continue;
      scanned++;
      const list = Array.isArray(e.phones) ? e.phones : [];
      if (!list.length) continue;

      let changed = false;
      const nextPhones = list.map(p => {
        phones++;
        // Already done — a re-run must not re-split an ext out of a number
        // that no longer contains one.
        if (isE164(p.number) && p.ext !== undefined) { already++; return p; }
        const { number, ext } = normalisePhoneInput(p.number, p.ext);
        if (!isE164(number)) {
          unparseable++;
          if (unparseableSamples.length < 20) unparseableSamples.push({ id: e.id, was: p.number });
        } else if (number !== p.number) converted++;
        if (ext && !p.ext) extracted++;
        if (ext && ext.length >= SUSPICIOUS_EXT_DIGITS) {
          flagged.push({ contactId: e.id, number, ext, was: p.number });
        }
        if (number !== p.number || (ext || '') !== (p.ext || '')) changed = true;
        return { ...p, number, ext };
      });

      if (changed && !dryRun) writes[String(e.id)] = JSON.stringify({ ...e, phones: nextPhones });
      else if (changed) writes[String(e.id)] = null;   // counted, not written
    }

    if (!dryRun) {
      const real = Object.fromEntries(Object.entries(writes).filter(([, v]) => v !== null));
      if (Object.keys(real).length) await redis.hset(key, real);
    }

    const cursor = String(next);
    const done = !cursor || cursor === '0';
    const pass = {
      which, dryRun, cursor, done, scanned, phones,
      converted, extracted, unparseable, alreadyDone: already,
      contactsChanged: Object.keys(writes).length,
      flagged, unparseableSamples,
    };

    // Accumulate across passes so the final report describes the whole run.
    const acc = (await redis.get(reportKey(db) + ':acc')) || {};
    const merged = {
      ...acc,
      [which]: {
        phones: (acc[which]?.phones || 0) + phones,
        converted: (acc[which]?.converted || 0) + converted,
        extracted: (acc[which]?.extracted || 0) + extracted,
        unparseable: (acc[which]?.unparseable || 0) + unparseable,
        flagged: [...(acc[which]?.flagged || []), ...flagged].slice(0, 200),
      },
    };
    await redis.set(reportKey(db) + ':acc', merged);
    if (done && which === 'organization') {
      await redis.set(reportKey(db), { db, at: new Date().toISOString(), by: session.email, dryRun, ...merged });
    }

    return res.status(200).json(pass);
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
