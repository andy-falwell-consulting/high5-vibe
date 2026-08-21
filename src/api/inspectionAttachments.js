// Attachments for an inspection.
//
// Backed by Vibe's own file store since v1.0.308 — bytes in Google Drive,
// metadata in Redis (api/_vibeFiles.js). The 20 files that were in FileMaker's
// Inspections_Pics container table were migrated and hash-verified in v1.0.305.
//
// Report generation still lives here because it is inspection-specific; only
// where the finished PDF is stored has changed.
import { getRecordWithPortals } from './filemaker';
import { makeVibeAttachments } from './vibeFiles';
import { generateInspectionReport, inspectionMeta } from './inspectionReport';
import { listLines } from './inspectionLinesVibe';
import { pinnedByInspectionId, STORES, idbPut, idbGet, idbDelete } from './offlineStore';
import { enqueue, pendingEntries, discardEntry, updateEntryPayload } from './outbox';
import { downscaleImage, toDataUrl, jpegName } from './photos';
import { getCurrentEnv } from '../config/fmpEnvironments';

const INSPECTIONS_LAYOUT = 'Inspections_New';

const attachments = makeVibeAttachments('inspection');

/**
 * The file list, falling back to what "Take offline" recorded.
 *
 * The LIST, not the bytes. Pinning stores each file's name, size and date so an
 * inspector can see that last year's report is attached; the files themselves
 * are still in Drive, so a thumbnail will not render and a click will not open
 * anything until there is a signal. Showing the list is still worth it — the
 * alternative offline is a panel that says a record has no attachments, which
 * is a different and wrong claim.
 */
export async function listAttachments(parentId) {
  try {
    return await attachments.list(parentId);
  } catch (e) {
    const pin = await pinnedByInspectionId(getCurrentEnv().db, INSPECTIONS_LAYOUT, parentId).catch(() => null);
    if (pin?.attachments) return pin.attachments;
    throw e;
  }
}
export const uploadAttachment = attachments.upload;
export const deleteAttachment = attachments.remove;
export const getFreshAttachmentUrl = attachments.freshUrl;

// The report needs every line item. They come from Vibe's store, keyed by the
// inspection's own _kpt__Inspection_ID.
//
// The record is still re-fetched with a high portal limit: it supplies the
// cover-page fields, and its portal is the fallback the report falls back to
// when Vibe holds no lines for this inspection (getRecord otherwise caps
// portals at 50, which is what used to truncate long reports).
async function fullRecord(record) {
  try {
    const res = await getRecordWithPortals(INSPECTIONS_LAYOUT, record.recordId, { inspt_INSPLI: 2000 });
    return res?.response?.data?.[0] || record;
  } catch {
    return record;
  }
}

async function reportInputs(record, onStage) {
  const full = await fullRecord(record);
  const inspectionId = full.fieldData?._kpt__Inspection_ID || record.fieldData?._kpt__Inspection_ID;
  const lines = await listLines(inspectionId).catch(() => []);
  const photos = await reportPhotos(inspectionId, onStage).catch(() => []);
  return { full, inspectionId, lines, photos };
}

// Generate the inspection report PDF and attach it. `onStage` reports progress
// ('Building PDF…' → 'Uploading…') and the returned card lets the caller show
// the new attachment immediately.
export async function generateAndAttachReport(record, onStage) {
  onStage?.('Building PDF…');
  const { full, inspectionId, lines, photos } = await reportInputs(record, onStage);
  onStage?.('Building PDF…');
  const { blob, filename } = await generateInspectionReport(full, lines, photos);
  const file = new File([blob], filename, { type: 'application/pdf' });
  onStage?.('Uploading…');
  return uploadAttachment(inspectionId, file, filename);
}

