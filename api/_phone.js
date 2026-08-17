// Phone numbers: one canonical form, one display form, one place.
// Files starting with _ are not Vercel routes. Imported by the client too, so
// the server and the browser cannot drift on what a number means.
//
// Storage is E.164 (+15088537824). Display is (508) 853-7824. The extension is
// its own field and never lives inside the number.
//
// Hand-rolled rather than libphonenumber-js, and the data is why: of 14,423
// numbers in the contact store, 14,336 are plain 10-digit NANP, none are
// international, and none carry a leading 1. A 145 KB dependency to solve a
// problem this data does not have is the wrong trade — but the STORAGE shape is
// the standard one, so swapping in libphonenumber later changes only this file.

// Trailing extension: 'x261', 'ext. 4', 'extension 5020'. Every one of the
// 1,390 extensions in the store uses the bare `x` form; the rest are accepted
// because people type them.
const EXT_RE = /[\s,;.-]*(?:x|ext|extn|extension)\.?:?\s*(\d+)\s*$/i;

/** Pull a trailing extension off a raw string. Neither part is normalised. */
export function splitExtension(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(EXT_RE);
  if (!m) return { base: s, ext: '' };
  return { base: s.slice(0, s.length - m[0].length).trim(), ext: m[1] };
}

/**
 * E.164 for a North American number, or null when it isn't one.
 *
 * Null rather than a best guess: 87 numbers in the store are truncated
 * ('(207', '(378) 732-4'), and turning those into a plausible-looking +1 would
 * make bad data indistinguishable from good.
 */
export function toE164(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  const ten = digits.length === 10 ? digits
    : (digits.length === 11 && digits[0] === '1') ? digits.slice(1)
    : null;
  if (!ten) return null;
  // NANP validity, not just length. Area code and exchange both have to start
  // 2-9. Without this, '1 973 389 285' — a leading country code and a number
  // one digit short — passes as ten digits and becomes +11973389285, an E.164
  // string with area code 197 that cannot exist. 149 numbers went into
  // production looking valid that way before this check was added.
  if (!/^[2-9]\d\d[2-9]\d{6}$/.test(ten)) return null;
  return `+1${ten}`;
}

export const isE164 = v => /^\+\d{8,15}$/.test(String(v ?? ''));

/**
 * Display form. `+15088537824` → `(508) 853-7824`.
 *
 * Anything that isn't a +1 NANP number is returned as stored: an unparseable
 * number shows the text somebody actually typed rather than a mangled version
 * of it, which is the point of keeping it.
 */
export function formatPhone(value, ext = '') {
  const s = String(value ?? '').trim();
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(s);
  const base = m ? `(${m[1]}) ${m[2]}-${m[3]}` : s;
  return ext ? `${base} ext. ${ext}` : base;
}

/** What `tel:` should carry — E.164 dials correctly, formatted text may not. */
export function telHref(value, ext = '') {
  const s = String(value ?? '').trim();
  const dial = isE164(s) ? s : `+${s.replace(/\D/g, '')}`;
  return ext ? `tel:${dial},${ext}` : `tel:${dial}`;
}

/**
 * Take whatever a person typed and produce { number, ext } for storage.
 * An explicit `ext` argument wins over one embedded in the text.
 */
export function normalisePhoneInput(rawNumber, rawExt = '') {
  const { base, ext: embedded } = splitExtension(rawNumber);
  const e164 = toE164(base);
  return {
    number: e164 || base,          // unparseable keeps the text as written
    ext: String(rawExt ?? '').replace(/\D/g, '') || embedded || '',
  };
}
