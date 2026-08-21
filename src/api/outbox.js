// Writes that have been committed but not yet sent.
//
// SAVING NO LONGER MEANS SENDING. Pressing Save writes an entry here and
// returns; a drainer sends it whenever there is a network. Online that happens
// in the same second and is indistinguishable from the old behaviour, which is
// the entire point: there is ONE save path, exercised by every user on every
// save at the office desk, rather than an offline branch that gets tried once a
// year on a mountain.
//
// WHAT IS QUEUED IS ALWAYS THE WHOLE THING, never a delta. A `record` entry
// carries every changed field; a `lines` entry carries the inspection's entire
// findings array. That makes replay idempotent — sending the same entry twice
// cannot double-apply — which matters because a dropped connection leaves you
// unable to tell whether a request arrived. It also makes coalescing trivial:
// a morning of edits to one inspection collapses to one queued write, because
// the newest entry already contains everything the older ones said.
//
// The cost of that choice is stated plainly: an inspection's findings resolve
// last-writer-wins as a whole array. If the office edits a line while a crew is
// offline, the crew's sync wins. That is what the FileMaker portal did, what
// `replace` already did, and what §7 of the scope accepts on the grounds that
// one inspector owns one inspection for a day.
import { STORES, idbPut, idbGetAll, idbDelete } from './offlineStore';
import { getCurrentEnv } from '../config/fmpEnvironments';
import { updateVibeRecord } from './vibeRecords';
import { syncLines } from './inspectionLinesVibe';
import { setNaFlag } from './naFlags';

// Replay order within one inspection. The record first because the Drive folder
// a photo lands in is named from the record's own fields, so photos filed
// before the record's edits arrive are filed under a stale name.
const KIND_ORDER = { record: 0, lines: 1, photo: 2 };

let seq = 0;
const newId = () => `ob_${Date.now().toString(36)}_${(++seq).toString(36)}`;

// ── Status, and who is listening ──────────────────────────────────

const listeners = new Set();
let state = { pending: 0, failed: 0, syncing: false, sent: 0, total: 0, lastSyncAt: null, lastError: null };

export const outboxStatus = () => state;

function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) { try { fn(state); } catch { /* one listener must not break the rest */ } }
}

