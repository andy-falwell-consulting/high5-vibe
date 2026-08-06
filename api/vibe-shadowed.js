// FileMaker changes hidden under a Vibe edit.
//
//   GET    /api/vibe-shadowed?db=High5_Core4&layout=RCD_New  → the list
//   DELETE /api/vibe-shadowed?db=...&layout=...              → acknowledge and clear
//
// The honest cost of one-way sync, made visible. When FileMaker changes a field
// Vibe has already overridden, that change arrives, lands in repl:, and is then
// hidden by the overlay — nobody sees it. The sync records those; this reads
// them back.
//
// It is also how "is anyone still editing in FMP Pro?" gets answered with
// evidence rather than opinion. Empty means nobody is, and the merge layer can
// eventually be deleted. Not empty tells us who is working where, and on which
// fields.
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail } from './_admin.js';
import { ALLOWED_DBS } from './_fmp.js';
import { VIBE_OWNED, readShadowed, clearShadowed } from './_vibeStore.js';

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  const db = String(req.query?.db || '');
  const layout = String(req.query?.layout || 'RCD_New');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });
  if (!VIBE_OWNED.has(layout)) return res.status(400).json({ error: `${layout} is not Vibe-owned` });

  try {
    if (req.method === 'DELETE') {
      await clearShadowed(db, layout);
      return res.status(200).json({ cleared: true, db, layout });
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

    const rows = await readShadowed(db, layout);
    return res.status(200).json({
      db, layout,
      count: rows.length,
      records: rows.slice(0, 100),
      // Flat list of which fields are being fought over, most contested first —
      // usually more actionable than the per-record detail.
      fields: Object.entries(rows.flatMap(r => r.fields.map(f => f.field))
        .reduce((acc, f) => ({ ...acc, [f]: (acc[f] || 0) + 1 }), {}))
        .sort((a, b) => b[1] - a[1])
        .map(([field, n]) => ({ field, records: n })),
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
