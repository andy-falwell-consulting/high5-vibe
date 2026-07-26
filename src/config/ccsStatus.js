// Merged CCS status vocabulary. Historically CCS records carried TWO overlapping
// fields — `Status` (populated on ~6,217 records) and `kanban_status` (the old
// pipeline, populated on ~1). Per the brand/ops decision they collapse into one
// 9-value set that drives the workspace pill, the pipeline dots, the Home
// funnel, and the Kanban board.
//
// Non-destructive: we MAP legacy values to the merged set on READ (mergedStatus)
// and only WRITE a merged value to `Status` when a user actually changes a
// record. No bulk rewrite, no FMP schema change — the legacy value list simply
// drifts, which is accepted (FMP is being retired). `kanban_status` is no longer
// read or written by the app.
import { BRAND, UI } from './brandColors';

// All nine merged statuses, in pipeline order — the full Status dropdown.
export const MERGED_STATUSES = [
  'Inquiry', 'In Process', 'Proposed', 'Approved',
  'Sent Contract & DI', 'Confirmed/Scheduled', 'Completed', 'No Go', 'Other',
];

// The linear progression shown as pipeline dots (workspace) and Home funnel
// bars — the in-flight stages plus the Completed terminus.
export const PIPELINE_STAGES = [
  'Inquiry', 'In Process', 'Proposed', 'Approved',
  'Sent Contract & DI', 'Confirmed/Scheduled', 'Completed',
];

// Short labels for the dots/funnel (parallel to PIPELINE_STAGES).
export const PIPELINE_SHORT = [
  'Inquiry', 'In process', 'Proposed', 'Approved', 'Contract sent', 'Confirmed', 'Completed',
];

// Kanban board columns = active/in-flight work only (per product decision).
// Completed / No Go / Other are valid statuses but NOT columns — setting a card
// to one of them drops it off the board (standard Kanban), so the board isn't
// flooded by thousands of historical Completed records.
export const ACTIVE_STAGES = [
  'Inquiry', 'In Process', 'Proposed', 'Approved', 'Sent Contract & DI', 'Confirmed/Scheduled',
];

export const STATUS_COLORS = {
  'Inquiry':              BRAND.gold,
  'In Process':           BRAND.mustard,
  'Proposed':             BRAND.purple,
  'Approved':             '#B968B4',
  'Sent Contract & DI':   BRAND.blue,
  'Confirmed/Scheduled':  '#4FC3E8',
  'Completed':            UI.success,
  'No Go':                UI.neutral,
  'Other':                UI.muted,
};

export const statusColor = s => STATUS_COLORS[s] || UI.muted;

// Legacy value → merged value. Covers every value seen in the FMP `Status` list,
// the old `kanban_status` pipeline, and prior hardcoded dropdowns. Anything not
// listed (and not already a merged value) falls through to 'Other'.
const STATUS_ALIASES = {
  // Inquiry
  'Inquiry': 'Inquiry',
  'New Project Inquiry': 'Inquiry',
  // In Process
  'In Process': 'In Process',
  'In Progress': 'In Process',
  'Working Proposals': 'In Process',
  // Proposed
  'Proposed': 'Proposed',
  'Proposals Out': 'Proposed',
  // Approved
  'Approved': 'Approved',
  'Approved: Schedule': 'Approved',
  'Approved, Sent Contract & DI': 'Approved',
  // Sent Contract & DI
  'Sent Contract & DI': 'Sent Contract & DI',
  'Sent Contract and DI': 'Sent Contract & DI',
  // Confirmed/Scheduled
  'Confirmed/Scheduled': 'Confirmed/Scheduled',
  'Confirmed/ Scheduled': 'Confirmed/Scheduled',
  'Confirmed': 'Confirmed/Scheduled',
  'Job Prep by Date': 'Confirmed/Scheduled',
  'Confirmed/ Job Prep by Date': 'Confirmed/Scheduled',
  'Confirmed/ Ready to go': 'Confirmed/Scheduled',
  'Done/Ready for Building': 'Confirmed/Scheduled',
  // Completed
  'Completed': 'Completed',
  'Commissioning Report Needed': 'Completed',
  // No Go
  'No Go': 'No Go',
  "No Go's": 'No Go',
  "No Go's (litter box)": 'No Go',
  'Cancelled': 'No Go',
  // Other
  'On Hold': 'Other',
  'COVID-19': 'Other',
  'Other': 'Other',
};

const MERGED_SET = new Set(MERGED_STATUSES);
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// Derive the merged status from a record. Reads `Status` first, then the legacy
// `kanban_status` as a fallback. Empty → '' (unset). Unknown non-empty → 'Other'.
export function mergedStatus(fieldData) {
  const raw = norm(fieldData?.Status) || norm(fieldData?.kanban_status);
  if (!raw) return '';
  return STATUS_ALIASES[raw] || (MERGED_SET.has(raw) ? raw : 'Other');
}
