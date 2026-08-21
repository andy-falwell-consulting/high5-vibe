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
//
// 'Ready to Bill' was removed from the vocabulary on 2026-08-20. Four records
// still carry it — see LEGACY_STATUSES.
export const PIPELINE_STAGES = [
  'Inquiry',
  'Follow-up Needed',
  'Proposed',
  'Approved/Needs to be D-Invoiced & TC',
  'Waiting on $ & Signed TC',
  'Confirmed/Scheduled',
];

export const PIPELINE_SHORT = [
  'Inquiry', 'Follow-up', 'Proposed', 'Approved', 'Waiting on $', 'Confirmed',
];

// Terminal — shown as a pill on the record, and its own lane on the board.
// Completed before Final Invoiced, which is the order Andy gave and the order
// the work actually happens in.
export const TERMINAL_STATUSES = ['Completed', 'Final Invoiced', 'No Go'];

// Everything the dropdown OFFERS. Eleven values, replacing the sixteen that
// were here before (2026-08-20).
export const ALL_STATUSES = [
  ...PIPELINE_STAGES,
  ...TERMINAL_STATUSES,
  'Out Reach', 'Other',
];

// Values the vocabulary NO LONGER OFFERS but records still hold. Measured
// against production the day they were retired:
//
//     44  Covid
//     32  Keene EOL/C&S
//      4  Ready to Bill
//      3  OE
//      1  Business Development
//     ---
//     84  records
//
// They are listed rather than deleted for two reasons, both of which bit this
// module before:
//
//   1. A <select> whose value is not among its options renders as blank, and
//      saving that record writes the blank over a real status. The old
//      ALL_STATUSES comment described exactly this trap; retiring a value
//      without recording it is how you walk into it.
//   2. A status with no Kanban lane means a card that silently vanishes — the
//      bug fixed in v1.0.471. These do not get lanes (the board shows the
//      eleven offered values, as asked), but the board COUNTS them, so 84
//      records are visible as a number rather than absent.
//
// Delete this list once the 84 have been remapped. Until then it is the record
// of what needs remapping.
export const LEGACY_STATUSES = [
  'Ready to Bill', 'Keene EOL/C&S', 'Covid', 'OE', 'Business Development',
];

/** Is this a status the vocabulary no longer offers? */
export const isLegacyStatus = s => LEGACY_STATUSES.includes(String(s || '').trim());

/** What the dropdown should show for a record — the offered list, plus this
 *  record's own value when it is a retired one, so opening a record can never
 *  blank its status. */
export const statusOptionsFor = current => {
  const c = String(current || '').trim();
  return c && !ALL_STATUSES.includes(c) ? [c, ...ALL_STATUSES] : ALL_STATUSES;
};

// Kanban board columns — one lane per status the dropdown offers, in the same
// order the dropdown lists them.
//
// Retired statuses deliberately get NO lane. A card holding one is counted in
// the board's "with no status" chip instead, which already exists for exactly
// this: blank statuses and the four spliced values in the data.
export const BOARD_COLUMNS = ALL_STATUSES;

// Header labels. The pipeline stages reuse the short labels the hero dots
// already use, so a stage reads the same in both places.
export const BOARD_SHORT = {
  ...Object.fromEntries(PIPELINE_STAGES.map((s, i) => [s, PIPELINE_SHORT[i]])),
};

export const stageIndex = status => PIPELINE_STAGES.indexOf(String(status || '').trim());

export function statusColor(status) {
  const s = String(status || '').trim();
  if (s === 'No Go') return UI.danger;
  if (s === 'Final Invoiced' || s === 'Completed') return UI.success;
  // A retired status still needs a colour — 84 records carry one, and falling
  // through to the pipeline branch below would paint them gold, as though they
  // were in flight.
  if (isLegacyStatus(s)) return UI.neutral;
  if (s === 'Other' || s === 'Out Reach') return UI.neutral;
  return stageIndex(s) >= 0 ? BRAND.gold : UI.neutral;
}
