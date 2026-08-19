import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { isAdminEmail } from './_admin.js';
import { readLists, readAll, setList, removeList, seedLayout, fetchFromFileMaker } from './_valueLists.js';

// PHASE C3 — Vibe's value lists.
//
//   GET  ?db=…&layout=RCD_New      -> { lists, source: 'vibe' | 'filemaker' | 'none' }
//   GET  ?db=…&all=1               -> { layouts: { <layout>: { <list>: [...] } } }
//   GET  ?db=…&layout=…&compare=1  -> { vibe, filemaker, diff }   (admin)
//   POST ?db=…&layout=…  { action: 'seed' }                        (admin)
//   POST ?db=…&layout=…  { action: 'set', name, values: [...] }    (admin)
//   POST ?db=…&layout=…  { action: 'remove', name }                (admin)
//
// Reads are open to any signed-in user — a dropdown needs them on every page.
// Writes are admin-only: these vocabularies drive what everyone can select, and
// after cutover there is no FileMaker copy to restore them from.

async function requireAdmin(req, res) {
  const session = await getGoogleSession(req);
  if (!session) { res.status(401).json({ error: 'unauthorized' }); return null; }
  if (!(await isAdminEmail(session.email))) {
    res.status(403).json({ error: 'admin only' });
    return null;
  }
  return session;
}

export default async function handler(req, res) {
  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });
  const layout = String(req.query?.layout || '');

  try {
    if (req.method === 'GET') {
      const session = await getGoogleSession(req);
      if (!session) return res.status(401).json({ error: 'unauthorized' });

      if (req.query?.all === '1') return res.status(200).json({ layouts: await readAll(db) });
      if (!layout) return res.status(400).json({ error: 'layout required' });

      if (req.query?.compare === '1') {
        if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'admin only' });
        const vibe = (await readLists(db, layout)) || {};
        const { lists: fm, skipped } = await fetchFromFileMaker(db, layout);
        const names = [...new Set([...Object.keys(vibe), ...Object.keys(fm)])].sort();
        const diff = names.map(name => {
          const a = vibe[name] || [], b = fm[name] || [];
          return {
            name,
            inVibe: a.length, inFileMaker: b.length,
            onlyInFileMaker: b.filter(x => !a.includes(x)),
            onlyInVibe: a.filter(x => !b.includes(x)),
          };
        }).filter(d => d.onlyInFileMaker.length || d.onlyInVibe.length);
        return res.status(200).json({ vibe, filemaker: fm, diff, skipped });
      }

      // The read every dropdown makes.
      //
      // `source` is not decoration — it is how a caller knows whether it is
      // looking at Vibe's own vocabulary or still borrowing FileMaker's, which
      // is exactly the thing C3 exists to change. A layout Vibe has never been
      // seeded for reads through to FileMaker so nothing breaks before cutover.
      const vibe = await readLists(db, layout);
      if (vibe) return res.status(200).json({ lists: vibe, source: 'vibe' });
      try {
        const { lists } = await fetchFromFileMaker(db, layout);
        return res.status(200).json({ lists, source: 'filemaker' });
      } catch {
        return res.status(200).json({ lists: {}, source: 'none' });
      }
    }

    if (req.method === 'POST') {
      if (!(await requireAdmin(req, res))) return undefined;
      if (!layout) return res.status(400).json({ error: 'layout required' });
      const body = req.body || {};

      if (body.action === 'seed')
        return res.status(200).json(await seedLayout(db, layout, { merge: body.merge !== false }));

      if (body.action === 'set') {
        const name = String(body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'name required' });
        if (!Array.isArray(body.values)) return res.status(400).json({ error: 'values must be an array' });
        return res.status(200).json({ lists: await setList(db, layout, name, body.values) });
      }

      if (body.action === 'remove') {
        const name = String(body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'name required' });
        return res.status(200).json(await removeList(db, layout, name));
      }

      return res.status(400).json({ error: 'unknown action' });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
