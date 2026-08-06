// Google Drive helpers for the backup exporter.
// Files starting with _ are not Vercel routes.
//
// Uses the CALLER's Google access token (the app already requests drive scope).
// That is fine for a manual, admin-triggered export. The scheduled daily run
// will need a credential that doesn't expire — the OAuth client is unverified,
// so Google kills its refresh tokens after 7 days. See the backup section of
// docs/vibe-owns-the-record.md.
//
// Every call passes supportsAllDrives / includeItemsFromAllDrives. The backup
// root is shared with the admin rather than owned by them, which is how a
// Shared Drive presents — and Drive rejects writes into a Shared Drive without
// those flags. They are harmless for an ordinary My Drive folder, so they are
// set unconditionally rather than guessed at per destination.

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const ALL_DRIVES = 'supportsAllDrives=true&includeItemsFromAllDrives=true';

async function driveJson(res, what) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Drive ${what} failed: ${msg}`);
  }
  return body;
}

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Exact-name lookup within a folder, trashed items ignored.
async function findByName(token, name, parentId, mimeType) {
  const q = [
    `name = '${esc(name)}'`,
    `'${esc(parentId)}' in parents`,
    'trashed = false',
    mimeType ? `mimeType = '${esc(mimeType)}'` : null,
  ].filter(Boolean).join(' and ');
  const res = await fetch(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&${ALL_DRIVES}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await driveJson(res, 'lookup');
  return body.files?.[0] || null;
}

// One folder per day, reused on a second run rather than duplicated. Drive
// happily creates two folders with the same name, which would leave two
// "today" folders and no way to tell which manifest is current.
export async function ensureFolder(token, name, parentId) {
  const existing = await findByName(token, name, parentId, 'application/vnd.google-apps.folder');
  if (existing) return { ...existing, reused: true };
  const res = await fetch(`${DRIVE}/files?fields=id,name&${ALL_DRIVES}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  return { ...(await driveJson(res, 'folder create')), reused: false };
}

// Resumable upload rather than multipart: Drive's multipart path is only
// recommended below 5MB, and resumable handles any size for barely more code.
//
// If a file of the same name already exists in the folder its CONTENT is
// replaced, so re-running on the same day updates the day's backup instead of
// littering it with duplicates. Drive does not overwrite by name on its own.
//
// Asks for md5Checksum in the response: Drive computes it from what it actually
// received, so comparing it to a locally computed md5 is a genuine end-to-end
// integrity check rather than us marking our own homework.
export async function uploadFile(token, { name, parentId, bytes, mimeType = 'application/gzip' }) {
  const existing = await findByName(token, name, parentId);

  const url = existing
    ? `${UPLOAD}/files/${existing.id}?uploadType=resumable&fields=id,name,size,md5Checksum&${ALL_DRIVES}`
    : `${UPLOAD}/files?uploadType=resumable&fields=id,name,size,md5Checksum&${ALL_DRIVES}`;

  const init = await fetch(url, {
    method: existing ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(bytes.length),
    },
    // parents is only valid on create; sending it on an update is rejected.
    body: JSON.stringify(existing ? { name } : { name, parents: [parentId] }),
  });
  if (!init.ok) {
    const body = await init.json().catch(() => ({}));
    throw new Error(`Drive upload init failed: ${body?.error?.message || `HTTP ${init.status}`}`);
  }
  const sessionUri = init.headers.get('location');
  if (!sessionUri) throw new Error('Drive upload init returned no session URI');

  const put = await fetch(sessionUri, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType, 'Content-Length': String(bytes.length) },
    body: bytes,
  });
  const file = await driveJson(put, 'upload');
  return { ...file, replaced: !!existing };
}

// ── Read side (restore) ───────────────────────────────────────────

export async function findFolder(token, name, parentId) {
  return findByName(token, name, parentId, 'application/vnd.google-apps.folder');
}

// Every file in a backup folder, with the size and checksum Drive holds — so a
// restore can be checked against the manifest before anything is decompressed.
export async function listFolder(token, folderId) {
  const files = [];
  let pageToken;
  do {
    const q = `'${esc(folderId)}' in parents and trashed = false`;
    const url = `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,size,md5Checksum)`
      + `&pageSize=200&${ALL_DRIVES}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const body = await driveJson(await fetch(url, { headers: { Authorization: `Bearer ${token}` } }), 'list');
    files.push(...(body.files || []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return files;
}

export async function downloadFile(token, fileId) {
  const res = await fetch(`${DRIVE}/files/${fileId}?alt=media&${ALL_DRIVES}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive download failed: HTTP ${res.status} ${body.slice(0, 120)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Move a file to the trash by name. Used to retire a stale manifest when a
// day's folder is reused — recoverable from Drive's bin rather than destroyed.
export async function trashFileByName(token, name, parentId) {
  const existing = await findByName(token, name, parentId);
  if (!existing) return null;
  const res = await fetch(`${DRIVE}/files/${existing.id}?fields=id,trashed&${ALL_DRIVES}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
  return driveJson(res, 'trash');
}

export async function trashFileById(token, fileId) {
  const res = await fetch(`${DRIVE}/files/${fileId}?fields=id,trashed&${ALL_DRIVES}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
  return driveJson(res, 'trash');
}