/** Subscribe to sync state. Calls back immediately, returns an unsubscribe. */
export function subscribeOutbox(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

// Entries that have just been sent, so an open record can refresh itself.
const sentListeners = new Set();
export function onEntrySent(fn) { sentListeners.add(fn); return () => sentListeners.delete(fn); }
const announceSent = (entry, result) => { for (const fn of sentListeners) { try { fn(entry, result); } catch { /* ignore */ } } };

// ── The queue ─────────────────────────────────────────────────────

/**
 * Everything waiting: oldest inspection first, and WITHIN an inspection always
 * record, then lines, then photos.
 *
 * The two-level sort is not tidiness. Sorting on createdAt alone lets the order
 * a save happens to enqueue in decide the order it replays in — and the photo
 * upload names its Drive folder from the record's own fields, so a photo sent
 * before the record's edits is filed under a stale name. Grouping by record and
 * ordering by kind inside the group makes that impossible regardless of how a
 * save was written.
 */
export async function pendingEntries() {
  const db = getCurrentEnv().db;
  const all = ((await idbGetAll(STORES.OUTBOX)) || []).filter(e => e.db === db);

  // An inspection's place in the queue is set by its OLDEST entry, so work
  // queued first is sent first even if a later kind was added to it since.
  const groupAt = new Map();
  for (const e of all) {
    const k = String(e.recordId);
    if (!groupAt.has(k) || e.createdAt < groupAt.get(k)) groupAt.set(k, e.createdAt);
  }

  return all.sort((a, b) =>
    (groupAt.get(String(a.recordId)) - groupAt.get(String(b.recordId)))
    || (KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    || (a.createdAt - b.createdAt));
}

async function refreshCounts() {
  try {
    const all = await pendingEntries();
    setState({ pending: all.length, failed: all.filter(e => e.lastError).length });
    return all;
  } catch { setState({ pending: 0, failed: 0 }); return []; }
}

/** The recordIds with something queued — what a list needs to mark them. */
export async function queuedIds() {
  try { return new Set((await pendingEntries()).map(e => String(e.recordId))); }
  catch { return new Set(); }
}

const inFlight = new Set();

/**
 * Commit a write. Returns once it is DURABLE, not once it is sent.
 *
 * Coalescing happens here rather than at replay: an entry for the same record
 * and kind already says everything an older one said, so the older one is
 * dropped on the way in and the queue never grows past one entry per record per
 * kind. An entry currently being sent is left alone — it is already on its way,
 * and the new one will overwrite its result a moment later regardless.
 */
export async function enqueue({ kind, layout, recordId, inspectionId, label, payload, blobKey = null }) {
  const db = getCurrentEnv().db;
  const entry = {
    id: newId(), kind, db, layout, recordId: String(recordId),
    inspectionId: inspectionId ? String(inspectionId) : null,
    label: label || '', payload, blobKey,
    createdAt: Date.now(), attempts: 0, lastError: null,
  };
  // Photos never coalesce — each is its own file, not a restatement.
  if (kind !== 'photo') {
    for (const e of await pendingEntries()) {
      if (e.kind === kind && String(e.recordId) === entry.recordId && !inFlight.has(e.id)) {
        await idbDelete(STORES.OUTBOX, e.id).catch(() => {});
      }
    }
  }
  await idbPut(STORES.OUTBOX, entry);
  await refreshCounts();
  return entry;
}

export async function discardEntry(id) {
  await idbDelete(STORES.OUTBOX, id).catch(() => {});
  await refreshCounts();
}

/** Clear the errors so a failed entry is tried again on the next drain. */
export async function retryFailed() {
  for (const e of await pendingEntries()) {
    if (e.lastError) await idbPut(STORES.OUTBOX, { ...e, lastError: null, attempts: 0 }).catch(() => {});
  }
  await refreshCounts();
  return drainOutbox();
}

// ── Sending ───────────────────────────────────────────────────────

const HANDLERS = {
  async record(e) {
    await updateVibeRecord(e.layout, e.recordId, e.payload.fields || {});
    return null;
  },
  async lines(e) {
    const lines = await syncLines(e.inspectionId, e.payload.lines || []);
    // The carried-over flags for lines reviewed in this batch. Sent after the
    // lines, and separately: a flag is metadata about a line, so clearing one
    // for a line that failed to save would be a lie. Not fatal on its own —
    // a stale badge is a nuisance, a lost finding is not — so it does not fail
    // the entry.
    const cleared = e.payload.carriedCleared || [];
    if (cleared.length) await setNaFlag(e.recordId, cleared, false, 'carried').catch(() => {});
    return { lines };
  },
};

// A failure that means "there is no network", as opposed to "the server said
// no". The difference decides whether the rest of the queue is worth trying:
// one entry the server rejects should not stop the others, and no connection
// means none of them will work.
function isOffline(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (err instanceof TypeError) return true;   // fetch rejects with TypeError
  return /failed to fetch|networkerror|load failed|network request failed/i.test(String(err?.message || ''));
}

const isAuthError = err => /not authenticated|401/i.test(String(err?.message || ''));

// How many times a rejected entry retries on its own before it waits for a
// person. Server failures are not all alike: a 502 in a valley clears itself,
// a malformed payload never will. Retrying a few times catches the first
// without hammering the second, and every write here is idempotent, so a repeat
// cannot do damage.
const MAX_ATTEMPTS = 5;

let draining = false;

/**
 * Send everything that can be sent.
 *
 * An entry is deleted only once the server has confirmed it. A failure keeps
 * its entry, with the reason on it, visible and retryable — nothing is ever
 * silently dropped, because the whole promise of this file is that pressing
 * Save means the work is safe.
 */
export async function drainOutbox() {
  if (draining) return state;
  const queue = await refreshCounts();
  if (!queue.length) { setState({ syncing: false, sent: 0, total: 0 }); return state; }
  if (typeof navigator !== 'undefined' && !navigator.onLine) return state;

  draining = true;
  setState({ syncing: true, sent: 0, total: queue.length, lastError: null });

  let sent = 0;
  for (const e of queue) {
    // Past the cap it waits for someone to press "Try again", which clears the
    // error and starts the count over.
    if (e.lastError && (e.attempts || 0) >= MAX_ATTEMPTS) continue;
    const handler = HANDLERS[e.kind];
    if (!handler) {
      await idbPut(STORES.OUTBOX, { ...e, lastError: `Nothing knows how to send a "${e.kind}".` }).catch(() => {});
      continue;
    }
    inFlight.add(e.id);
    try {
      const result = await handler(e);
      await idbDelete(STORES.OUTBOX, e.id);
      sent += 1;
      setState({ sent });
      announceSent(e, result);
    } catch (err) {
      const message = String(err?.message || err).slice(0, 200);
      const stop = isOffline(err) || isAuthError(err);
      // A network failure is not the entry's fault, so it keeps a clean record
      // and simply waits — marking it failed would make an ordinary drive
      // through a valley look like a broken save.
      await idbPut(STORES.OUTBOX, {
        ...e,
        attempts: (e.attempts || 0) + 1,
        lastError: stop ? null : message,
      }).catch(() => {});
      if (stop) { setState({ lastError: message }); break; }
    } finally {
      inFlight.delete(e.id);
    }
  }

  draining = false;
  await refreshCounts();
  setState({ syncing: false, lastSyncAt: sent ? Date.now() : state.lastSyncAt });
  return state;
}

/**
 * Start draining on every signal that one might now succeed.
 *
 * Called once, from the module that owns the queue. Returns a teardown.
 */
export function watchForConnection() {
  const kick = () => { drainOutbox().catch(() => {}); };
  const onVisible = () => { if (document.visibilityState === 'visible') kick(); };
  window.addEventListener('online', kick);
  window.addEventListener('focus', kick);
  document.addEventListener('visibilitychange', onVisible);
  // A long shift with the app open and the signal returning quietly — no event
  // fires for a captive portal that starts working again.
  const timer = setInterval(kick, 60 * 1000);
  refreshCounts();
  kick();
  return () => {
    window.removeEventListener('online', kick);
    window.removeEventListener('focus', kick);
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(timer);
  };
}
