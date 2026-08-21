// Staged edits, kept on the device instead of only in memory.
//
// THE STAGING STATE WAS ALREADY AN OUTBOX — it just could not survive anything.
// Inspections.jsx has always held a field day's work in four pieces of React
// state (`edits`, `lineEdits`, `newLines`, `deletedIds`) and committed them on
// Save. That is exactly the right shape; the problem is where it lived. A
// dropped iPad, a Safari tab reaped for memory, a battery that ran out at the
// third site — any of those cost a morning, and none of them are unusual on a
// course in July.
//
// So this writes the same four pieces to IndexedDB as they change, and reads
// them back when the record is reopened. Nothing about the edit model changes.
// When the outbox lands (Milestone C), a draft is what it will queue FROM.
//
// A draft is not a save and never claims to be. It is unsent work, held
// locally, and the record it belongs to still shows "N unsaved changes".
import { STORES, idbGet, idbPut, idbDelete, idbGetAll, pinKey } from './offlineStore';
import { getCurrentEnv } from '../config/fmpEnvironments';

/** Is there anything in this state worth keeping? */
export const isEmptyDraft = d =>
  !d
  || (!Object.keys(d.edits || {}).length
    && !Object.keys(d.lineEdits || {}).length
    && !(d.newLines || []).length
    && !(d.deletedIds ? [...d.deletedIds] : []).length);

/**
 * Write (or remove) the staged edits for one record.
 *
 * An empty state DELETES the draft rather than storing an empty one — undoing
 * every change by hand should leave no trace, exactly as pressing Discard does.
 */
export async function saveDraft(layout, recordId, state) {
  const db = getCurrentEnv().db;
  const key = pinKey(db, layout, recordId);
  if (isEmptyDraft(state)) { await idbDelete(STORES.DRAFTS, key).catch(() => {}); return null; }
  const entry = {
    key, db, layout, recordId,
    edits: state.edits || {},
    lineEdits: state.lineEdits || {},
    newLines: state.newLines || [],
    // A Set does not survive structured cloning in a useful shape; store the
    // ids and rebuild the Set on the way out.
    deletedIds: [...(state.deletedIds || [])].map(String),
    updatedAt: Date.now(),
  };
  await idbPut(STORES.DRAFTS, entry, key);
  return entry;
}

/** Read back the staged edits for one record, or null. */
export async function loadDraft(layout, recordId) {
  const db = getCurrentEnv().db;
  const d = await idbGet(STORES.DRAFTS, pinKey(db, layout, recordId));
  if (!d) return null;
  const state = {
    edits: d.edits || {},
    lineEdits: d.lineEdits || {},
    newLines: d.newLines || [],
    deletedIds: new Set((d.deletedIds || []).map(String)),
    updatedAt: d.updatedAt,
  };
  return isEmptyDraft(state) ? null : state;
}

export async function clearDraft(layout, recordId) {
  const db = getCurrentEnv().db;
  await idbDelete(STORES.DRAFTS, pinKey(db, layout, recordId)).catch(() => {});
}

/** Every record with unsent work, for the current database and layout. */
export async function listDrafts(layout) {
  const db = getCurrentEnv().db;
  const all = (await idbGetAll(STORES.DRAFTS)) || [];
  return all
    .filter(d => d.db === db && d.layout === layout)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** The recordIds carrying a draft, as a Set — what a list needs to mark them. */
export async function draftIds(layout) {
  try { return new Set((await listDrafts(layout)).map(d => String(d.recordId))); }
  catch { return new Set(); }
}
