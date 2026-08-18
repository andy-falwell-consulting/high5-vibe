// FileMaker layout + cache version for the Trainings module, and the trainer
// slot field list — shared between Trainings.jsx and TrainingsKanban.jsx.
// Mirrors ccsCache.js's role for CCS (RCD_LAYOUT / RCD_CACHE_VERSION).
//
// Pulled out of Trainings.jsx rather than exported alongside its default
// component export: mixing a component export with plain-value exports in
// one file breaks Fast Refresh for that file (react-refresh/only-export-
// components) — a real lint error, not a style nit.
export const TRAININGS_LAYOUT = 'trainings_New';
export const TRAININGS_CACHE_VERSION = 1;

// trainers10-trainers18 are Vibe-only — trainings_New's real FileMaker fields
// stop at trainers9, so these nine slots exist only as Vibe overlay fields
// (fine: trainings_New is Vibe-owned, see api/_vibeStore.js).
export const TRAINER_SLOTS = ['Trainers', 'trainers2', 'trainers3', 'trainers4', 'trainers5', 'trainers6', 'trainers7', 'trainers8', 'trainers9',
  'trainers10', 'trainers11', 'trainers12', 'trainers13', 'trainers14', 'trainers15', 'trainers16', 'trainers17', 'trainers18'];
