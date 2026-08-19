// READ-ONLY audit of the bill-of-materials table, ahead of B2.
//
//   GET /api/bom-audit?db=…&offset=1   → one page of parents, writes nothing
//
// Answers a question worth settling before migrating 125,047 rows: which
// products actually HAVE a bill of materials, and does that agree with which
// products are marked as assemblies? A component list hanging off something
// nobody thinks is an assembly is either a mislabelled product or dead rows,
// and the migration should not be the thing that discovers which.
//
// Returns only the parent ids and per-parent counts for the page — not the rows
// — so the caller can accumulate across pages cheaply. Touches no Redis key and
// makes no FileMaker write.
import { fmpToken, ALLOWED_DBS } from './_fmp.js';
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail } from './_admin.js';

const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
// Layout is a parameter: `Item_ITMLI_billOfMaterials` carries table-wide
// aggregate calcs (s_Cost, s_Total) that FileMaker recomputes per row, making a
// 1,000-row page take over 30 seconds. A lean layout over the same table reads
// in well under a second. Being able to point this at either is how that gets
// measured rather than assumed.
const PAGE = 1000;

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const offset = Math.max(1, Number(req.query?.offset) || 1);
  const LAYOUT = String(req.query?.layout || 'Item_ITMLI_billOfMaterials').trim();
  const limit = Math.min(Math.max(1, Number(req.query?.limit) || PAGE), PAGE);
  try {
    const token = await fmpToken(db);
    const url = `${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${LAYOUT}/records?_limit=${limit}&_offset=${offset}`;
    const page = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
    const rows = page?.response?.data || [];
    const total = page?.response?.dataInfo?.foundCount ?? null;
    const msg = page?.messages?.[0];

    if (!rows.length) {
      if (msg?.code && !['0', '401', '101'].includes(String(msg.code))) {
        return res.status(502).json({ offset, error: msg.message, code: msg.code });
      }
      return res.status(200).json({ offset, total, done: true, parents: {} });
    }

    // parentId -> { rows, withQty, orphanComponent }
    const parents = {};
    let noParent = 0;
    for (const r of rows) {
      const f = r.fieldData || {};
      const id = String(f._kft__Item_ID__parent ?? '').trim();
      if (!id) { noParent++; continue; }
      const p = (parents[id] ||= { rows: 0, withQty: 0, noComponent: 0 });
      p.rows++;
      if (Number(f.Quantity) > 0) p.withQty++;
      if (!String(f._kft__Item_ID__assemblyLine ?? '').trim()) p.noComponent++;
    }
    return res.status(200).json({
      layout: LAYOUT, offset, total, read: rows.length, noParent,
      nextOffset: offset + rows.length, done: rows.length < PAGE, parents,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
