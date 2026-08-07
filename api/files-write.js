// Add and remove files in Vibe's own store.
//
//   POST   /api/files-write?db=…&kind=ccs&parentId=123   raw bytes
//            headers: content-type, x-filename
//   DELETE /api/files-write?db=…&fileId=VF-100001
//
// Raw bytes rather than multipart, matching api/image.js: the browser sends the
// File straight through, so there is no form parser to keep in step with the
// runtime. bodyParser is off for the same reason.
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { SOURCES, putFile, nextFileId, deleteFile, driveToken, getFile } from './_vibeFiles.js';

// Vercel's request body cap. A 4.5 MB limit would have refused the largest file
// already in the store (6.2 MB), so this is worth stating rather than
// discovering when someone's photo silently fails.
const MAX_BYTES = 25 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > MAX_BYTES) reject(new Error(`file is larger than ${MAX_BYTES / 1048576} MB`));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  try {
    if (req.method === 'DELETE') {
      const fileId = String(req.query?.fileId || '');
      if (!fileId) return res.status(400).json({ error: 'fileId is required' });
      const existing = await getFile(db, fileId);
      if (!existing) return res.status(404).json({ error: 'no such file' });
      const gone = await deleteFile(db, await driveToken(), fileId);
      return res.status(200).json({ deleted: fileId, name: gone?.name, parentId: gone?.parentId });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'POST or DELETE' });

    const kind = String(req.query?.kind || '');
    const parentId = String(req.query?.parentId || '').trim();
    if (!SOURCES[kind]) return res.status(400).json({ error: `kind must be one of ${Object.keys(SOURCES).join(', ')}` });
    // A file with no parent is invisible everywhere in the app, which reads as
    // "the upload failed" rather than "it went nowhere".
    if (!parentId) return res.status(400).json({ error: 'parentId is required' });

    const bytes = await readBody(req);
    if (!bytes.length) return res.status(400).json({ error: 'no file received' });

    const name = String(req.headers['x-filename'] || 'file').slice(0, 200);
    const record = await putFile(db, await driveToken(), {
      id: await nextFileId(db),
      parentKind: kind, parentId, name,
      mime: req.headers['content-type'] || 'application/octet-stream',
      source: 'vibe',
      createdAt: new Date().toISOString(), createdBy: session.email,
    }, bytes);
    const { driveId, ...safe } = record;
    return res.status(200).json({ file: safe });
  } catch (e) {
    const msg = String(e?.message || e);
    return res.status(/larger than/.test(msg) ? 413 : 502).json({ error: msg.slice(0, 300) });
  }
}

export const config = { api: { bodyParser: false } };
