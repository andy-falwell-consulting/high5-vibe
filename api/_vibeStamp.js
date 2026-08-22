// The marker Vibe writes into a QuickBooks record's PrivateNote so the record
// can be traced back here later. Files starting with _ are not Vercel routes.
//
// ONE FILE BECAUSE THE WRITER AND THE READER MUST NOT DRIFT. This is written
// today (api/qbo-estimate-create.js) and parsed later by the transaction source
// classifier — see docs/transaction-source-scope.md. A format written in one
// place and parsed in another, months apart, is the kind of thing that silently
// stops matching; both ends import this.
//
// WHY PrivateNote AND NOT CustomerMemo. CustomerMemo prints on the estimate the
// customer receives. PrivateNote is the internal memo, which is where the office
// already writes what a job was ("CCS", "T&TD 5-Day", "EOL spring 2027"). An
// internal id belongs with those, not on a document sent to a school.
//
// The stamp is deliberately readable rather than encoded: someone looking at
// this estimate in QuickBooks should be able to tell what it means without
// knowing the app exists.

const PREFIX = 'Vibe';
const SEP = ' · ';

// Ids are our own (`V-100001`, or a FileMaker number) — anything else is a
// mistake upstream, so the shape is narrow on purpose.
const SAFE_ID = /^[A-Za-z0-9._-]{1,40}$/;

/** e.g. stamp('estimate', 'V-100001') -> 'Vibe estimate V-100001' */
export function stamp(kind, id) {
  const k = String(kind || '').trim().toLowerCase();
  const v = String(id ?? '').trim();
  if (!k || !SAFE_ID.test(v)) return '';
  return `${PREFIX} ${k} ${v}`;
}

/**
 * Compose the PrivateNote to send, preserving anything a person wrote.
 *
 * The stamp goes FIRST so it survives QuickBooks' own truncation in list views,
 * and so a human note that happens to contain the word "Vibe" cannot be mistaken
 * for it.
 */
export function noteWithStamp(kind, id, existingNote) {
  const s = stamp(kind, id);
  const note = String(existingNote ?? '').trim();
  if (!s) return note;
  if (!note) return s;
  // Never stamp twice — this may run again on an edit.
  if (parseStamp(note)?.id === String(id).trim()) return note;
  return `${s}${SEP}${note}`;
}

/**
 * Read a stamp back out of a PrivateNote, or null.
 *
 * Tolerant of what a person may have typed around it: the stamp is found
 * anywhere in the note, not only at the start, because someone editing in
 * QuickBooks will eventually put their own words first.
 */
export function parseStamp(note) {
  const m = new RegExp(`\\b${PREFIX}\\s+([a-z]+)\\s+([A-Za-z0-9._-]{1,40})`, 'i').exec(String(note ?? ''));
  return m ? { kind: m[1].toLowerCase(), id: m[2] } : null;
}
