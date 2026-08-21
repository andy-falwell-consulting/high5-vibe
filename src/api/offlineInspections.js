// "Take offline" — downloading a day's inspections so a crew can work without
// a signal.
//
// DELIBERATE, NOT HOPEFUL. Every module already caches its whole layout in
// IndexedDB, so an inspection a crew happened to open last week may well still
// be there. That is not something anyone should drive two hours into the hills
// on. This fetches each chosen inspection's four parts explicitly, checks that
// each one really came from the network, and only then records it as available
// offline.
//
// The four parts, because an inspection is not one request:
//   record       the header fields, via /api/record (Vibe's overlay merged over
//                FileMaker's copy)
//   lines        the findings — a median of 44 rows, one read
//   carried      which lines came from last year and are not yet reviewed. A
//                missing carried set is worse than it sounds: every stale
//                finding would look reviewed, which is the exact mistake the
//                flag exists to prevent.
//   attachments  the file LIST, not the bytes. Enough to show what a record
//                has; downloading last year's photos is a decision for the
//                photo work, not this.
import { getRecord, invalidateRecord } from './filemaker';
import { listLines } from './inspectionLinesVibe';
import { fetchNaFlags } from './naFlags';
import { listAttachments } from './inspectionAttachments';
import { getCurrentEnv } from '../config/fmpEnvironments';
import { putPinned, getPinned, removePinned, listPinned } from './offlineStore';

export const LAYOUT = 'Inspections_New';

export const inspectionLabel = fd =>
  fd?.Organization || fd?.['inspt_CNTCT__site::Name_Organization'] || `Inspection ${fd?._kpt__Inspection_ID || ''}`.trim();

/**
 * Download one inspection for offline use.
 *
 * @param {object} rec       a list record — { recordId, fieldData }
 * @param {function} [onStep] progress, called with a short human phrase
 * @returns {Promise<object>} the pinned entry
 */
export async function pinInspection(rec, onStep) {
  const db = getCurrentEnv().db;
  const recordId = rec.recordId;
  const step = s => { try { onStep?.(s); } catch { /* progress must not break a download */ } };

  step('Reading the record…');
  // Force a real read. getRecord serves an in-memory promise for anything
  // opened this session, and pinning a copy the app already had would defeat
  // the point of pressing the button.
  invalidateRecord(LAYOUT, recordId);
  const res = await getRecord(LAYOUT, recordId);
  // getRecord falls back to local copies when the network is gone. That is the
  // right behaviour everywhere except here: pinning a record we could not
  // actually fetch would report a successful download of nothing.
  if (res?.offline) throw new Error('No connection — nothing was downloaded.');
  const record = res?.response?.data?.[0];
  if (!record) throw new Error('The record could not be read.');

  const inspectionId = record.fieldData?._kpt__Inspection_ID;
  if (!inspectionId) throw new Error('This inspection has no ID yet, so its findings cannot be downloaded.');

  step('Reading the findings…');
  const lines = await listLines(inspectionId);

  step('Reading carried-over flags…');
  // fetchNaFlags rather than fetchCarriedLines: the wrapper swallows failures
  // and returns an empty list, which here would silently pin "every line is
  // reviewed". A throw is the honest answer — the crew can press it again.
  const carried = await fetchNaFlags(recordId, 'carried');

  step('Listing attachments…');
  // Not fatal: a record with unreadable attachments is still worth having.
  const attachments = await listAttachments(inspectionId).catch(() => []);

  const entry = {
    db, layout: LAYOUT, recordId, inspectionId,
    label: inspectionLabel(record.fieldData),
    date: record.fieldData?.Date || '',
    record, lines, carried, attachments,
  };
  await putPinned(entry);
  step('Ready offline');
  return entry;
}

/** Drop one inspection's offline copy. */
export const unpinInspection = recordId => removePinned(getCurrentEnv().db, LAYOUT, recordId);

/** Is this inspection available offline? */
export const pinnedInspection = recordId => getPinned(getCurrentEnv().db, LAYOUT, recordId);

/** Everything currently taken offline, newest first. */
export const listPinnedInspections = () => listPinned(getCurrentEnv().db, LAYOUT);

/** The recordIds currently pinned, as a Set — what the list needs to draw a mark. */
export async function pinnedIds() {
  try { return new Set((await listPinnedInspections()).map(e => String(e.recordId))); }
  catch { return new Set(); }
}
