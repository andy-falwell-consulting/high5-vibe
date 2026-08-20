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

// Parent kinds that are Vibe's own and have NO FileMaker counterpart, so they
// cannot live in SOURCES — that map describes container tables to migrate FROM,
// and a migration would go looking for a layout that does not exist.
//
//   wsemail — the files attached to a workshop e-mail template. parentId is the
//             template id (Training, Exam_L1, Exam_L2, Exam_L3).
export const NATIVE_KINDS = new Set(['wsemail']);

/** Kinds the file store will accept as a parent. */
export const isFileKind = k => !!SOURCES[k] || NATIVE_KINDS.has(k);

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

// ── Where the bytes go ────────────────────────────────────────────
//
// A FOLDER PER PAGE, THEN A FOLDER PER RECORD, mirroring how the backup lays
// out a folder per day:
//
//   <root>/CCS/4-H Camp Bristol Hills (1234)/site photo.jpg
//   <root>/Trainings/Brattleboro Union HS (5493)/roster.xlsx
//
// This used to be ONE FLAT FOLDER with the identity encoded in the filename —
// `ccs-1234-a7f3-site photo.jpg`. That is findable by a machine and not by a
// person, which defeats the reason the bytes are in Drive at all: the point of
// retiring FileMaker is that nothing ends up somewhere only Vibe can reach, and
// a folder of 130 prefixed filenames is only nominally reachable.
//
// The path now carries the identity, so the file keeps its own plain name.
const ATTACH_ROOT = process.env.FILES_DRIVE_FOLDER_ID || '19WTb3X2HrNW78X6uWLgsqMQtWkptLz7F';

// Page names as a person knows them, not the internal kind. `wsemail` is the
// odd one: its "records" are the four e-mail templates rather than rows on a
// page, which is a slight stretch of the pattern but reads correctly.
export const PAGE_FOLDER = {
  ccs: 'CCS',
  inspection: 'Inspections',
  training: 'Trainings',
  wsemail: 'Workshop e-mails',
};

// Drive tolerates most characters, but a slash reads as a path separator in
// enough clients to be worth removing, and a leading dot hides the folder.
const safeName = s => String(s ?? '')
  .replace(/[/\\]/g, '-')                       // reads as a path separator
  .split('').filter(c => c.charCodeAt(0) > 31).join('')   // control chars
  .replace(/^\.+/, '')                           // a leading dot hides the folder
  .trim().slice(0, 120);

/** `Label (id)` — readable at a glance and still unique.
 *  Name alone would merge two records that share an organisation name, and
 *  there are already duplicates in the data. Id alone is stable but no more
 *  navigable than the flat filenames this replaces. */
export const recordFolderName = (label, parentId) => {
  const l = safeName(label);
  return l ? `${l} (${parentId})` : String(parentId);
};

// Resolved folder ids, cached in Redis. Without this every upload costs two
// Drive lookups; the ids never change once created.
const folderCacheKey = db => `vibe:${db}:file:folders`;

async function cachedFolder(db, cacheField, resolve) {
  const key = folderCacheKey(db);
  try {
    const hit = await redis.hget(key, cacheField);
    if (hit) return String(hit);
  } catch { /* cache miss is not fatal */ }
  const id = await resolve();
  try { await redis.hset(key, { [cacheField]: id }); } catch { /* ignore */ }
  return id;
}

/** The root every attachment lives under. Takes no token: it is a fixed folder
 *  now rather than one looked up by name each time. Kept async, and kept in
 *  place, because files-migrate.js calls it. */
export async function filesFolder() {
  return ATTACH_ROOT;
}

/** `<root>/<Page>/<Label (id)>` — created on demand, then remembered. */
export async function recordFolder(db, token, kind, parentId, label) {
  const page = PAGE_FOLDER[kind] || safeName(kind) || 'Other';
  const pageId = await cachedFolder(db, `page:${kind}`, async () =>
    (await ensureFolder(token, page, ATTACH_ROOT)).id);
  const folderName = recordFolderName(label, parentId);
  // Keyed on the NAME, not just the id: if a record is renamed the label
  // changes, and a stale cache entry would keep filing new uploads into the
  // old folder while the app showed the new name.
  return cachedFolder(db, `rec:${kind}:${parentId}:${folderName}`, async () =>
    (await ensureFolder(token, folderName, pageId)).id);
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
// The old flat-folder name. No longer used for new uploads — kept because the
// re-foldering migration has to recognise the files it is moving.
export const driveName = (meta) =>
  `${meta.parentKind}-${meta.parentId}-${meta.id}-${(meta.name || 'file').replace(/[/\\]/g, '_')}`;

export async function putFile(db, token, meta, bytes) {
  const folderId = await recordFolder(db, token, meta.parentKind, meta.parentId, meta.parentLabel);
  const up = await uploadFile(token, {
    // The plain filename: the PATH carries the identity now. overwrite:false
    // because two files legitimately called "photo.jpg" on one record must stay
    // two files — Drive allows duplicate names, and overwriting would leave one
    // metadata row pointing at bytes belonging to the other.
    name: safeName(meta.name) || 'file',
    parentId: folderId, bytes, mimeType: meta.mime || 'application/octet-stream',
    overwrite: false,
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
