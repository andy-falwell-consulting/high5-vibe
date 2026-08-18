// Read and write one estimate's line items — PHASE B1.
//
//   GET  /api/estimate-lines?db=…&estimateId=1004
//   POST /api/estimate-lines?db=…&estimateId=1004
//     { action: 'add',     lines: [ {...}, … ] }
//     { action: 'update',  lineId, changes: {...} }
//     { action: 'remove',  lineId }
//     { action: 'replace', lines: [ {...}, … ] }
//
// Deliberately the same shape as api/inspection-lines.js. Every write is
// read-modify-write on that estimate's single hash field, so two people editing
// different lines of the same estimate resolve last-writer-wins on the whole
// array — which is exactly how the FileMaker portal behaved, since a PATCH
// replaced the row set.
//
// THE TOTALS COME BACK WITH EVERY RESPONSE, computed from the lines. That is
// the point of this phase: FileMaker kept `zz__Subtotal__xn`/`zz__Tax__xn`/
// `zz__Total__xn` as STORED fields that only a script could correct, they
// rejected direct writes with `201 Field cannot be modified`, and the app had
// to call that script after every line change. Roughly 3% of production
// estimates already carry a stored total that disagrees with their own lines
// because the script did not fire. A computed total cannot drift.
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import {
  readLines, writeLines, nextLineId, cleanLine, LINE_FIELDS, totalsFor, sortLines,
} from './_estimateLines.js';

const respond = (res, estimateId, lines, extra = {}) =>
  res.status(200).json({ estimateId, lines: sortLines(lines), totals: totalsFor(lines), ...extra });

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  const estimateId = String(req.query?.estimateId || '').trim();
  // Without this an estimate with no id would read and write a single shared
  // bucket keyed on '', quietly mixing line items between records.
  if (!estimateId) return res.status(400).json({ error: 'estimateId required' });

  try {
    if (req.method === 'GET') {
      const lines = await readLines(db, estimateId);
      return respond(res, estimateId, lines, { count: lines.length });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = String(body.action || '');
    const current = await readLines(db, estimateId);

    if (action === 'add') {
      const incoming = Array.isArray(body.lines) ? body.lines : [];
      const added = [];
      for (const l of incoming) {
        const row = cleanLine(l, await nextLineId(db));
        // A line with an id and nothing else is a blank row on the estimate.
        if (Object.keys(row).length > 1) added.push(row);
      }
      if (!added.length) return res.status(400).json({ error: 'no lines with any content' });
      const next = await writeLines(db, estimateId, [...current, ...added]);
      return respond(res, estimateId, next, { added: added.length });
    }

    if (action === 'update') {
      const lineId = String(body.lineId || '');
      const i = current.findIndex(l => String(l.id) === lineId);
      if (i === -1) return res.status(404).json({ error: 'no such line on this estimate' });
      const unknown = Object.keys(body.changes || {}).filter(k => !LINE_FIELDS.includes(k));
      if (unknown.length) return res.status(400).json({ error: `not part of a line: ${unknown.join(', ')}` });
      // cleanLine recomputes Amount from quantity x unit price, so changing
      // either one cannot leave a stale Amount behind — the trap that made
      // FileMaker's own Amount unreliable on API writes.
      const merged = cleanLine({ ...current[i], ...(body.changes || {}) }, current[i].id);
      const next = [...current]; next[i] = merged;
      return respond(res, estimateId, await writeLines(db, estimateId, next));
    }

    if (action === 'remove') {
      const lineId = String(body.lineId || '');
      if (!current.some(l => String(l.id) === lineId)) {
        return res.status(404).json({ error: 'no such line on this estimate' });
      }
      const next = current.filter(l => String(l.id) !== lineId);
      return respond(res, estimateId, await writeLines(db, estimateId, next));
    }

    if (action === 'replace') {
      const incoming = Array.isArray(body.lines) ? body.lines : [];
      const rows = [];
      for (const l of incoming) {
        const row = cleanLine(l, await nextLineId(db));
        if (Object.keys(row).length > 1) rows.push(row);
      }
      return respond(res, estimateId, await writeLines(db, estimateId, rows));
    }

    return res.status(400).json({ error: 'action must be add, update, remove or replace' });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
