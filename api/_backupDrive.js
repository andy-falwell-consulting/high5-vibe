// Google Drive upload helpers for the backup exporter.
// Files starting with _ are not Vercel routes.
//
// Uses the CALLER's Google access token (the app already requests drive scope).
// That is fine for a manual, admin-triggered export. The scheduled daily run
// will need a credential that doesn't expire — the OAuth client is unverified,
// so Google kills its refresh tokens after 7 days. See the backup section of
// docs/vibe-owns-the-record.md.

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

async function driveJson(res, what) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Drive ${what} failed: ${msg}`);
  }
  return body;
}

// Create a dated subfolder for one backup run, so a run is a single unit that
// can be kept, compared or deleted whole.
export async function createFolder(token, name, parentId) {
  const res = await fetch(`${DRIVE}/files?fields=id,name`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  return driveJson(res, 'folder create');
}

// Resumable upload rather than multipart: gzipped Contacts lands around 8MB,
// and Drive's multipart path is only recommended below 5MB. Resumable handles
// any size and is barely more code — initiate, then PUT the bytes.
//
// Asks for md5Checksum in the response: Drive computes it from what it actually
// received, so comparing it to a locally computed md5 is a genuine end-to-end
// integrity check rather than us marking our own homework.
export async function uploadFile(token, { name, parentId, bytes, mimeType = 'application/gzip' }) {
  const init = await fetch(`${UPLOAD}/files?uploadType=resumable&fields=id,name,size,md5Checksum`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(bytes.length),
    },
    body: JSON.stringify({ name, parents: [parentId] }),
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
  return driveJson(put, 'upload');
}
