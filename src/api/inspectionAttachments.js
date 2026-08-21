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
import { pinnedByInspectionId } from './offlineStore';
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

async function reportInputs(record) {
  const full = await fullRecord(record);
  const inspectionId = full.fieldData?._kpt__Inspection_ID || record.fieldData?._kpt__Inspection_ID;
  const lines = await listLines(inspectionId).catch(() => []);
  return { full, inspectionId, lines };
}

// Generate the inspection report PDF and attach it. `onStage` reports progress
// ('Building PDF…' → 'Uploading…') and the returned card lets the caller show
// the new attachment immediately.
export async function generateAndAttachReport(record, onStage) {
  onStage?.('Building PDF…');
  const { full, inspectionId, lines } = await reportInputs(record);
  const { blob, filename } = await generateInspectionReport(full, lines);
  const file = new File([blob], filename, { type: 'application/pdf' });
  onStage?.('Uploading…');
  return uploadAttachment(inspectionId, file, filename);
}

// Generate + download (no attach).
export async function downloadReport(record, onStage) {
  onStage?.('Building PDF…');
  const { full, lines } = await reportInputs(record);
  const { blob, filename } = await generateInspectionReport(full, lines);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

export { inspectionMeta };

// What <AttachmentsPanel> is actually given. The offline fallback has to be ON
// THIS OBJECT, not merely exported alongside it: the panel calls `api.list`, so
// a wrapper the panel never reaches would look correct in this file and do
// nothing on screen.
export const inspectionAttachments = { ...attachments, list: listAttachments };
