// Vibe's own file store. Files starting with _ are not Vercel routes.
//
// The bytes live in Google Drive under the service account already set up for
// backups; the metadata lives in Redis. Drive rather than an object store
// because the point of retiring FileMaker is that nothing ends up somewhere
// only Vibe can reach — IT@high5adventure.org owns the folder, so the files
// stay openable by a person with a browser even if this app disappears.
//
//   vibe:{db}:file            fileId → { parentKind, parentId, name, mime, size, driveId, … }
//   vibe:{db}:file:byParent   `${kind}:${parentId}` → [fileId, …]
//
// Production holds 130 files totalling 41 MB across three FileMaker container
// tables, so this is a small store — no sharding, no lifecycle rules.
import { Redis } from '@upstash/redis';
import { getServiceAccountToken } from './_gsa.js';
import { ensureFolder, uploadFile, trashFileById } from './_backupDrive.js';

const redis = Redis.fromEnv();

export const FK = {
  file: db => `vibe:${db}:file`,
  byParent: db => `vibe:${db}:file:byParent`,
  report: db => `vibe:${db}:files:report`,
};

export const parentKey = (kind, id) => `${kind}:${id}`;

// The three FileMaker container tables. The parent key is `ID` on all three —
// established by measurement once the fields were placed on the layouts, not by
// reading the app's config:
//
//   RCD_Pics.ID          filled 69/69, every sampled value a real RCD id
//   RCD_Pics.rcd_id      filled  0/69  ← what ccsAttachments.js queries
//   Inspections_Pics.ID  filled 20/20, every sampled value a real inspection id
//
// I earlier assumed `ID` was the picture's own serial because 23 and 94 looked
// like row numbers. They are project ids. `rcd_id`, `inspection_id` and
// `ID_Parent` all exist and are empty in every row — leftover clones, as
// trainingAttachments.js already noted for Training_Pics.
export const SOURCES = {
  ccs: { layout: 'RCD_Pics', container: 'image', fk: 'ID', nameField: 'File Name' },
  inspection: { layout: 'Inspections_Pics', container: 'image', fk: 'ID', nameField: 'File Name' },
  training: { layout: 'Training_Pics', container: 'image', fk: 'ID', nameField: 'File Name' },
};

// A field can be queryable on these layouts without being readable: a find on
// RCD_Pics by rcd_id matches, but the field is absent from every row that comes
// back. So the parent of a file cannot always be discovered by reading it, and
// the migration has to check rather than assume — an unreadable key yields an
// empty parentId, which would quietly leave every file attached to nothing.
export async function fkIsReadable(host, db, layout, fk, token) {
  const m = await (await fetch(
    `${host}/fmi/data/v2/databases/${db}/layouts/${encodeURIComponent(layout)}`,
    { headers: { Authorization: `Bearer ${token}` } })).json();
  return (m?.response?.fieldMetaData || []).some(f => f.name === fk);
}

const DEFAULT_PARENT = '1xW3xXxRzUnSGKM5pG1dCibFAEQUyHLsi';   // the shared backup folder
const parentFolder = () => process.env.BACKUP_DRIVE_FOLDER_ID || DEFAULT_PARENT;

// One folder, reused. `ensureFolder` looks the name up before creating, so a
// second run doesn't leave two folders called the same thing.
export async function filesFolder(token) {
  const name = process.env.FILES_DRIVE_FOLDER_NAME || 'Vibe attachments';
  if (process.env.FILES_DRIVE_FOLDER_ID) return process.env.FILES_DRIVE_FOLDER_ID;
  const folder = await ensureFolder(token, name, parentFolder());
  return folder.id;
}

export const driveToken = () => getServiceAccountToken();

