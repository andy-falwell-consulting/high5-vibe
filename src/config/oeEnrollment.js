// `Open Enrollment or Custom` holds five spellings of two concepts:
//
//   "Open Enrollment" | "Custom" | "OPEN ENROLLMENT" | "Open Enrollement"
//   | "Open Enrollment  " (trailing spaces) | "" (blank)
//
// The FileMaker layout declares NO value list, so nothing has ever constrained
// it. Note "Open Enrollement" — a genuine typo sitting in production data.
//
// Normalised on READ, not by rewriting the stored rows. Writing a canonical
// value onto ~1,250 records would mean a Vibe fragment for every one of them,
// and `readOverlay` HGETALLs the whole overlay on every records page — the same
// reason child collections are stored per-parent instead of on the fragment.
// Paying that cost permanently to fix a display string is the wrong trade.
//
// New records write a canonical value, so the mess stops growing.

export const OPEN_ENROLLMENT = 'Open Enrollment';
export const CUSTOM = 'Custom';

/** The two values a new record may hold. */
export const ENROLLMENT_OPTIONS = [OPEN_ENROLLMENT, CUSTOM];

/** Any stored spelling -> a canonical value, or '' when genuinely blank.
 *  Unrecognised values are returned trimmed rather than discarded — silently
 *  dropping a value nobody anticipated is how data goes missing. */
export function canonicalEnrollment(raw) {
  const v = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!v) return '';
  const k = v.toLowerCase();
  if (k === 'custom') return CUSTOM;
  // Covers "open enrollment", "OPEN ENROLLMENT" and the "enrollement" typo.
  if (/^open\s+enroll?e?ment$/.test(k)) return OPEN_ENROLLMENT;
  return v;
}

/** True when a record is open-enrollment, whatever spelling it was stored as. */
export const isOpenEnrollment = raw => canonicalEnrollment(raw) === OPEN_ENROLLMENT;
