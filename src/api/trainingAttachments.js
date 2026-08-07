// Attachments for a Training (proposal) record.
//
// Backed by Vibe's own file store since v1.0.308 — bytes in Google Drive,
// metadata in Redis (api/_vibeFiles.js). The 46 files that were in FileMaker's
// Training_Pics container table were migrated and hash-verified in v1.0.305.
import { makeVibeAttachments } from './vibeFiles';

export const trainingAttachments = makeVibeAttachments('training');
