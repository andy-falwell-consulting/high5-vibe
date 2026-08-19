// Read and write one product's bill of materials — PHASE B2.
//
//   GET  /api/bom-lines?db=…&itemId=1466
//   POST /api/bom-lines?db=…&itemId=1466
//     { action: 'add',     lines: [ { componentItemId, quantity }, … ] }
//     { action: 'update',  lineId, changes: { quantity } }
//     { action: 'remove',  lineId }
//     { action: 'replace', lines: [ … ] }
//
// Same shape as api/estimate-lines.js and api/inspection-lines.js. Every write
// is read-modify-write on that product's single hash field, so two people
// editing different components of the same assembly resolve last-writer-wins on
// the whole array — which is how the FileMaker portal behaved, since a PATCH
// replaced the row set.
//
// No totals are returned. A BOM line's value is the COMPONENT'S unit price
// times quantity, and the component's price lives on the component product —
// which the client already holds in its products cache. Computing it here would
// mean reading every referenced product on every request to produce a number
// the client can work out for free, and the UI already computed it live and
// ignored FileMaker's stored `::Total`.
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS, fmpToken } from './_fmp.js';
import { readLines, writeLines, nextLineId, cleanLine, LINE_FIELDS, linesExist } from './_bomLines.js';

const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';

// Seeding a product the migration never reached, from FileMaker.
//
// This has to happen SERVER-side. The client's portal rows carry the
// component's name and price but NOT its item id — the one field a Vibe line
// needs — so a client-side seed would write an empty bill of materials and wipe
// the product. A find against the BOM layout has the ids.
//
// Refuses above SEED_MAX rather than importing a runaway parent. Ten products
// hold 114,150 of that table's rows, and pulling 29,124 components into Vibe
// because someone opened one and changed a quantity is not a decision this
// endpoint should make silently.
const SEED_MAX = 500;

async function seedFromFileMaker(db, itemId) {
  const token = await fmpToken(db);
  const r = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/BOM/_find`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: [{ _kft__Item_ID__parent: `==${itemId}` }], limit: SEED_MAX + 1 }),
  });
  const j = await r.json();
  const code = j?.messages?.[0]?.code;
  // 401 = no matching records, which is a legitimately empty bill of materials.
  if (code === '401') return [];
  if (code !== '0') throw new Error(j?.messages?.[0]?.message || 'could not read the existing bill of materials');

  const rows = j?.response?.data || [];
  if (rows.length > SEED_MAX) {
    throw new Error(
      `This product has ${rows.length}+ component rows in FileMaker, which is far beyond a normal bill of materials. `
      + 'It was deliberately left out of the migration pending a decision — see docs/b2-bom-scope.md. '
      + 'Editing it here would import all of them.');
  }
  return rows.map(row => ({
    id: String(row.fieldData?._kpt__Item_Line_Item_ID || row.recordId),
    componentItemId: String(row.fieldData?._kft__Item_ID__assemblyLine ?? '').trim(),
    quantity: Number(row.fieldData?.Quantity) || 0,
  })).filter(l => l.componentItemId);
}

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  const itemId = String(req.query?.itemId || '').trim();
  // Without this a product with no id would read and write a single shared
  // bucket keyed on '', quietly mixing components between assemblies.
  if (!itemId) return res.status(400).json({ error: 'itemId required' });

  try {
    if (req.method === 'GET') {
      const lines = await readLines(db, itemId);
      // `migrated` separates a product Vibe knows about — even one whose
      // components were all removed — from one it has never seen. The client
      // falls back to FileMaker's portal only for the latter.
      return res.status(200).json({ itemId, lines, count: lines.length, migrated: await linesExist(db, itemId) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = String(body.action || '');

    // First write to a product Vibe has never seen: bring its existing
    // components across before applying the change, or the write would leave
    // Vibe holding only what was just edited.
    if (!(await linesExist(db, itemId))) {
      await writeLines(db, itemId, await seedFromFileMaker(db, itemId));
    }
    const current = await readLines(db, itemId);

    if (action === 'add') {
      const incoming = Array.isArray(body.lines) ? body.lines : [];
      const added = [];
      for (const l of incoming) {
        const row = cleanLine(l, await nextLineId(db));
        // A component line that names no component cannot be rendered or
        // priced — 779 rows in FileMaker were in exactly that state and were
        // left behind by the migration. Do not create more.
        if (row.componentItemId) added.push(row);
      }
      if (!added.length) return res.status(400).json({ error: 'no lines with a component' });
      const next = await writeLines(db, itemId, [...current, ...added]);
      return res.status(200).json({ itemId, added: added.length, lines: next });
    }

    if (action === 'update') {
      const lineId = String(body.lineId || '');
      const i = current.findIndex(l => String(l.id) === lineId);
      if (i === -1) return res.status(404).json({ error: 'no such component on this product' });
      const unknown = Object.keys(body.changes || {}).filter(k => !LINE_FIELDS.includes(k));
      if (unknown.length) return res.status(400).json({ error: `not part of a component: ${unknown.join(', ')}` });
      const merged = cleanLine({ ...current[i], ...(body.changes || {}) }, current[i].id);
      const next = [...current]; next[i] = merged;
      return res.status(200).json({ itemId, lines: await writeLines(db, itemId, next) });
    }

    if (action === 'remove') {
      const lineId = String(body.lineId || '');
      if (!current.some(l => String(l.id) === lineId)) {
        return res.status(404).json({ error: 'no such component on this product' });
      }
      const next = current.filter(l => String(l.id) !== lineId);
      return res.status(200).json({ itemId, lines: await writeLines(db, itemId, next) });
    }

    if (action === 'replace') {
      const incoming = Array.isArray(body.lines) ? body.lines : [];
      const rows = [];
      for (const l of incoming) {
        const row = cleanLine(l, l?.id && !String(l.id).startsWith('new:') ? String(l.id) : await nextLineId(db));
        if (row.componentItemId) rows.push(row);
      }
      return res.status(200).json({ itemId, lines: await writeLines(db, itemId, rows) });
    }

    return res.status(400).json({ error: 'action must be add, update, remove or replace' });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