// Reading a FileMaker container is a two-step handshake, and neither step alone
// works: the Bearer request answers 302 with an X-FMS-Session-Key cookie, and
// the redirect has to be followed carrying it. Without the cookie the streaming
// server answers 401; without the Bearer there is no cookie to get.
export async function fetchContainer(url, fmpToken) {
  const first = await fetch(url, { headers: { Authorization: `Bearer ${fmpToken}` }, redirect: 'manual' });
  if (first.status !== 302) {
    if (!first.ok) throw new Error(`container fetch: HTTP ${first.status}`);
    const bytes = new Uint8Array(await first.arrayBuffer());
    return { bytes, mime: first.headers.get('content-type') || 'application/octet-stream', name: dispositionName(first) };
  }
  const cookie = (first.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const location = new URL(first.headers.get('location'), url).toString();
  const res = await fetch(location, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`container stream: HTTP ${res.status}`);
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    mime: res.headers.get('content-type') || 'application/octet-stream',
    name: dispositionName(res),
  };
}

function dispositionName(res) {
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return m ? decodeURIComponent(m[1]) : null;
}

// Drive is happy to hold two files with the same name, and these often have
// none worth keeping, so the stored name is what a person sees while the Drive
// name carries the ids that make a stray file identifiable.
export const driveName = (meta) =>
  `${meta.parentKind}-${meta.parentId}-${meta.id}-${(meta.name || 'file').replace(/[/\\]/g, '_')}`;

export async function putFile(db, token, meta, bytes) {
  const folderId = await filesFolder(token);
  const up = await uploadFile(token, {
    name: driveName(meta), parentId: folderId, bytes, mimeType: meta.mime || 'application/octet-stream',
  });
  const record = { ...meta, driveId: up.id, size: bytes.byteLength };
  await redis.hset(FK.file(db), { [record.id]: JSON.stringify(record) });
  await addToParent(db, record);
  return record;
}

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

export async function addToParent(db, record) {
  const key = parentKey(record.parentKind, record.parentId);
  const ids = parse(await redis.hget(FK.byParent(db), key)) || [];
  if (!ids.includes(record.id)) ids.push(record.id);
  await redis.hset(FK.byParent(db), { [key]: JSON.stringify(ids) });
  return ids;
}

export async function removeFromParent(db, record) {
  const key = parentKey(record.parentKind, record.parentId);
  const ids = (parse(await redis.hget(FK.byParent(db), key)) || []).filter(x => x !== record.id);
  if (ids.length) await redis.hset(FK.byParent(db), { [key]: JSON.stringify(ids) });
  else await redis.hdel(FK.byParent(db), key);
  return ids;
}

export async function listForParent(db, kind, parentId) {
  const ids = parse(await redis.hget(FK.byParent(db), parentKey(kind, parentId))) || [];
  if (!ids.length) return [];
  const raw = await redis.hmget(FK.file(db), ...ids);
  return (Array.isArray(raw) ? raw : Object.values(raw || {})).map(parse).filter(Boolean);
}

export const getFile = async (db, id) => parse(await redis.hget(FK.file(db), String(id)));

// Files added in Vibe get a VF- id, the same convention as V-/VA-/VM- on
// contacts: a bare number came from FileMaker, anything prefixed is ours.
export async function nextFileId(db) {
  const n = await redis.incr(`vibe:${db}:seq:file`);
  return `VF-${100000 + n}`;
}

// Deleting a migrated file has to be remembered, not just done. Its FileMaker
// row still exists, and the migration keys on that row — so without a tombstone
// the next run would faithfully restore something someone deliberately removed.
// This is the trap contacts hit first (docs/vibe-owns-the-record.md).
export const tombKey = db => `vibe:${db}:file:deleted`;
export const isTombstoned = async (db, id) => !!(await redis.sismember(tombKey(db), String(id)));
export const tombstones = db => redis.smembers(tombKey(db));

// Drive's trash, not a hard delete: 41 MB of files nobody can get back is a
// worse outcome than a bin that needs emptying.
export async function deleteFile(db, token, id) {
  const meta = await getFile(db, id);
  if (!meta) return null;
  // A tombstone on a Vibe-born file would be pointless — nothing would ever
  // recreate it — so only migrated ones are recorded.
  if (meta.driveId) await trashFileById(token, meta.driveId).catch(() => {});
  await redis.hdel(FK.file(db), String(id));
  await removeFromParent(db, meta);
  if (meta.source === 'filemaker') await redis.sadd(tombKey(db), String(id));
  return meta;
}
