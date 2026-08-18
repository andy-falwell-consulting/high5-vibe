// Write a Vibe-owned record edit.
//
//   POST   /api/vibe-record?db=High5_Core4&layout=RCD_New
//     { recordId, fieldData }  → merges those fields into the record's fragment
//     { create: true, fieldData } → a record born in Vibe, with a minted V- id
//     { recordId, delete: true } → tombstone: the record disappears from Vibe
//       and stays gone across syncs. FileMaker's own row is left alone.
//   DELETE /api/vibe-record?db=…&layout=…&recordId=…
//     drops the fragment, so the record reverts to FileMaker's values —
//     the OPPOSITE of `{ delete: true }`, which is why they are different verbs
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
import { VIBE_OWNED, VIBE_DELETES, VIBE_PK, writeFragment, dropFragment, createFragment, tombstoneFragment } from './_vibeStore.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'POST or DELETE' });
  }
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const db = String(req.query?.db || '');
  const layout = String(req.query?.layout || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  // Refused rather than silently forwarded to FileMaker: a caller that thinks
  // it is writing to Vibe and is actually writing to FMP is the exact confusion
  // this phase exists to end.
  //
  // Gated per operation, because deleting and editing are owned by different
  // sets of layouts — OELookup_New and Contacts_New can be deleted through Vibe
  // but are still edited through FileMaker.
  const refuse = set => res.status(400).json({
    error: `${layout} is not Vibe-owned for that operation yet — it still writes to FileMaker.`,
    allowed: [...set],
  });

  // Reverting an override back to FileMaker's values. Also the only way to
  // clear a fragment written against a record that does not exist — one of
  // those is inert, because applyOverlay surfaces a record with no FileMaker
  // counterpart only when it is marked __created, but it is still litter.
  //
  // NOTE: this is the opposite of the tombstone below. DELETE un-deletes, in the
  // sense that it hands the record back to FileMaker; `{ delete: true }` hides
  // it. Kept on separate verbs so neither can be reached by accident.
  if (req.method === 'DELETE') {
    if (!VIBE_OWNED.has(layout)) return refuse(VIBE_OWNED);
    const id = String(req.query?.recordId || '').trim();
    if (!id) return res.status(400).json({ error: 'recordId required' });
    const removed = await dropFragment(db, layout, id);
    return res.status(200).json({ recordId: id, layout, removed });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  // PHASE A2: delete the record — hide it in Vibe, leave FileMaker's row alone.
  // Checked before the edit gate because its allow-list is the wider one.
  if (body.delete === true) {
    if (!VIBE_DELETES.has(layout)) return refuse(VIBE_DELETES);
    const id = String(body.recordId || '').trim();
    if (!id) return res.status(400).json({ error: 'recordId required' });
    try {
      const result = await tombstoneFragment(db, layout, id, session.email);
      return res.status(200).json({ recordId: id, layout, deleted: true, ...result, by: session.email });
    } catch (e) {
      return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  if (!VIBE_OWNED.has(layout)) return refuse(VIBE_OWNED);
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
