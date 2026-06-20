// Attachments for an inspection — stored as files in the related Inspections_Pics
// container table (FK = ID = the inspection's _kpt__Inspection_ID).
import { findInLayout, createRecord, deleteRecord, uploadContainer, containerImageUrl, getRecordWithPortals } from './filemaker';
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
  return recordId;
}

export async function deleteAttachment(recordId) {
  const res = await deleteRecord(PICS_LAYOUT, recordId);
  if (res?.messages?.[0]?.code !== '0') throw new Error(res?.messages?.[0]?.message || 'Delete failed');
}

// Generate the inspection report PDF and attach it.
export async function generateAndAttachReport(record) {
  const full = await fullRecord(record);
  const { blob, filename } = await generateInspectionReport(full);
  const file = new File([blob], filename, { type: 'application/pdf' });
  const inspectionId = full.fieldData?._kpt__Inspection_ID || record.fieldData?._kpt__Inspection_ID;
  await uploadAttachment(inspectionId, file, filename);
  return filename;
}

// Generate + download (no attach).
export async function downloadReport(record) {
  const full = await fullRecord(record);
  const { blob, filename } = await generateInspectionReport(full);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

export { inspectionMeta };
