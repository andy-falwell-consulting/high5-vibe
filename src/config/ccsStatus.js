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

// All eight statuses, in pipeline order — the full Status dropdown.
// Revised 2026-07-29 per ops: `Proposed` and `Sent Contract & DI` collapse into
// one "Proposed Dates" stage that now sits AFTER Approved, and the single
// `Confirmed/Scheduled` stage splits back into job-prep vs ready-to-go.
export const MERGED_STATUSES = [
  'Inquiry', 'In Process', 'Approved', 'Proposed Dates, Sent Contract & DI',
  'Confirmed/ Job Prep by Date', 'Confirmed/ Ready to go', 'Completed', "No Go's",
];

// The linear progression shown as pipeline dots (workspace) and Home funnel
// bars — the in-flight stages plus the Completed terminus.
export const PIPELINE_STAGES = [
  'Inquiry', 'In Process', 'Approved', 'Proposed Dates, Sent Contract & DI',
  'Confirmed/ Job Prep by Date', 'Confirmed/ Ready to go', 'Completed',
];

// Short labels for the dots/funnel (parallel to PIPELINE_STAGES).
export const PIPELINE_SHORT = [
  'Inquiry', 'In process', 'Approved', 'Proposed dates', 'Job prep', 'Ready to go', 'Completed',
];

// Kanban board columns = active/in-flight work only (per product decision).
// Completed / No Go's are valid statuses but NOT columns — setting a card to
// one of them drops it off the board (standard Kanban), so the board isn't
// flooded by 5,000+ historical Completed records.
export const ACTIVE_STAGES = [
  'Inquiry', 'In Process', 'Approved', 'Proposed Dates, Sent Contract & DI',
  'Confirmed/ Job Prep by Date', 'Confirmed/ Ready to go',
];

export const STATUS_COLORS = {
  'Inquiry':                             BRAND.gold,
  'In Process':                          BRAND.mustard,
  'Approved':                            BRAND.purple,
  'Proposed Dates, Sent Contract & DI':  '#B968B4',
  'Confirmed/ Job Prep by Date':         BRAND.blue,
  'Confirmed/ Ready to go':              '#4FC3E8',
  'Completed':                           UI.success,
  "No Go's":                             UI.neutral,
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
  // Approved
  'Approved': 'Approved',
  'Approved: Schedule': 'Approved',
  // Proposed Dates, Sent Contract & DI — absorbs the retired `Proposed` and
  // `Sent Contract & DI` stages (ops decision 2026-07-29). Note this moves the
  // 67 legacy `Proposed` records PAST Approved in the pipeline.
  'Proposed Dates, Sent Contract & DI': 'Proposed Dates, Sent Contract & DI',
  'Proposed': 'Proposed Dates, Sent Contract & DI',
  'Proposals Out': 'Proposed Dates, Sent Contract & DI',
  'Sent Contract & DI': 'Proposed Dates, Sent Contract & DI',
  'Sent Contract and DI': 'Proposed Dates, Sent Contract & DI',
  'Approved, Sent Contract & DI': 'Proposed Dates, Sent Contract & DI',
  // Confirmed — the old single `Confirmed/Scheduled` defaults to the EARLIER of
  // the two new stages, so nothing is shown as more ready than it is.
  'Confirmed/ Job Prep by Date': 'Confirmed/ Job Prep by Date',
  'Confirmed/Scheduled': 'Confirmed/ Job Prep by Date',
  'Confirmed/ Scheduled': 'Confirmed/ Job Prep by Date',
  'Confirmed': 'Confirmed/ Job Prep by Date',
  'Job Prep by Date': 'Confirmed/ Job Prep by Date',
  'Confirmed/ Ready to go': 'Confirmed/ Ready to go',
  'Done/Ready for Building': 'Confirmed/ Ready to go',
  // Completed
  'Completed': 'Completed',
  'Commissioning Report Needed': 'Completed',
  // No Go's — now also absorbs the old `Other` bucket (COVID-19, On Hold).
  "No Go's": "No Go's",
  'No Go': "No Go's",
  "No Go's (litter box)": "No Go's",
  'Cancelled': "No Go's",
  'COVID-19': "No Go's",
  'On Hold': "No Go's",
  'Other': "No Go's",
  // Five records carry values corrupted by typing over a dropdown selection.
  // Each is mapped to what it evidently was, NOT to No Go's — marking a live
  // job dead because of a typo would be worse than the typo.
  'InqNo Gouiry': 'Inquiry',
  'Confirmed/Completed': 'Completed',
  'ConfirmCompleteded/Scheduled': 'Completed',
  'CCompletedonfirmed/Scheduled': 'Completed',
  'Confirmed/CompletedScheduled': 'Completed',
};

const MERGED_SET = new Set(MERGED_STATUSES);
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// Derive the merged status from a record. Reads `Status` first, then the legacy
// `kanban_status` as a fallback.
//
// Unknown values resolve to '' (unset), NOT to a bucket. The old catch-all
// `Other` is gone, and the alternative — defaulting the unrecognised to
// "No Go's" — would silently mark a live job dead the first time someone
// mistypes a status. Unset is visible and harmless; the record still appears
// everywhere, just without a stage. Add an alias above when a new legacy value
// turns up.
export function mergedStatus(fieldData) {
  const raw = norm(fieldData?.Status) || norm(fieldData?.kanban_status);
  if (!raw) return '';
  return STATUS_ALIASES[raw] || (MERGED_SET.has(raw) ? raw : '');
}
