// Move FileMaker's container files into Vibe's own store.
//
//   POST /api/files-migrate?db=…&kind=ccs|inspection|training&offset=1&limit=8
//   GET  /api/files-migrate?db=…    → the last report
//
// Batched rather than run in one pass: 130 files totalling 41 MB is small, but
// each one is a FileMaker download plus a Drive upload, and Vercel stops a
// function at 300s. A batch of 8 is comfortably inside that and resumable.
//
// Re-runnable and idempotent. The Vibe file id is derived from the FileMaker
// row (`F-<kind>-<recordId>`), so a second run recognises what it already moved
// and skips it rather than uploading a duplicate to Drive.
import { fmpToken, ALLOWED_DBS } from './_fmp.js';
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail } from './_admin.js';
import { Redis } from '@upstash/redis';
import {
  FK, SOURCES, fetchContainer, putFile, getFile, driveToken, filesFolder,
  fkIsReadable, addToParent,
} from './_vibeFiles.js';

const redis = Redis.fromEnv();
const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';

const extFromUrl = u => {
  const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(String(u).split('?')[0]);
  return m ? m[1].toLowerCase() : 'bin';
};

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  if (req.method === 'GET') {
    return res.status(200).json((await redis.get(FK.report(db))) || { note: 'no file migration has run for this database' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const kind = String(req.query?.kind || '');
  const src = SOURCES[kind];
  if (!src) return res.status(400).json({ error: `kind must be one of ${Object.keys(SOURCES).join(', ')}` });

  const offset = Math.max(1, Number(req.query?.offset) || 1);
  const limit = Math.min(20, Math.max(1, Number(req.query?.limit) || 8));

  try {
    const token = await fmpToken(db);

    // Refuse rather than upload 24 MB that ends up attached to nothing. The
    // operator gets the field and layout to fix, or can pass allowUnattached=1
    // to move the bytes now and let a later run place them.
    const readable = await fkIsReadable(FMP_HOST, db, src.layout, src.fk, token);
    if (!readable && !req.query?.allowUnattached) {
      return res.status(409).json({
        error: `${src.layout} does not expose ${src.fk}, so a file's parent record cannot be read.`,
        fix: `Place the ${src.fk} field on the ${src.layout} layout, or retry with &allowUnattached=1.`,
        kind, layout: src.layout, fk: src.fk,
      });
    }

    const url = `${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${encodeURIComponent(src.layout)}`
      + `/records?_limit=${limit}&_offset=${offset}`;
    const page = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
    const rows = page?.response?.data || [];
    const total = page?.response?.dataInfo?.foundCount ?? null;
    if (!rows.length) return res.status(200).json({ kind, offset, total, done: true });

    // Fetched once per batch, not per file: each call is an RSA signing round
    // trip, and the token outlives a batch comfortably.
    const gtoken = await driveToken();
    await filesFolder(gtoken);

    const moved = [], skipped = [], failed = [], empty = [], reattached = [];
    for (const row of rows) {
      const fd = row.fieldData;
      const id = `F-${kind}-${row.recordId}`;
      const streaming = String(fd[src.container] || '');
      if (!streaming.startsWith('http')) { empty.push(id); continue; }

      const parentId = String(fd[src.fk] ?? '').trim();

      const existing = await getFile(db, id);
      if (existing?.driveId) {
        // Already moved. If it landed unattached and the parent is readable
        // now, place it — cheaper and safer than re-uploading the bytes.
        if (!existing.parentId && parentId) {
          const fixed = { ...existing, parentId };
          await redis.hset(FK.file(db), { [id]: JSON.stringify(fixed) });
          await addToParent(db, fixed);
          reattached.push(id);
        } else skipped.push(id);
        continue;
      }

      try {
        const got = await fetchContainer(streaming, token);
        // Most of these carry no filename anywhere — RCD_Pics has no name field
        // at all — so one is built from the parent and the real extension
        // rather than leaving a row called 'file'.
        const name = (src.nameField && String(fd[src.nameField] || '').trim())
          || got.name
          || `${kind}-${parentId || 'unfiled'}-${row.recordId}.${extFromUrl(streaming)}`;
        const record = await putFile(db, gtoken, {
          id, parentKind: kind, parentId,
          name, mime: got.mime, source: 'filemaker',
          fmLayout: src.layout, fmRecordId: String(row.recordId),
          createdAt: fd.CreationTimestamp || '', createdBy: fd.CreatedBy || '',
          migratedAt: new Date().toISOString(), migratedBy: session.email,
        }, got.bytes);
        moved.push({ id, name: record.name, size: record.size, parentId: record.parentId });
      } catch (e) {
        failed.push({ id, error: String(e?.message || e).slice(0, 200) });
      }
    }

    const result = {
      kind, offset, total, read: rows.length, parentReadable: readable,
      moved: moved.length, skipped: skipped.length, reattached: reattached.length,
      empty: empty.length, failed,
      bytes: moved.reduce((n, m) => n + (m.size || 0), 0),
      // A parent id of '' means the row is in FileMaker but attached to nothing;
      // it is still moved, so nothing is lost, but it will not appear under any
      // record until someone says where it belongs.
      unattached: moved.filter(m => !m.parentId).length,
      nextOffset: offset + rows.length,
      done: rows.length < limit,
    };
    await redis.set(FK.report(db) + `:${kind}:last`, result);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
