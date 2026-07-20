// Attachments for an inspection — stored as files in the related Inspections_Pics
// container table (FK = ID = the inspection's _kpt__Inspection_ID).
import { findInLayout, createRecord, deleteRecord, uploadContainer, containerImageUrl, getRecordWithPortals, getRecord, invalidateRecord, resetFmpSession } from './filemaker';
import { getCurrentEnv } from '../config/fmpEnvironments';
import { generateInspectionReport, inspectionMeta } from './inspectionReport';

const PICS_LAYOUT = 'Inspections_Pics';
const INSPECTIONS_LAYOUT = 'Inspections_New';
const CONTAINER = 'image';

// The report needs every line item; the default getRecord caps portals at 50,
// so re-fetch the record with a high portal limit before generating.
async function fullRecord(record) {
  try {
    const res = await getRecordWithPortals(INSPECTIONS_LAYOUT, record.recordId, { inspt_INSPLI: 2000 });
    return res?.response?.data?.[0] || record;
  } catch {
    return record;
  }
}

const extOf = name => (name || '').split('.').pop().toLowerCase();
const isImage = name => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tif', 'tiff'].includes(extOf(name));

// Build a card for a just-uploaded file so the grid can show it immediately,
// without waiting on a re-list round-trip. The view link points at a local
// object URL (the bytes we just uploaded); a later reload swaps in the real
// FileMaker streaming URL and authoritative timestamp/author.
function optimisticCard(recordId, fileOrBlob, name) {
  return {
    recordId,
    name,
    created: '',
    by: '',
    isImage: isImage(name),
    hasFile: true,
    url: URL.createObjectURL(fileOrBlob),
  };
}

// List attachments for an inspection (by its _kpt__Inspection_ID).
export async function listAttachments(inspectionId) {
  if (!inspectionId) return [];
  const res = await findInLayout(PICS_LAYOUT, [{ ID: String(inspectionId) }], { sort: [{ fieldName: 'CreationTimestamp', sortOrder: 'descend' }] });
  // 401/no-match → empty
  const rows = res?.response?.data || [];
  return rows.map(r => {
    const fd = r.fieldData;
    const name = fd['File Name'] || `Attachment ${r.recordId}`;
    const streaming = fd[CONTAINER];
    return {
      recordId: r.recordId,
      name,
      created: fd.CreationTimestamp || '',
      by: fd.CreatedBy || '',
      isImage: isImage(name),
      hasFile: !!streaming,
      url: streaming ? containerImageUrl(streaming, { db: getCurrentEnv().db, layout: PICS_LAYOUT, recordId: r.recordId, field: CONTAINER }) : null,
    };
  });
}

// Create a linked Inspections_Pics row + upload the file into its container.
export async function uploadAttachment(inspectionId, file, filename) {
  const name = filename || file.name || 'file';
  const created = await createRecord(PICS_LAYOUT, { ID: String(inspectionId), 'File Name': name });
  const recordId = created?.response?.recordId;
  if (!recordId) throw new Error(created?.messages?.[0]?.message || 'Could not create attachment record');
  const up = await uploadContainer(PICS_LAYOUT, recordId, CONTAINER, file, name);
  if (up?.messages?.[0]?.code !== '0') {
    // roll back the empty row so we don't leave an orphan
    deleteRecord(PICS_LAYOUT, recordId).catch(() => {});
    throw new Error(up?.messages?.[0]?.message || 'Upload failed');
  }
  return optimisticCard(recordId, file, name);
}

// FileMaker container streaming URLs are minted per session and expire, so a URL
// captured when the list loaded can later go stale. Re-fetch the record at click
// time for a guaranteed-fresh, working URL — keeps attachments openable and
// downloadable indefinitely. (In prod containerImageUrl resolves to the stable
// /api/image endpoint, which is already durable; this keeps both envs correct.)
// Also force a brand-new FMP session: the server can evict sessions under
// concurrent load, so reusing the current one can mint an already-dead URL.
export async function getFreshAttachmentUrl(recordId) {
  invalidateRecord(PICS_LAYOUT, recordId); // bypass the detail cache
  resetFmpSession();
  const res = await getRecord(PICS_LAYOUT, recordId);
  const streaming = res?.response?.data?.[0]?.fieldData?.[CONTAINER];
  if (!streaming) return null;
  // Open via the proxied container-streaming path in BOTH envs (Vite proxy in
  // dev, Vercel /Streaming_SSL → /api/proxy rewrite in prod). It preserves
  // FileMaker's real Content-Type (e.g. application/pdf) so the browser renders
  // the file inline — unlike /api/image, which is tuned for image thumbnails and
  // mislabels PDFs.
  try {
    const u = new URL(streaming);
    return u.pathname + u.search;
  } catch {
    return streaming;
  }
}

export async function deleteAttachment(recordId) {
  const res = await deleteRecord(PICS_LAYOUT, recordId);
  if (res?.messages?.[0]?.code !== '0') throw new Error(res?.messages?.[0]?.message || 'Delete failed');
}

// Generate the inspection report PDF and attach it. `onStage` reports progress
// ('Building PDF…' → 'Uploading…') and the returned card lets the caller show
// the new attachment immediately. The card's view link reuses the PDF we just
// built (no extra fetch).
export async function generateAndAttachReport(record, onStage) {
  onStage?.('Building PDF…');
  const full = await fullRecord(record);
  const { blob, filename } = await generateInspectionReport(full);
  const file = new File([blob], filename, { type: 'application/pdf' });
  const inspectionId = full.fieldData?._kpt__Inspection_ID || record.fieldData?._kpt__Inspection_ID;
  onStage?.('Uploading…');
  return uploadAttachment(inspectionId, file, filename);
}

// Generate + download (no attach).
export async function downloadReport(record, onStage) {
  onStage?.('Building PDF…');
  const full = await fullRecord(record);
  const { blob, filename } = await generateInspectionReport(full);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

export { inspectionMeta };

// Adapter in the shape AttachmentsPanel expects ({ list, upload, remove,
// freshUrl }), so Inspections can use the shared panel like the other modules.
export const inspectionAttachments = {
  list: listAttachments,
  upload: uploadAttachment,
  remove: deleteAttachment,
  freshUrl: getFreshAttachmentUrl,
};
