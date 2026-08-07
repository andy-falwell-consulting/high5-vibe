// Read Vibe's own file store.
//
//   GET /api/files?db=…&kind=ccs&parentId=12345   → metadata for one record's files
//   GET /api/files?db=…&fileId=F-ccs-23           → the bytes
//   GET /api/files?db=…&stats=1                   → counts, for checking a migration
//
// The bytes are served through here rather than by link-sharing the Drive file:
// an attachment can be an inspection photo of somebody's property, and a Drive
// link works for anyone who has it forever. This route requires a session and
// hands back only what was asked for.
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { Redis } from '@upstash/redis';
import { FK, SOURCES, listForParent, getFile, driveToken } from './_vibeFiles.js';
import { downloadFile } from './_backupDrive.js';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await getGoogleSession(req))) return res.status(401).json({ error: 'Not authenticated' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  try {
    const fileId = req.query?.fileId && String(req.query.fileId);
    if (fileId) {
      const meta = await getFile(db, fileId);
      if (!meta?.driveId) return res.status(404).json({ error: 'no such file' });
      const bytes = await downloadFile(await driveToken(), meta.driveId);
      res.setHeader('Content-Type', meta.mime || 'application/octet-stream');
      res.setHeader('Content-Length', String(bytes.length));
      // inline so a PDF opens in the browser rather than landing in Downloads;
      // the name is quoted because plenty of them contain spaces.
      res.setHeader('Content-Disposition',
        `${req.query?.download ? 'attachment' : 'inline'}; filename="${String(meta.name || 'file').replace(/"/g, '')}"`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.status(200).send(bytes);
    }

    if (req.query?.stats) {
      const [files, parents] = await Promise.all([redis.hlen(FK.file(db)), redis.hlen(FK.byParent(db))]);
      const perKind = {};
      for (const kind of Object.keys(SOURCES)) {
        perKind[kind] = await redis.get(FK.report(db) + `:${kind}:last`);
      }
      return res.status(200).json({ db, files, parents, lastBatch: perKind });
    }

    const kind = String(req.query?.kind || '');
    const parentId = String(req.query?.parentId || '');
    if (!SOURCES[kind]) return res.status(400).json({ error: `kind must be one of ${Object.keys(SOURCES).join(', ')}` });
    if (!parentId) return res.status(400).json({ error: 'parentId is required' });

    const files = (await listForParent(db, kind, parentId))
      .map(({ driveId, ...f }) => f)   // the Drive id is not the client's business
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return res.status(200).json({ kind, parentId, files, count: files.length });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
