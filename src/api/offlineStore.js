// The store a field day lives in.
//
// SEPARATE FROM `fmp_cache` ON PURPOSE. That database is a cache: it holds
// whole layouts, it is evicted on a 7-day TTL, it is rewritten wholesale by a
// background refresh, and losing it costs a reload. This one holds work — the
// inspections a crew deliberately took offline, the edits they have made, and
// the queue of things not yet sent. Losing it costs a day on a mountain. Cache
// housekeeping must never be able to reach it, which is easiest to guarantee by
// them not being the same database.
//
// Four stores, and all four exist from version 1 even though Milestone A only
// fills one. An IndexedDB version bump is a migration on every device in the
// field, and the shape of the other three is already known.
//
//   pinned   what "Take offline" downloaded — the record, its lines, its
//            carried-over flags and its attachment list, keyed by record
//   drafts   staged edits, so a dropped iPad does not cost a morning
//   outbox   writes waiting for a network
//   blobs    photo bytes, referenced by outbox entries rather than held in them
//
// The whole schema is created in one `onupgradeneeded`, and `openDb` checks on
// the way out that every store really is there — see `isIncomplete`.

const DB_NAME = 'vibe_offline';
const DB_VERSION = 1;

export const STORES = { PINNED: 'pinned', DRAFTS: 'drafts', OUTBOX: 'outbox', BLOBS: 'blobs' };

const ALL_STORES = Object.values(STORES);

function createSchema(db) {
  if (!db.objectStoreNames.contains(STORES.PINNED)) db.createObjectStore(STORES.PINNED);
  if (!db.objectStoreNames.contains(STORES.DRAFTS)) db.createObjectStore(STORES.DRAFTS);
  if (!db.objectStoreNames.contains(STORES.BLOBS)) db.createObjectStore(STORES.BLOBS);
  if (!db.objectStoreNames.contains(STORES.OUTBOX)) {
    // keyPath, because an outbox entry knows its own id and replay reads them
    // in creation order.
    const s = db.createObjectStore(STORES.OUTBOX, { keyPath: 'id' });
    s.createIndex('createdAt', 'createdAt');
  }
}

let dbPromise = null;

/**
 * A database at the right version but missing its stores.
 *
 * Reachable two ways: an upgrade transaction that aborted part-way (the tab
 * closed, the device died), or anything that opened `vibe_offline` without a
 * version — which creates an empty version 1 that then never upgrades. Either
 * way every read and write afterwards throws NotFoundError forever, and the
 * app would report a broken offline store rather than a fixable one.
 *
 * Deleting is safe precisely BECAUSE the stores are missing: a database with no
 * object stores holds no work to lose.
 */
function isIncomplete(db) {
  return ALL_STORES.some(n => !db.objectStoreNames.contains(n));
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => createSchema(req.result);
    req.onsuccess = () => {
      const db = req.result;
      if (!isIncomplete(db)) { resolve(db); return; }
      // Recreate it once, from scratch.
      db.close();
      const gone = indexedDB.deleteDatabase(DB_NAME);
      const retry = () => {
        const again = indexedDB.open(DB_NAME, DB_VERSION);
        again.onupgradeneeded = () => createSchema(again.result);
        again.onsuccess = () => resolve(again.result);
        again.onerror = () => reject(again.error);
      };
      gone.onsuccess = retry;
      gone.onerror = () => reject(gone.error);
      // A delete blocked by a connection in another tab fires neither of the
      // above, EVER. Left unhandled this promise never settles, so every
      // offline read and write hangs rather than failing — and the app reports
      // no problem at all, because nothing ever came back to report one.
      gone.onblocked = () => reject(new Error('Another tab has the offline store open; close it and reload.'));
    };
    req.onerror = () => reject(req.error);
    // Another tab holding the old version open. Rare, and silent failure here
    // would look like "the app forgot my work", so it is an error.
    req.onblocked = () => reject(new Error('Another tab is holding an older version of the offline store open.'));
  });
  // A rejected promise must not be the permanent answer: the causes above are
  // all transient (another tab, a device that ran out of room), and caching the
  // failure would mean the app never recovered without a reload.
  dbPromise = dbPromise.catch(e => { dbPromise = null; throw e; });
  return dbPromise;
}

// Every call goes through here so a browser in private mode, or one that has
// had storage disabled, degrades to "nothing is offline" rather than throwing
// out of a render.
async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.onabort = () => reject(t.error);
    t.onerror = () => reject(t.error);
    if (req) req.onsuccess = () => resolve(req.result);
    else t.oncomplete = () => resolve();
  });
}

export const idbGet = (store, key) => tx(store, 'readonly', s => s.get(key));
export const idbPut = (store, value, key) => tx(store, 'readwrite', s => s.put(value, key));
export const idbDelete = (store, key) => tx(store, 'readwrite', s => s.delete(key));
export const idbGetAll = (store) => tx(store, 'readonly', s => s.getAll());
export const idbKeys = (store) => tx(store, 'readonly', s => s.getAllKeys());

/** Is this browser able to hold offline work at all? */
export async function offlineStorageAvailable() {
  try { await openDb(); return true; } catch { return false; }
}

// ── Pinned inspections ────────────────────────────────────────────
//
// Keyed by db + layout + recordId. The db is in the key because Dev and
// production hold different records under the same ids, and a crew that
// switched environments should not find the other one's inspection waiting for
// them.

export const pinKey = (db, layout, recordId) => `${db}:${layout}:${recordId}`;

/**
 * @param {object} entry { db, layout, recordId, inspectionId, label, record, lines, carried, attachments }
 */
export async function putPinned(entry) {
  const key = pinKey(entry.db, entry.layout, entry.recordId);
  await idbPut(STORES.PINNED, { ...entry, key, pinnedAt: Date.now() }, key);
  return key;
}

export const getPinned = (db, layout, recordId) => idbGet(STORES.PINNED, pinKey(db, layout, recordId));
export const removePinned = (db, layout, recordId) => idbDelete(STORES.PINNED, pinKey(db, layout, recordId));

/** Everything currently taken offline, newest first. */
export async function listPinned(db, layout) {
  const all = (await idbGetAll(STORES.PINNED)) || [];
  return all
    .filter(e => (!db || e.db === db) && (!layout || e.layout === layout))
    .sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
}

/** Roughly how much room the pinned set takes, for the storage line in the UI. */
export async function pinnedBytes(db, layout) {
  const all = await listPinned(db, layout);
  let n = 0;
  for (const e of all) { try { n += JSON.stringify(e).length; } catch { /* unserialisable — skip */ } }
  return n;
}

/**
 * The pinned entry for an inspection's OWN id, rather than FileMaker's
 * recordId.
 *
 * Both keys are needed because the app addresses an inspection two ways: the
 * record is fetched by FileMaker recordId, and its findings and carried-over
 * flags hang off `_kpt__Inspection_ID`. Pinning stores one entry with both, so
 * this is a scan of a handful of rows rather than a second index.
 */
export async function pinnedByInspectionId(db, layout, inspectionId) {
  if (!inspectionId) return null;
  const all = await listPinned(db, layout);
  return all.find(e => String(e.inspectionId) === String(inspectionId)) || null;
}
