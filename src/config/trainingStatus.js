// Training status vocabulary.
//
// MEASURED, not copied from CCS. Across all 2,478 trainings:
//
//   1,493  Final Invoiced      ← terminal
//     753  No Go               ← terminal
//      97  (blank)
//      44  Covid               ← not in the app's own dropdown
//      32  Keene EOL/C&S
//      14  Other
//      12  Follow-up Needed
//      10  Confirmed/Scheduled
//       4  Ready to Bill       ← not in the dropdown
//     ~10  Inquiry / Proposed / Approved / Waiting on $ / Completed / OE / …
//       4  corrupt splices (see below)
//
// So 91% of the table is finished or dead and roughly 35 records are in flight
// at all. A pipeline is therefore NOT the primary reading of a training the way
// it is for a CCS project — it renders for the handful in progress and the
// terminal status stands on its own for everything else.
//
// FOUR RECORDS CARRY SPLICED VALUES — "ComplFinal Invoicedeted",
// "Follow-up NeeNo Goded", "Follow-up NInquiryeeded", "Final InvoicedCompleted".
// Each is two statuses typed into the middle of one another. They are left
// alone here rather than guessed at; they need a human to say what was meant.
import { BRAND, UI } from './brandColors';

// The in-flight progression, in order. Terminal states are deliberately NOT
// stages: a record in one has left the pipeline rather than reached its end.
export const PIPELINE_STAGES = [
  'Inquiry',
  'Follow-up Needed',
  'Proposed',
  'Approved/Needs to be D-Invoiced & TC',
  'Waiting on $ & Signed TC',
  'Confirmed/Scheduled',
  'Ready to Bill',
];

export const PIPELINE_SHORT = [
  'Inquiry', 'Follow-up', 'Proposed', 'Approved', 'Waiting on $', 'Confirmed', 'Ready to bill',
];

// Kanban board columns = every in-flight stage (same set as PIPELINE_STAGES —
// there's no separate "active" subset to carve out here the way CCS does,
// since Trainings has no non-pipeline in-flight status). Terminal statuses
// (Final Invoiced, Completed, No Go, ...) are not columns: a card set to one
// drops off the board, same as CCS's board. Named to match CCS's ccsStatus.js
// (ACTIVE_STAGES) since it's the same role — the board component and its API
// route both key off this name.
export const ACTIVE_STAGES = PIPELINE_STAGES;

// Terminal — shown as a pill, never as a stage.
export const TERMINAL_STATUSES = ['Final Invoiced', 'Completed', 'No Go'];

// Everything the dropdown offers. Includes values found only in the DATA
// (Covid, OE, Ready to Bill, Business Development) so that opening a record
// that carries one does not silently rewrite it to something else — the same
// rule the contact-method type lists follow.
export const ALL_STATUSES = [
  ...PIPELINE_STAGES,
  ...TERMINAL_STATUSES,
  'Keene EOL/C&S', 'Covid', 'OE', 'Business Development', 'Out Reach', 'Other',
];

export const stageIndex = status => PIPELINE_STAGES.indexOf(String(status || '').trim());

export function statusColor(status) {
  const s = String(status || '').trim();
  if (s === 'No Go') return UI.danger;
  if (s === 'Final Invoiced' || s === 'Completed') return UI.success;
  if (s === 'Covid' || s === 'Other' || s === 'Keene EOL/C&S') return UI.neutral;
  return stageIndex(s) >= 0 ? BRAND.gold : UI.neutral;
}
