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

const INSPECTIONS_LAYOUT = 'Inspections_New';

const attachments = makeVibeAttachments('inspection');

export const listAttachments = attachments.list;
export const uploadAttachment = attachments.upload;
export const deleteAttachment = attachments.remove;
export const getFreshAttachmentUrl = attachments.freshUrl;

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

// Generate the inspection report PDF and attach it. `onStage` reports progress
// ('Building PDF…' → 'Uploading…') and the returned card lets the caller show
// the new attachment immediately.
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

export const inspectionAttachments = attachments;
