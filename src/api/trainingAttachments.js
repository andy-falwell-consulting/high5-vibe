// Attachments for a Training (proposal) record — stored in the related
// Training_Pics container table. The relationship is keyed on
// Training_Pics::ID = trainings::_kpt__TrainingProposal_ID (verified against the
// live file; the `rcd_id`/`ID_Parent` columns are leftover/unused clones of
// RCD_Pics and stay blank). So `fkField` here is the oddly-named `ID`.
import { makeAttachments } from './recordAttachments';

export const trainingAttachments = makeAttachments({
  picsLayout: 'Training_Pics',
  container: 'image',
  fkField: 'ID',          // holds the parent _kpt__TrainingProposal_ID
  nameField: 'File Name',
});