// Generate + download (no attach).
export async function downloadReport(record, onStage) {
  onStage?.('Building PDF…');
  const { full, lines, photos } = await reportInputs(record, onStage);
  onStage?.('Building PDF…');
  const { blob, filename } = await generateInspectionReport(full, lines, photos);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

export { inspectionMeta };

// ── Photos, in a field, with no signal ────────────────────────────
//
// An upload is a POST to Drive, so it is the one attachment operation that
// cannot degrade gracefully — which is why a photo taken on a course goes into
// the same outbox an edit does. Every photo is downscaled BEFORE it is stored:
// see src/api/photos.js for why 1600px, and for the EXIF orientation trap that
// otherwise turns portrait photos sideways in the report.
//
// The blob lives in its own IndexedDB store, referenced by key, so the queue
// itself stays small and readable rather than carrying megabytes per entry.

const blobUrls = new Map();   // blobKey -> object URL, so a thumbnail is drawn once

/** A card for a photo that is queued but has not been uploaded yet. */
function pendingCard(entry) {
  const url = blobUrls.get(entry.blobKey) || null;
  return {
    recordId: entry.id,                 // the outbox id — this has no file id yet
    name: entry.payload.name,
    created: new Date(entry.createdAt).toISOString(),
    by: entry.payload.by || '',
    isImage: true, hasFile: true,
    url, size: entry.payload.size,
    source: 'vibe',
    inReport: !!entry.payload.inReport,
    pending: true,
  };
}

async function pendingPhotos(parentId) {
  const entries = (await pendingEntries().catch(() => []))
    .filter(e => e.kind === 'photo' && String(e.payload?.parentId) === String(parentId));
  for (const e of entries) {
    if (blobUrls.has(e.blobKey)) continue;
    const blob = await idbGet(STORES.BLOBS, e.blobKey).catch(() => null);
    if (blob) blobUrls.set(e.blobKey, URL.createObjectURL(blob));
  }
  return entries.map(pendingCard);
}

/**
 * Attach a file, queueing it if it cannot be sent now.
 *
 * `recordId` is the inspection's FileMaker recordId, not the id the file store
 * keys on. It is here so a queued photo sorts alongside that inspection's other
 * queued work — the record's edits must replay first, because the photo's Drive
 * folder is NAMED from the record.
 */
async function uploadOrQueue(recordId, parentId, file, filename, parentLabel) {
  const shrunk = await downscaleImage(file);
  const isPhoto = String(file.type || '').startsWith('image/');
  const name = isPhoto ? jpegName(filename || file.name) : (filename || file.name || 'file');

  if (navigator.onLine) {
    try {
      const toSend = shrunk instanceof File ? shrunk : new File([shrunk], name, { type: shrunk.type || file.type });
      return await attachments.upload(parentId, toSend, name, parentLabel);
    } catch (e) {
      // A server refusal is not something queueing will fix; only an
      // unreachable network is.
      const unreachable = e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(String(e?.message || ''));
      if (!unreachable) throw e;
    }
  }

  const blobKey = `ph_${Date.now().toString(36)}_${Math.round(performance.now() * 1000).toString(36)}`;
  await idbPut(STORES.BLOBS, shrunk, blobKey);
  const entry = await enqueue({
    kind: 'photo', layout: INSPECTIONS_LAYOUT, recordId, inspectionId: parentId,
    label: parentLabel || '', blobKey,
    payload: { parentId, name, mime: shrunk.type || file.type || 'image/jpeg', size: shrunk.size, parentLabel },
  });
  blobUrls.set(blobKey, URL.createObjectURL(shrunk));
  return pendingCard(entry);
}

/**
 * Tick or untick a photo, whether or not it has been uploaded.
 *
 * A photo taken on a course has no file id to flag against until it syncs, so
 * the tick is recorded on its queue entry and applied when it lands. Without
 * this, the one moment an inspector is actually looking at the finding is the
 * one moment they cannot say "this goes in the report".
 */
async function setFlags(id, patch) {
  const queued = (await pendingEntries().catch(() => [])).find(e => e.id === id);
  if (queued) {
    const updated = await updateEntryPayload(id, patch);
    return pendingCard(updated || queued);
  }
  return attachments.setFlags(id, patch);
}

/** Remove a photo that has not been sent yet — the queue entry and its bytes. */
async function removeAttachment(id) {
  const queued = (await pendingEntries().catch(() => [])).find(e => e.id === id);
  if (queued) {
    await idbDelete(STORES.BLOBS, queued.blobKey).catch(() => {});
    const url = blobUrls.get(queued.blobKey);
    if (url) { URL.revokeObjectURL(url); blobUrls.delete(queued.blobKey); }
    return discardEntry(id);
  }
  return attachments.remove(id);
}

/**
 * The photos ticked to appear in the report, as data URIs pdfmake can hold.
 *
 * A photo still in the queue is read from the device rather than the server, so
 * a report can be generated on site before anything has uploaded.
 */
export async function reportPhotos(parentId, onStage) {
  const files = await listAttachments(parentId).catch(() => []);
  const chosen = files.filter(f => f.inReport && f.isImage);
  const out = [];
  for (const [i, f] of chosen.entries()) {
    onStage?.(`Adding photo ${i + 1} of ${chosen.length}…`);
    try {
      // A queued photo's url is an object URL over the blob still on this
      // device, so this reads from the iPad rather than the network and a
      // report can be built on site before anything has uploaded.
      if (!f.url) throw new Error(`photo ${f.name} has no readable copy`);
      const res = await fetch(f.url, f.pending ? undefined : { credentials: 'include' });
      if (!res.ok) throw new Error(`photo ${f.name} could not be read`);
      out.push({ dataUrl: await toDataUrl(await res.blob()), caption: f.name });
    } catch {
      // One unreadable photo must not cost the whole report.
    }
  }
  return out;
}

// What <AttachmentsPanel> is actually given. The offline fallback has to be ON
// THIS OBJECT, not merely exported alongside it: the panel calls `api.list`, so
// a wrapper the panel never reaches would look correct in this file and do
// nothing on screen.
export const inspectionAttachments = { ...attachments, list: listAttachments, remove: removeAttachment, setFlags };

/**
 * The same panel API, bound to one inspection's FileMaker recordId.
 *
 * The panel only knows the id the FILE STORE keys on
 * (`_kpt__Inspection_ID`), and a queued photo needs the record's own id so it
 * sorts with that inspection's other queued work. Binding it here keeps the
 * shared five-module panel's interface exactly as it was.
 */
export function inspectionAttachmentsFor(recordId) {
  return {
    ...inspectionAttachments,
    async list(parentId) {
      const [stored, queued] = await Promise.all([
        listAttachments(parentId).catch(() => []),
        pendingPhotos(parentId),
      ]);
      // Queued first: the photo just taken is the one being looked for.
      return [...queued, ...stored];
    },
    upload: (parentId, file, filename, parentLabel) =>
      uploadOrQueue(recordId, parentId, file, filename, parentLabel),
  };
}
