// One-time migration: move existing attachments out of the single flat Drive
// folder and into <root>/<Page>/<Record (id)>/.
//
//   GET  /api/files-refolder?db=High5_Core4              → plan only, writes NOTHING
//   POST /api/files-refolder?db=High5_Core4&confirm=yes  → actually moves them
//
// Admin-only, and read-only by default: the plan is the whole point, because a
// move that goes to the wrong folder is tedious to unpick by hand.
//
// WHY THE LABELS ARE LOOKED UP HERE. New uploads carry the record's name from
// the client, where it is already on screen. These files were uploaded before
// that existed, so the name has to be recovered — and a file's parentId is a
// record's PRIMARY KEY (_kpt__RCD_ID and friends), not its Redis key, so it
// cannot simply be fetched. One HSCAN per layout builds the map instead: three
// passes total, once, rather than a lookup per file.
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail } from './_admin.js';
import { ALLOWED_DBS } from './_fmp.js';
import { FK, driveToken, recordFolder, recordFolderName, PAGE_FOLDER } from './_vibeFiles.js';
import { moveFile } from './_backupDrive.js';

export const config = { maxDuration: 300 };

const redis = Redis.fromEnv();

// kind → where its records live, and what to call one.
const LABEL_SOURCE = {
  ccs:        { layout: 'RCD_New',         pk: '_kpt__RCD_ID',              name: 'zz__Display_Organization__ct' },
  training:   { layout: 'trainings_New',   pk: '_kpt__TrainingProposal_ID', name: 'zz__Display_Organization__ct' },
  inspection: { layout: 'Inspections_New', pk: '_kpt__Inspection_ID',       name: 'Organization' },
  // wsemail's parentId IS the readable name (Training, Exam_L1, …).
};

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

/** primaryKey → display name, for one layout. */
async function labelMap(db, kind) {
  const src = LABEL_SOURCE[kind];
  if (!src) return new Map();
  const out = new Map();
  let cursor = '0';
  do {
    const [next, flat] = await redis.hscan(`repl:${db}:${src.layout}:recs`, cursor, { count: 1000 });
    for (let i = 1; i < flat.length; i += 2) {
      const rec = parse(flat[i]);
      const id = rec?.fieldData?.[src.pk];
      const nm = rec?.fieldData?.[src.name];
      if (id && nm) out.set(String(id), String(nm));
    }
    cursor = String(next);
  } while (cursor !== '0');
  return out;
}

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });
  const commit = req.method === 'POST' && req.query?.confirm === 'yes';

  try {
    const all = (await redis.hgetall(FK.file(db))) || {};
    const files = Object.values(all).map(parse).filter(Boolean);
    if (!files.length) return res.status(200).json({ files: 0, note: 'no attachments recorded' });

    // One label map per kind that has files, not per file.
    const kinds = [...new Set(files.map(f => f.parentKind))];
    const labels = {};
    for (const k of kinds) labels[k] = await labelMap(db, k);

    const token = commit ? await driveToken() : null;
    const plan = [];
    const moved = [];
    const failed = [];
    const folderCache = new Map();

    for (const f of files) {
      const label = labels[f.parentKind]?.get(String(f.parentId)) || (f.parentKind === 'wsemail' ? String(f.parentId) : '');
      const target = `${PAGE_FOLDER[f.parentKind] || f.parentKind}/${recordFolderName(label, f.parentId)}`;
      plan.push({ id: f.id, name: f.name, from: 'flat', to: target, labelled: !!label });
      if (!commit) continue;
      if (!f.driveId) { failed.push({ id: f.id, why: 'no driveId — nothing in Drive to move' }); continue; }
      try {
        const cacheKey = `${f.parentKind}:${f.parentId}:${label}`;
        let folderId = folderCache.get(cacheKey);
        if (!folderId) {
          folderId = await recordFolder(db, token, f.parentKind, f.parentId, label);
          folderCache.set(cacheKey, folderId);
        }
        // moveFile reads the file's current parent itself — see _backupDrive.js.
        // Re-running is harmless: a file already in the right folder is a no-op.
        const r = await moveFile(token, f.driveId, folderId);
        moved.push({ id: f.id, to: target, alreadyThere: r.moved === false });
      } catch (e) {
        failed.push({ id: f.id, why: String(e?.message || e).slice(0, 160) });
      }
    }

    const unlabelled = plan.filter(p => !p.labelled).length;
    return res.status(200).json({
      mode: commit ? 'moved' : 'plan (nothing written)',
      files: files.length,
      byKind: kinds.map(k => ({ kind: k, page: PAGE_FOLDER[k] || k, files: files.filter(f => f.parentKind === k).length })),
      // Worth seeing before committing: a file whose record could not be named
      // still moves, into a folder named by bare id. Correct, just less useful.
      unlabelled,
      ...(commit ? { moved: moved.length, failed } : { sample: plan.slice(0, 25) }),
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
