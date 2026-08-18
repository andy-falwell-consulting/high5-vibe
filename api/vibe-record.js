// Write a Vibe-owned record edit.
//
//   POST   /api/vibe-record?db=High5_Core4&layout=RCD_New
//     { recordId, fieldData }  → merges those fields into the record's fragment
//     { create: true, fieldData } → a record born in Vibe, with a minted V- id
//   DELETE /api/vibe-record?db=…&layout=…&recordId=…
//     drops the fragment, so the record reverts to FileMaker's values
//
// PHASE 1c of docs/vibe-owns-the-record.md. For layouts Vibe owns, this
// REPLACES the FileMaker write — projects are no longer written back to FMP.
//
// Two things follow, and both matter:
//
//  - It needs only a Google session. The FileMaker write path required a
//    per-user FMP account (getToken({write:true}) throws without one), which is
//    why production writes failed for an identity that had an account in Dev but
//    not in prod. That whole class of failure is gone.
//  - Nothing can clobber it. The sync only ever replaces `repl:`, and reads
//    overlay `vibe:` on top — so an edit cannot be reverted by a replica catching
//    up, which is what the pending-write guard existed to paper over.
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { VIBE_OWNED, VIBE_PK, writeFragment, dropFragment, createFragment } from './_vibeStore.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'POST or DELETE' });
  }
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const db = String(req.query?.db || '');
  const layout = String(req.query?.layout || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });
  if (!VIBE_OWNED.has(layout)) {
    // Refused rather than silently forwarded to FileMaker: a caller that thinks
    // it is writing to Vibe and is actually writing to FMP is the exact
    // confusion this phase exists to end.
    return res.status(400).json({ error: `${layout} is not Vibe-owned yet — it still writes to FileMaker.` });
  }

  // Reverting an override back to FileMaker's values. Also the only way to
  // clear a fragment written against a record that does not exist — one of
  // those is inert, because applyOverlay surfaces a record with no FileMaker
  // counterpart only when it is marked __created, but it is still litter.
  if (req.method === 'DELETE') {
    const id = String(req.query?.recordId || '').trim();
    if (!id) return res.status(400).json({ error: 'recordId required' });
    const removed = await dropFragment(db, layout, id);
    return res.status(200).json({ recordId: id, layout, removed });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const recordId = String(body.recordId || '').trim();
  const fieldData = body.fieldData;

  // PHASE A1: a record that never existed in FileMaker. It gets a minted `V-`
  // id which is BOTH the record id and the value of the table's own primary
  // key, so everything downstream that joins on that key — inspection line
  // items, related-record lists — works with no special case.
  if (body.create === true) {
    if (!fieldData || typeof fieldData !== 'object' || Array.isArray(fieldData)) {
      return res.status(400).json({ error: 'fieldData must be an object' });
    }
    if (!VIBE_PK[layout]) {
      return res.status(400).json({ error: `no primary key known for ${layout}` });
    }
    try {
      const { recordId: id, fragment } = await createFragment(db, layout, fieldData, session.email);
      return res.status(200).json({
        recordId: id, layout, created: true,
        primaryKey: VIBE_PK[layout], fieldData: fragment.fieldData,
      });
    } catch (e) {
      return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  if (!recordId) return res.status(400).json({ error: 'recordId required' });
  if (!fieldData || typeof fieldData !== 'object' || Array.isArray(fieldData)) {
    return res.status(400).json({ error: 'fieldData must be an object' });
  }
  if (!Object.keys(fieldData).length) return res.status(400).json({ error: 'fieldData is empty' });

  try {
    const frag = await writeFragment(db, layout, recordId, fieldData, session.email);
    return res.status(200).json({ recordId, layout, fields: Object.keys(fieldData), updatedAt: frag.__updatedAt, by: frag.__by });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
