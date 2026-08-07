// Attachments for a CCS (RCD) record — stored in the related RCD_Pics container
// table, linked by ID = the project's _kpt__RCD_ID.
//
// This said `rcd_id` until 2026-08-07, and that field is empty in all 69 rows:
// the find matched nothing, so every existing CCS attachment was invisible in
// the app. Measured once the fields were placed on the layout — RCD_Pics.ID is
// filled 69/69 and every sampled value is a real RCD id, the same arrangement
// Training_Pics uses.
import { makeAttachments } from './recordAttachments';

export const {
  list: listCcsAttachments,
  upload: uploadCcsAttachment,
  remove: deleteCcsAttachment,
  freshUrl: ccsAttachmentUrl,
} = makeAttachments({
  picsLayout: 'RCD_Pics',
  container: 'image',
  fkField: 'ID',
  nameField: 'File Name',
});
