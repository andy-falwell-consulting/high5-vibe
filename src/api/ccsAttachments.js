// Attachments for a CCS (RCD) record.
//
// Backed by Vibe's own file store since v1.0.308 — bytes in Google Drive,
// metadata in Redis (api/_vibeFiles.js). The 64 files that were in FileMaker's
// RCD_Pics container table were migrated and hash-verified in v1.0.305.
//
// The FileMaker version of this file linked on `rcd_id`, which is empty in all
// 69 rows, so its find matched nothing and every existing CCS attachment was
// invisible in the app. That is fixed by no longer asking FileMaker at all.
import { makeVibeAttachments } from './vibeFiles';

const attachments = makeVibeAttachments('ccs');

export const {
  list: listCcsAttachments,
  upload: uploadCcsAttachment,
  remove: deleteCcsAttachment,
  freshUrl: ccsAttachmentUrl,
} = attachments;

export const ccsAttachments = attachments;
