// One contact's OE training history — PHASE B3. READ ONLY.
//
//   GET /api/oe-training?db=…&contactId=82201
//
// There is no write path, and that is deliberate rather than unfinished:
// nothing in the app has ever written workshop attendance. The legacy Contacts
// module and Contacts v2 both only display it, so a write path would be surface
// with no caller.
//
// What this replaces is worth stating: opening the OE Training tab used to cost
// TWO live FileMaker round trips — a `findInLayout` on Contacts_New to turn a
// contact id into a FileMaker recordId, then `getRecordWithPortals` for
// `Portal__Orders`. It was the last work source on that page still reading
// FileMaker at view time.
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { readWorkshops, readCourse, listCourses, sortWorkshops } from './_oeTraining.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!(await getGoogleSession(req))) return res.status(401).json({ error: 'Not authenticated' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  const contactId = String(req.query?.contactId || '').trim();
  const course = String(req.query?.course || '').trim();

  try {
    // The session roster — what the OE Trainings module reads.
    if (course) {
      const workshops = sortWorkshops(await readCourse(db, course));
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
      return res.status(200).json({ course, workshops, count: workshops.length });
    }
    // Every session with a roster size, for the sidebar. Ids only — the rows
    // themselves are not read, so this stays cheap as the table grows.
    if (req.query?.courses === '1') {
      const courses = await listCourses(db);
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
      return res.status(200).json({ courses, count: courses.length });
    }
    if (!contactId) return res.status(400).json({ error: 'contactId, course, or courses=1 required' });

    const workshops = sortWorkshops(await readWorkshops(db, contactId));
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({ contactId, workshops, count: workshops.length });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
