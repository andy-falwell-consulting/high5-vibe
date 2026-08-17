// Read and write one inspection's line items.
//
//   GET  /api/inspection-lines?db=…&inspectionId=301083
//   POST /api/inspection-lines?db=…&inspectionId=301083
//     { action: 'add',     lines: [ {...}, … ] }
//     { action: 'update',  lineId, changes: {...} }
//     { action: 'remove',  lineId }
//     { action: 'replace', lines: [ {...}, … ] }   // used by copy
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

    if (action === 'replace') {
      const incoming = Array.isArray(body.lines) ? body.lines : [];
      const rows = [];
      for (const l of incoming) {
        const row = cleanLine(l, await nextLineId(db));
        if (Object.keys(row).length > 1) rows.push(row);
      }
      return res.status(200).json({ inspectionId, lines: await writeLines(db, inspectionId, rows) });
    }

    return res.status(400).json({ error: "action must be add, update, remove or replace" });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
