// Attachments for a CCS (RCD) record — stored in the related RCD_Pics container
// table, linked by rcd_id = the project's _kpt__RCD_ID.
import { makeAttachments } from './recordAttachments';

export const {
  list: listCcsAttachments,
  upload: uploadCcsAttachment,
  remove: deleteCcsAttachment,
  freshUrl: ccsAttachmentUrl,
} = makeAttachments({
  picsLayout: 'RCD_Pics',
  container: 'image',
  fkField: 'rcd_id',
  nameField: 'File Name',
});
