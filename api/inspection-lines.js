// Read and write one inspection's line items.
//
//   GET  /api/inspection-lines?db=…&inspectionId=301083
//   POST /api/inspection-lines?db=…&inspectionId=301083
//     { action: 'add',     lines: [ {...}, … ] }
//     { action: 'update',  lineId, changes: {...} }
//     { action: 'remove',  lineId }
//     { action: 'replace', lines: [ {...}, … ] }   // used by copy — RE-MINTS IDS
//     { action: 'sync',    lines: [ {...}, … ] }   // the whole array, IDS KEPT
//
// SYNC VS REPLACE — they look alike and are not interchangeable. `replace`
// calls nextLineId() for every incoming row, so it hands back a completely
// renumbered set. That is right for a copy (the rows genuinely are new ones on
// a new inspection) and wrong for everything else: a line's id is what the
// carried-over flags in api/na-flags.js are keyed on, so renumbering a saved
// inspection silently orphans every one of them and presents last year's
// unreviewed findings as reviewed.
//
// `sync` keeps each row's id, mints one only for rows that arrive without,
// and drops stored rows the array no longer contains. It is what an ordinary
// save uses — online and, once the outbox replays, offline — because it is
// idempotent: sending the same array twice cannot double-apply, where a
// sequence of add/update/remove calls half-applied on a dropped connection
// leaves an inspection in a state nobody chose.
//
// Every write is read-modify-write on that inspection's single hash field. Two
// people editing different lines of the same inspection still resolve
// last-writer-wins on the whole array — the same as the FileMaker portal
// behaved, where a PATCH replaced the row set.
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { readLines, writeLines, nextLineId, cleanLine, LINE_FIELDS } from './_inspectionLines.js';

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  const inspectionId = String(req.query?.inspectionId || '').trim();
  // Without this an inspection with no id would read and write a single shared
  // bucket keyed on '', quietly mixing findings between records.
  if (!inspectionId) return res.status(400).json({ error: 'inspectionId required' });

  try {
    if (req.method === 'GET') {
      const lines = await readLines(db, inspectionId);
      return res.status(200).json({ inspectionId, lines, count: lines.length });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = String(body.action || '');
    const current = await readLines(db, inspectionId);

    if (action === 'add') {
      const incoming = Array.isArray(body.lines) ? body.lines : [];
      const added = [];
      for (const l of incoming) {
        const row = cleanLine(l, await nextLineId(db));
        // A line with an id and nothing else is a blank row on the report.
        if (Object.keys(row).length > 1) added.push(row);
      }
      if (!added.length) return res.status(400).json({ error: 'no lines with any content' });
      const next = await writeLines(db, inspectionId, [...current, ...added]);
      return res.status(200).json({ inspectionId, added: added.length, lines: next });
    }

    if (action === 'update') {
      const lineId = String(body.lineId || '');
      const i = current.findIndex(l => String(l.id) === lineId);
      if (i === -1) return res.status(404).json({ error: 'no such line on this inspection' });
      const unknown = Object.keys(body.changes || {}).filter(k => !LINE_FIELDS.includes(k));
      if (unknown.length) return res.status(400).json({ error: `not part of a line: ${unknown.join(', ')}` });
      const merged = cleanLine({ ...current[i], ...(body.changes || {}) }, current[i].id);
      const next = [...current]; next[i] = merged;
      return res.status(200).json({ inspectionId, lines: await writeLines(db, inspectionId, next) });
    }

    if (action === 'remove') {
      const lineId = String(body.lineId || '');
      if (!current.some(l => String(l.id) === lineId)) {
        return res.status(404).json({ error: 'no such line on this inspection' });
      }
      const next = current.filter(l => String(l.id) !== lineId);
      return res.status(200).json({ inspectionId, lines: await writeLines(db, inspectionId, next) });
    }

    if (action === 'sync') {
      const incoming = Array.isArray(body.lines) ? body.lines : [];
      const rows = [];
      for (const l of incoming) {
        // An id the client already holds is kept — including one belonging to a
        // row the office deleted while a crew was offline. Resurrecting it is
        // the same last-writer-wins the whole array already resolves by, and it
        // keeps the row's flags attached to it.
        //
        // `new:` ids are the app's own temporary keys for rows added in a
        // session that has never synced. They are treated as no id at all: a
        // client key must never be stored, or the next session's would collide
        // with it.
        const given = l?.id === undefined || l?.id === null ? '' : String(l.id);
        const isNew = !given || given.startsWith('new:');
        const fields = cleanLine(l, '');
        const hasContent = Object.keys(fields).length > 1;
        // A blank new row is not a line — it is an empty row someone added and
        // never filled in, and writing it puts a blank line on the report. A
        // blank STORED row is kept: emptying a line's fields is an edit, not a
        // request to delete it. Deleting is done by leaving it out of the array.
        if (isNew && !hasContent) continue;
        // Minted only once it is known the row is being kept, so a session of
        // added-then-abandoned rows does not burn ids.
        rows.push(cleanLine(l, isNew ? await nextLineId(db) : given));
      }
      const next = await writeLines(db, inspectionId, rows);
      return res.status(200).json({ inspectionId, lines: next, count: next.length });
    }

    if (action === 'replace') {
      const incoming = Array.isArray(body.lines) ? body.lines : [];
      const rows = [];
      for (const l of incoming) {
        const row = cleanLine(l, await nextLineId(db));
        if (Object.keys(row).length > 1) rows.push(row);
      }
      return res.status(200).json({ inspectionId, lines: await writeLines(db, inspectionId, rows) });
    }

    return res.status(400).json({ error: "action must be add, update, remove, replace or sync" });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
