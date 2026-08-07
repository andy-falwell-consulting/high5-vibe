import { getCurrentEnv } from '../config/fmpEnvironments';

// Client for Vibe's own file store (api/files*.js).
//
// Deliberately the same shape `makeAttachments` returns — { list, upload,
// remove, freshUrl } — so the CCS, training and inspection modules switch over
// by changing which factory they call, and AttachmentsPanel doesn't change at
// all.
//
// Two things simply go away compared with the FileMaker version:
//   - No expiring URLs. FileMaker mints container URLs per session and they die
//     with it, which is why the old code force-reset the session on every click.
//     /api/files serves from a stable id, so `freshUrl` is just the same URL.
//   - No orphan rows. The old upload created a record, uploaded into it, and
//     deleted the record again if the upload failed. Here one request either
//     stores a file or doesn't.

const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tif', 'tiff'];
const isImage = name => IMG_EXT.includes((name || '').split('.').pop().toLowerCase());

const qs = extra => `db=${encodeURIComponent(getCurrentEnv().db)}${extra ? `&${extra}` : ''}`;

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const fileUrl = id => `/api/files?${qs(`fileId=${encodeURIComponent(id)}`)}`;

// FileMaker's timestamps read '01/28/2026 09:52:54'; files added here store an
// ISO string. Both are passed through untouched — the panel only displays them,
// and inventing a single format would misrepresent one of them.
const toCard = f => ({
  recordId: f.id,
  name: f.name,
  created: f.createdAt || '',
  by: f.createdBy || '',
  isImage: isImage(f.name) || String(f.mime || '').startsWith('image/'),
  hasFile: true,
  url: fileUrl(f.id),
  size: f.size,
  source: f.source,
});

export function makeVibeAttachments(kind) {
  async function list(parentId) {
    if (!parentId) return [];
    const body = await json(await fetch(
      `/api/files?${qs(`kind=${kind}&parentId=${encodeURIComponent(parentId)}`)}`,
      { credentials: 'include' }));
    return (body.files || []).map(toCard);
  }

  async function upload(parentId, file, filename) {
    const name = filename || file.name || 'file';
    const body = await json(await fetch(
      `/api/files-write?${qs(`kind=${kind}&parentId=${encodeURIComponent(parentId)}`)}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-filename': name },
        body: file,
      }));
    return toCard(body.file);
  }

  async function remove(id) {
    await json(await fetch(`/api/files-write?${qs(`fileId=${encodeURIComponent(id)}`)}`,
      { method: 'DELETE', credentials: 'include' }));
  }

  // Kept so the panel's interface is unchanged. Nothing to refresh — the URL is
  // stable — but returning it means a click behaves the same as before.
  async function freshUrl(id) { return fileUrl(id); }

  return { list, upload, remove, freshUrl };
}
