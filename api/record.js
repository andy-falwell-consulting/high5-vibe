// Single record, with Vibe's edits merged in.
//
//   GET /api/record?db=High5_Core4&layout=RCD_New&recordId=16689
//     → the FileMaker response shape, so callers are unchanged
//
// WHY THIS EXISTS
// getRecord() in src/api/filemaker.js went straight to FileMaker, and then wrote
// what it got back into the list cache (patchCachedRecordAcrossVersions). Once
// Vibe owns a field, that path would return the pre-Vibe value AND overwrite the
// merged copy the list already had — so opening a record would silently undo
// every Vibe edit on it. Exactly the class of bug the whole decoupling exists to
// remove, arriving on the first click.
//
// So single-record reads come through here, where the same overlay used by the
// list read (_vibeStore.js) is applied. One merge implementation, both paths.
import { fmpToken, ALLOWED_DBS } from './_fmp.js';
import { getGoogleSession } from './_googleSession.js';
import { readFragment, mergeRecord, isVibeRecordId } from './_vibeStore.js';

const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await getGoogleSession(req))) return res.status(401).json({ error: 'Not authenticated' });

  const db = String(req.query?.db || '');
  const layout = String(req.query?.layout || '');
  const recordId = String(req.query?.recordId || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });
  if (!layout || !recordId) return res.status(400).json({ error: 'layout and recordId are required' });

  try {
    // A `V-` id is Vibe's own and cannot exist in FileMaker — asking anyway
    // costs a round trip and comes back as error 960 ("recordId must be an
    // integer"), which is noise in the logs and a misleading error to pass on
    // if the fragment has since been dropped. Answer from the fragment alone.
    if (isVibeRecordId(recordId)) {
      const frag = await readFragment(db, layout, recordId);
      if (frag?.__created && !frag.__deleted) {
        return res.status(200).json({
          messages: [{ code: '0', message: 'OK' }],
          response: { data: [{ recordId, modId: '0', fieldData: { ...(frag.fieldData || {}) }, portalData: {} }] },
        });
      }
      return res.status(404).json({ messages: [{ code: '101', message: 'Record is missing' }], response: { data: [] } });
    }

    const token = await fmpToken(db);
    const r = await fetch(
      `${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = await r.json().catch(() => ({}));

    const rec = body?.response?.data?.[0];
    const frag = await readFragment(db, layout, recordId);

    // A record born in Vibe has no FileMaker counterpart, so FileMaker answers
    // "record is missing" — correctly, from its point of view. Serve it from the
    // fragment alone. Found by auditing what a V- prefixed id would break: this
    // was the only place that assumed every id exists in FileMaker.
    if (!rec) {
      if (frag?.__created && !frag.__deleted) {
        return res.status(200).json({
          messages: [{ code: '0', message: 'OK' }],
          response: { data: [{ recordId, modId: '0', fieldData: { ...(frag.fieldData || {}) }, portalData: {} }] },
        });
      }
      return res.status(r.status).json(body);   // pass FileMaker's own error through
    }

    const merged = mergeRecord(rec, frag);

    // A tombstoned record is gone as far as the app is concerned, even though
    // FileMaker still holds it. Answer as FileMaker does for a missing record.
    if (!merged) {
      return res.status(404).json({ messages: [{ code: '101', message: 'Record is missing' }], response: { data: [] } });
    }

    // portalData is preserved untouched — Vibe fragments only carry fieldData,
    // and related rows are still FileMaker's until a later phase moves them.
    return res.status(200).json({ ...body, response: { ...body.response, data: [merged] } });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
