import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS, fmpToken } from './_fmp.js';
import { isAdminEmail } from './_admin.js';
import { toWorkshop, courseKey, recKey, byContactKey, byCourseKey } from './_oeTraining.js';

// Rebuild the OE training store in its NORMALISED shape.
//
//   POST /api/oe-training-rebuild?db=…&offset=1   → one page of 500
//   POST /api/oe-training-rebuild?db=…&step=finish → promote staging to live
//   GET  /api/oe-training-rebuild?db=…            → the last report
//
// Why a rebuild rather than a reshuffle of what B3 already stored:
//
//  - B3 files rows under a contact, so its 5,142 rows EXCLUDE the 75 that have
//    no `_kft__Contact_ID`. Three of those are 2026 registrations — two on
//    L2-2026-1 at $235 each — and a session roster that omits paying attendees
//    is worse than one that is slow. Reading FileMaker picks them up; reading
//    B3's store cannot.
//  - The rows are keyed by course here, so a row needs no contact to be filed.
//
// Same paged/staged/promote shape as oe-training-migrate.js, and for the same
// reason: the layout carries related contact fields that FileMaker resolves per
// row, so a page of 500 takes several seconds and the whole table cannot be read
// in one request.

const redis = Redis.fromEnv();
const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const LAYOUT = 'Workshops_New';
const PAGE = 500;

const stageKey = db => `vibe:${db}:oetrn:rebuild:stage`;
const reportKey = db => `vibe:${db}:oetrn:rebuild:report`;
// Accumulate across passes. The finish step is resumable, so per-pass counts
// have to live somewhere or the final report describes only the LAST pass —
// exactly how B3's first run claimed 289 contacts against 2,689 actually stored.
const progressKey = db => `vibe:${db}:oetrn:rebuild:progress`;

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'admin only' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  if (req.method === 'GET')
    return res.status(200).json((await redis.get(reportKey(db))) || { note: 'no rebuild has run' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST or GET' });

  try {
    // ── Promote staging into the live keys ──────────────────────────────────
    if (req.query?.step === 'finish') {
      let cursor = String(req.query?.cursor || '0');
      const totals = (await redis.get(progressKey(db))) || { rows: 0, contacts: 0, courses: 0 };
      const contacts = new Set();
      const courses = new Set();

      // First pass wipes the live keys so a rebuild cannot leave orphans from a
      // previous shape behind.
      if (cursor === '0') await redis.del(recKey(db), byContactKey(db), byCourseKey(db));

      const idsByContact = new Map();
      const idsByCourse = new Map();
      let scanned = 0;
      do {
        const [next, flat] = await redis.hscan(stageKey(db), cursor, { count: 300 });
        const writes = {};
        for (let i = 1; i < flat.length; i += 2) {
          const row = parse(flat[i]);
          if (!row?.id) continue;
          writes[row.id] = JSON.stringify(row);
          scanned++;
          if (row.contactId) {
            if (!idsByContact.has(row.contactId)) idsByContact.set(row.contactId, []);
            idsByContact.get(row.contactId).push(row.id);
            contacts.add(row.contactId);
          }
          const ck = courseKey(row.courseNumber);
          if (ck) {
            if (!idsByCourse.has(ck)) idsByCourse.set(ck, []);
            idsByCourse.get(ck).push(row.id);
            courses.add(ck);
          }
        }
        if (Object.keys(writes).length) await redis.hset(recKey(db), writes);
        cursor = String(next);
      } while (cursor !== '0' && scanned < 2000);

      // Append to the indexes rather than overwrite — a later pass adds more ids
      // for a contact or course a previous pass already created.
      const merge = async (key, map) => {
        for (const [field, ids] of map) {
          const existing = parse(await redis.hget(key, field));
          const all = [...new Set([...(Array.isArray(existing) ? existing : []), ...ids])];
          await redis.hset(key, { [field]: JSON.stringify(all) });
        }
      };
      await merge(byContactKey(db), idsByContact);
      await merge(byCourseKey(db), idsByCourse);

      totals.rows += scanned;
      totals.contacts = contacts.size > totals.contacts ? contacts.size : totals.contacts;
      totals.courses = courses.size > totals.courses ? courses.size : totals.courses;

      if (cursor !== '0') {
        await redis.set(progressKey(db), totals);
        return res.status(200).json({ step: 'finish', done: false, cursor, ...totals });
      }

      const finalContacts = Object.keys((await redis.hgetall(byContactKey(db))) || {}).length;
      const finalCourses = Object.keys((await redis.hgetall(byCourseKey(db))) || {}).length;
      await redis.del(stageKey(db), progressKey(db));
      const report = {
        at: new Date().toISOString(),
        rowsWritten: totals.rows,
        contactsIndexed: finalContacts,
        coursesIndexed: finalCourses,
        note: 'normalised store: rec + bycontact + bycourse',
      };
      await redis.set(reportKey(db), report);
      return res.status(200).json({ step: 'finish', done: true, ...report });
    }

    // ── Page FileMaker into staging ─────────────────────────────────────────
    const offset = Math.max(1, Number(req.query?.offset) || 1);
    if (offset === 1) await redis.del(stageKey(db), progressKey(db));

    const token = await fmpToken(db);
    const url = `${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${LAYOUT}/records?_limit=${PAGE}&_offset=${offset}`;
    const page = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
    await fetch(`${FMP_HOST}/fmi/data/v2/databases/${db}/sessions/${token}`, { method: 'DELETE' }).catch(() => {});

    const rows = page?.response?.data || [];
    const total = page?.response?.dataInfo?.foundCount ?? null;
    const msg = page?.messages?.[0];
    if (!rows.length) {
      if (msg?.code && !['0', '401', '101'].includes(String(msg.code))) {
        return res.status(502).json({ offset, done: false, code: msg.code, error: msg.message });
      }
      return res.status(200).json({ offset, total, done: true });
    }

    const writes = {};
    let noContact = 0, noCourse = 0, filed = 0;
    for (const r of rows) {
      const w = toWorkshop(r.fieldData, r.recordId);
      if (!w.id) continue;
      if (!w.contactId) noContact++;
      if (!courseKey(w.courseNumber)) noCourse++;
      // A row with NEITHER a contact nor a course cannot be reached from any
      // page, so storing it would only inflate the count. Everything with at
      // least one of the two is kept — which is the change from B3, where a
      // missing contact alone was enough to drop a row.
      if (!w.contactId && !courseKey(w.courseNumber)) continue;
      writes[w.id] = JSON.stringify(w);
      filed++;
    }
    if (Object.keys(writes).length) await redis.hset(stageKey(db), writes);

    return res.status(200).json({
      offset, total, done: false, read: rows.length, filed,
      noContact, noCourse, nextOffset: offset + rows.length,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
