import { getCurrentEnv, FMP_ENVIRONMENTS } from '../config/fmpEnvironments';

// Priority fetch scheduler — two tiers (HIGH=0, LOW=1).
// Single-record fetches use HIGH; bulk batch pages use LOW.
// HIGH items always drain before LOW, so hover/click jumps the queue.
const _HIGH = 0, _LOW = 1;
const _MAX_CONCURRENT = 4;
let _active = 0;
const _queues = [[], []];

function _scheduleNext() {
  if (_active >= _MAX_CONCURRENT) return;
  for (const q of _queues) {
    if (q.length) {
      _active++;
      const { fn, resolve, reject } = q.shift();
      fn().then(resolve, reject).finally(() => { _active--; _scheduleNext(); });
      return;
    }
  }
}

function _scheduledFetch(priority, fn) {
  return new Promise((resolve, reject) => {
    _queues[priority].push({ fn, resolve, reject });
    _scheduleNext();
  });
}

// /fmi/* is proxied in both dev (Vite) and prod (Vercel rewrite → /api/proxy).
function getBasePath() {
  return '';
}

let sessionToken = null;
let _tokenEnvId = null;
let _tokenPromise = null; // shared in-flight auth, so a burst of calls mints one token

// Force the next getToken() call to mint a brand-new FMP Data API session
// instead of reusing the current one. Container-streaming URLs embed a token
// tied to the specific session active when the record was fetched; FMP Server
// can evict sessions under concurrent load well before our client-side copy
// would otherwise expire, so a reused session can mint a streaming URL that's
// already invalid. Called right before minting a fresh attachment/report URL
// (see recordAttachments.js / inspectionAttachments.js) to shrink that window
// to a single round-trip instead of "however long since the list last loaded".
export function resetFmpSession() {
  sessionToken = null;
}

// ── Per-user OAuth session (for write attribution) ────────────────
// The user's FileMaker identity (minted server-side via ensureFmpUserSession →
// /api/fmp-user-token, Basic auth as their account). We hold this user-bound
// Data API token here and use it for MUTATING calls only — so zz__Modified_By
// records the real person. Reads keep
// using the shared admin token, so nothing breaks if a user's privilege set is
// narrower than admin. Admin is always the fallback.
let _userToken = null;
let _userName = null;
let _userEnvId = null;
try {
  _userToken = sessionStorage.getItem('fmp_user_token') || null;
  _userName = sessionStorage.getItem('fmp_user_name') || null;
  _userEnvId = sessionStorage.getItem('fmp_user_env') || null;
} catch { /* sessionStorage unavailable */ }

export function setFmpUserSession(token, name) {
  const env = getCurrentEnv();
  _userToken = token || null;
  _userName = token ? (name || null) : null;
  _userEnvId = token ? env.id : null;
  try {
    if (token) {
      sessionStorage.setItem('fmp_user_token', token);
      if (name) sessionStorage.setItem('fmp_user_name', name);
      sessionStorage.setItem('fmp_user_env', env.id);
    } else {
      sessionStorage.removeItem('fmp_user_token');
      sessionStorage.removeItem('fmp_user_name');
      sessionStorage.removeItem('fmp_user_env');
    }
  } catch { /* ignore */ }
}

// Active user-write token, but only if it belongs to the current environment.
function activeUserToken() {
  if (!_userToken) return null;
  return _userEnvId === getCurrentEnv().id ? _userToken : null;
}

export function getFmpUserName() { return activeUserToken() ? _userName : null; }
export function hasFmpUserSession() { return !!activeUserToken(); }

// Mint a user-bound write token from the server (Option 1: server Basic-auths as
// the logged-in user's FileMaker account). Silent; resolves to the email on
// success or null (no account / not deployed / localhost) — callers fall back to
// admin. No-op if a valid user token already exists for the current env.
let _userMintPromise = null;
export async function ensureFmpUserSession() {
  if (activeUserToken()) return _userName;
  if (_userMintPromise) return _userMintPromise;
  const env = getCurrentEnv();
  _userMintPromise = (async () => {
    try {
      const r = await fetch(`/api/me?fmpDb=${encodeURIComponent(env.db)}`);
      if (!r.ok) return null;
      const data = await r.json();
      if (data?.fmpToken) { setFmpUserSession(data.fmpToken, data.email); return data.email; }
    } catch { /* offline / localhost — fall back to admin */ }
    return null;
  })();
  try { return await _userMintPromise; } finally { _userMintPromise = null; }
}

// Clear write auth after a 401 so the next attempt tries to remint it.
function invalidateWriteAuth() {
  if (_userToken) setFmpUserSession(null);
  sessionToken = null;
}

// Thrown when a mutating call has no valid per-user FileMaker session and
// can't get one — writes require a real connected FileMaker account; there is
// no shared/admin fallback (see getToken). Kept short — it renders inline in
// small save-status badges across many modules, not just the roomier NavRail
// user menu (which shows the fuller "no FileMaker account for your email"
// explanation once the user actually clicks Connect).
export class FmpWriteAuthError extends Error {
  constructor(message = 'FileMaker not connected — see user menu') {
    super(message);
    this.name = 'FmpWriteAuthError';
  }
}

const isLocalDev = () => typeof window !== 'undefined' && window.location.hostname === 'localhost';

// PHASE A4 — there is no `write` mode any more.
//
// This used to take `{ write: true }` and demand a user-bound FileMaker token,
// because it was the single chokepoint every mutating call routed through.
// Every one of those calls now writes to Vibe, and the write functions
// themselves are gone, so "we still write to FileMaker" is no longer merely
// untrue — it is unexpressible. The per-user-FileMaker-account failure class
// goes with it: a user with no FMP account can now do everything the app
// offers.
//
// What remains is read-only: the shared session used by the handful of direct
// reads left (getRecord, findInLayout, container image URLs).
async function getToken() {
  const env = getCurrentEnv();
  // Invalidate token if the environment changed
  if (sessionToken && _tokenEnvId !== env.id) {
    sessionToken = null;
  }
  if (sessionToken) return sessionToken;
  // Coalesce concurrent callers onto a single /sessions request. Without this,
  // a startup burst (bulk prefetch, report flow) each sees no token and creates
  // its own FileMaker session — a dozen redundant 2-3s auth round-trips.
  if (_tokenPromise) return _tokenPromise;
  _tokenPromise = (async () => {
    const res = await fetch(`${getBasePath()}/fmi/data/v2/databases/${env.db}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + btoa(`${env.user}:${env.pass}`),
      },
      body: '{}',
    });
    const data = await res.json();
    if (!data.response?.token) {
      const msg = data.messages?.[0]?.message ?? `Auth failed (HTTP ${res.status})`;
      throw new Error(`FMP [${env.db}]: ${msg}`);
    }
    sessionToken = data.response.token;
    _tokenEnvId = env.id;
    return sessionToken;
  })();
  try {
    return await _tokenPromise;
  } finally {
    _tokenPromise = null;
  }
}

export async function getRecords(layout, limit = 100, offset = 1, signal) {
  const token = await getToken();
  const env = getCurrentEnv();
  const res = await _scheduledFetch(_LOW, () => fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records?_limit=${limit}&_offset=${offset}`,
    { headers: { Authorization: `Bearer ${token}` }, signal }
  ));
  if (res.status === 401) {
    sessionToken = null;
    return getRecords(layout, limit, offset, signal);
  }
  return res.json();
}

// FileMaker publishes a layout's value lists in its metadata, so dropdowns can
// be driven by FMP instead of hardcoded arrays that silently drift out of sync
// (Project Type, Lead Builder and friends had each drifted into two or three
// different versions before this). Editing a list in FileMaker Pro is now the
// only place it needs to change — no code deploy.
//
// Cached for an hour, in memory and localStorage: the metadata payload is large
// (RCD_New ships a ~4,800-entry contact lookup) and value lists change rarely.
const VL_TTL_MS = 60 * 60 * 1000;
// Relationship-backed picker lists (contact lookups etc.) run to thousands of
// entries and are never dropdown vocabularies — skip them so the cached payload
// stays small and can't blow the localStorage quota.
const VL_MAX_VALUES = 200;
const _vlMem = {};

export async function getValueLists(layout) {
  const env = getCurrentEnv();
  const key = `vl:${env.db}:${layout}`;
  const fresh = e => e && Date.now() - e.at < VL_TTL_MS;

  if (fresh(_vlMem[key])) return _vlMem[key].lists;
  try {
    const cached = JSON.parse(localStorage.getItem(key));
    if (fresh(cached)) { _vlMem[key] = cached; return cached.lists; }
  } catch { /* absent or unparseable — fall through and refetch */ }

  const token = await getToken();
  const res = await _scheduledFetch(_LOW, () => fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  ));
  if (res.status === 401) {
    sessionToken = null;
    return getValueLists(layout);
  }
  const data = await res.json();

  const lists = {};
  for (const vl of data?.response?.valueLists ?? []) {
    // FileMaker pads lists with null and whitespace-only placeholder entries
    // ("Type of Project" leads with one, "Status: RCD" trails with a space) —
    // drop them so a select doesn't render blank options.
    const values = [...new Set(
      (vl.values ?? []).map(v => String(v?.displayValue ?? '').trim()).filter(Boolean)
    )];
    if (values.length && values.length <= VL_MAX_VALUES) lists[vl.name] = values;
  }

  const entry = { at: Date.now(), lists };
  _vlMem[key] = entry;
  try { localStorage.setItem(key, JSON.stringify(entry)); } catch { /* quota */ }
  return lists;
}

const MEM_TTL_MS = 5 * 60 * 1000;
// IndexedDB cache lifetime. FileMaker's Data API is extremely slow for big
// layouts (a cold full load of Contacts is minutes), so we keep the local cache
// for a week to spare returning users that cold load. Trade-off: records
// added/deleted by OTHER users or directly in FileMaker can lag up to this long
// in the list (in-app create/edit/delete patch the cache live). The real fix for
// both speed AND freshness is the server-side replica.
const IDB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const memCache = {};

// When true, a present (even stale) cache is displayed as-is and NOT bulk-
// refreshed in the background — individual records refresh on hover/click
// instead (see getRecord). This keeps the all-records fetch from starving
// interactive calls. Flip to false to restore eager background refresh.
const LAZY_REFRESH = true;

// Cache keys are scoped by FileMaker DATABASE as well as layout+version.
//
// Without the database in the key, switching environments served the previous
// environment's records under the new environment's name — the switcher only
// reloads the page, and an IndexedDB entry lives IDB_TTL_MS (a week). Observed
// live: after Development → Production the app reported 6,180 "Production"
// projects (Dev's exact count) and the CCS Kanban showed 8 cards instead of 35,
// because production board recordIds were being matched against Dev records.
// Records created in production after the Dev clone had no match and vanished.
function memKey(layout, cacheVersion) {
  const db = getCurrentEnv().db;
  return cacheVersion ? `${db}__${layout}__v${cacheVersion}` : `${db}__${layout}`;
}
function idbKey(layout, cacheVersion) {
  return `fmp_cache__${memKey(layout, cacheVersion)}`;
}

// ── IndexedDB helpers ─────────────────────────────────────────────
let _db = null;
function getDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('fmp_cache', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('records');
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('records', 'readonly').objectStore('records').get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    tx.objectStore('records').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDelete(key) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    tx.objectStore('records').delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// One-time sweep of pre-database-scoping cache entries (`fmp_cache__<layout>__vN`).
// Nothing reads those keys any more, and nothing else would ever delete them —
// the TTL is only checked on read — so without this they'd sit in IndexedDB
// indefinitely. Runs once per page load, after first use, and is best-effort.
let _purgedLegacy = false;
function purgeLegacyCacheKeys() {
  if (_purgedLegacy) return;
  _purgedLegacy = true;
  const dbPrefixes = FMP_ENVIRONMENTS.map(e => `fmp_cache__${e.db}__`);
  getDb().then(db => {
    const req = db.transaction('records', 'readonly').objectStore('records').getAllKeys();
    req.onsuccess = () => {
      for (const k of req.result || []) {
        const key = String(k);
        if (!key.startsWith('fmp_cache__')) continue;
        if (dbPrefixes.some(p => key.startsWith(p))) continue;
        idbDelete(key).catch(() => {});
      }
    };
  }).catch(() => { /* IDB unavailable */ });
}

// ── Cache read/write ──────────────────────────────────────────────

// Sync: memCache only. Used where async isn't possible.
export function readCache(layout, cacheVersion) {
  const mk = memKey(layout, cacheVersion);
  const mem = memCache[mk];
  if (mem) {
    if (Date.now() - mem.ts < MEM_TTL_MS) return { records: mem.records, total: mem.total, fresh: true, complete: mem.complete };
    delete memCache[mk];
  }
  return null;
}

// Async: memCache → IndexedDB. Used in getAllRecords.
export async function readCacheAsync(layout, cacheVersion) {
  const sync = readCache(layout, cacheVersion);
  if (sync) return sync;
  try {
    const entry = await idbGet(idbKey(layout, cacheVersion));
    if (entry) {
      if (Date.now() - entry.ts < IDB_TTL_MS) {
        memCache[memKey(layout, cacheVersion)] = { ts: entry.ts, records: entry.records, total: entry.total, complete: entry.complete };
        return { records: entry.records, total: entry.total, fresh: false, complete: entry.complete ?? true };
      }
      idbDelete(idbKey(layout, cacheVersion)).catch(() => {});
    }
  } catch { /* IDB unavailable */ }
  return null;
}

async function writeCache(layout, records, total, complete = true, cacheVersion) {
  const mk = memKey(layout, cacheVersion);
  const ts = Date.now();
  memCache[mk] = { ts, records, total, complete };
  try { await idbSet(idbKey(layout, cacheVersion), { ts, records, total, complete }); } catch { /* ignore */ }
}

export function bustCache(layout, cacheVersion) {
  delete memCache[memKey(layout, cacheVersion)];
  idbDelete(idbKey(layout, cacheVersion)).catch(() => {});
}

// ── Pub/sub ───────────────────────────────────────────────────────
const cacheSubscribers = new Map();

export function subscribeCacheUpdates(layout, cacheVersion, callback) {
  const key = memKey(layout, cacheVersion);
  if (!cacheSubscribers.has(key)) cacheSubscribers.set(key, new Set());
  cacheSubscribers.get(key).add(callback);
  return () => cacheSubscribers.get(key)?.delete(callback);
}

// ── Pending local writes ──────────────────────────────────────────
// The Redis replica trails FileMaker by up to one sync interval (5 min in
// production), so a record just edited in the app reads STALE from the replica
// for a short window. Any replica re-read in that window — the board's Refresh
// button, or the background stale-while-revalidate that fires on the next
// module load — would otherwise write the pre-edit value back over the correct
// one. Observed live: two CCS cards moved and saved, then Refresh put both back
// in their original lanes.
//
// So every local patch is remembered briefly and re-applied on top of whatever
// the replica returns. An entry clears as soon as the replica agrees (the sync
// caught up) or after PENDING_WRITE_MS, whichever comes first — it can only
// ever re-assert what this client itself last wrote.
const PENDING_WRITE_MS = 10 * 60 * 1000;
const pendingWrites = new Map(); // `${memKey}:${recordId}` → { fieldData, at }

function rememberWrite(mk, recordId, fieldData) {
  pendingWrites.set(`${mk}:${recordId}`, { fieldData: { ...fieldData }, at: Date.now() });
}

function applyPendingWrites(mk, records) {
  if (!pendingWrites.size) return records;
  const now = Date.now();
  let touched = false;
  const out = records.map(r => {
    const k = `${mk}:${r.recordId}`;
    const pending = pendingWrites.get(k);
    if (!pending) return r;
    if (now - pending.at > PENDING_WRITE_MS) { pendingWrites.delete(k); return r; }
    // Replica has caught up — stop shadowing it.
    if (Object.entries(pending.fieldData).every(([f, v]) => r.fieldData?.[f] === v)) {
      pendingWrites.delete(k);
      return r;
    }
    touched = true;
    return { ...r, fieldData: { ...r.fieldData, ...pending.fieldData } };
  });
  return touched ? out : records;
}

// Patch a single record in memCache + IDB and notify subscribers.
export function patchCachedRecord(layout, cacheVersion, recordId, fieldData) {
  const mk = memKey(layout, cacheVersion);
  const rid = String(recordId);
  rememberWrite(mk, rid, fieldData);

  if (memCache[mk]) {
    memCache[mk].records = memCache[mk].records.map(r =>
      String(r.recordId) === rid ? { ...r, fieldData: { ...r.fieldData, ...fieldData } } : r
    );
    // Persist patched records to IDB async (fire-and-forget)
    idbSet(idbKey(layout, cacheVersion), { ...memCache[mk] }).catch(() => {});
  }

  const subs = cacheSubscribers.get(mk);
  if (subs?.size && memCache[mk]) {
    const { records, total } = memCache[mk];
    subs.forEach(cb => cb(records, total));
  }
}

// Prepend a newly created record to the cache + IDB and notify subscribers, so a
// just-created record shows in the list without a full refetch. No-op if the
// cache for this layout isn't populated yet (it'll appear on the next load).
export function addCachedRecord(layout, cacheVersion, record) {
  const mk = memKey(layout, cacheVersion);
  if (!memCache[mk] || !record) return;
  memCache[mk].records = [record, ...memCache[mk].records];
  if (typeof memCache[mk].total === 'number') memCache[mk].total += 1;
  idbSet(idbKey(layout, cacheVersion), { ...memCache[mk] }).catch(() => {});
  const subs = cacheSubscribers.get(mk);
  if (subs?.size) {
    const { records, total } = memCache[mk];
    subs.forEach(cb => cb(records, total));
  }
}

// Drop a deleted record from the cache and notify subscribers, so the list it
// was in updates without a refetch. Mirrors addCachedRecord.
export function removeCachedRecord(layout, cacheVersion, recordId) {
  const mk = memKey(layout, cacheVersion);
  const rid = String(recordId);
  if (!memCache[mk]?.records) return;
  const before = memCache[mk].records.length;
  memCache[mk].records = memCache[mk].records.filter(r => String(r.recordId) !== rid);
  const removed = before - memCache[mk].records.length;
  if (!removed) return;
  if (typeof memCache[mk].total === 'number') memCache[mk].total -= removed;
  idbSet(idbKey(layout, cacheVersion), { ...memCache[mk] }).catch(() => {});
  const subs = cacheSubscribers.get(mk);
  if (subs?.size) {
    const { records, total } = memCache[mk];
    subs.forEach(cb => cb(records, total));
  }
}

// Patch a record into every cached version of a layout and notify subscribers.
// Lets a fresh single-record fetch (hover/click) update the displayed list row
// without the caller needing to know its cacheVersion. When portalData is given
// (a full record fetch), it REPLACES the cached portalData so related-row edits
// (e.g. BOM add/remove) don't linger in the list cache across reloads.
function patchCachedRecordAcrossVersions(layout, recordId, fieldData, portalData) {
  const rid = String(recordId);
  // Scoped to the CURRENT database — cache keys carry it (see memKey), so a
  // record fetched here can never leak into another environment's cache.
  const db = getCurrentEnv().db;
  const bare = `${db}__${layout}`;
  const prefix = `${bare}__v`;
  for (const mk of Object.keys(memCache)) {
    if (mk !== bare && !mk.startsWith(prefix)) continue;
    const entry = memCache[mk];
    if (!entry?.records) continue;
    let changed = false;
    entry.records = entry.records.map(r => {
      if (String(r.recordId) !== rid) return r;
      changed = true;
      const next = { ...r, fieldData: { ...r.fieldData, ...fieldData } };
      if (portalData) next.portalData = portalData;
      return next;
    });
    if (!changed) continue;
    idbSet(`fmp_cache__${mk}`, { ...entry }).catch(() => {});
    const subs = cacheSubscribers.get(mk);
    if (subs?.size) subs.forEach(cb => cb(entry.records, entry.total));
  }
}

// Build an image URL for a container field.
// In dev: use the Vite-proxied Streaming_SSL URL directly.
// In prod: route through /api/image which authenticates server-side.
export function containerImageUrl(streamingUrl, { db, layout, recordId, field = 'Picture' } = {}) {
  if (!streamingUrl) return null;
  if (import.meta.env.DEV) {
    try {
      const u = new URL(streamingUrl);
      return u.pathname + u.search;
    } catch { return streamingUrl; }
  }
  return `/api/image?db=${encodeURIComponent(db)}&layout=${encodeURIComponent(layout)}&recordId=${encodeURIComponent(recordId)}&field=${encodeURIComponent(field)}`;
}

export async function findRecords(layout, query, limit, offset, signal, sort) {
  const token = await getToken();
  const env = getCurrentEnv();
  const body = { query, limit, offset };
  if (sort) body.sort = sort;
  const res = await _scheduledFetch(_LOW, () => fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/_find`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }
  ));
  if (res.status === 401) {
    sessionToken = null;
    return findRecords(layout, query, limit, offset, signal);
  }
  return res.json();
}

const CHECKPOINT_EVERY = 10;

async function fetchAllFromServer(layout, { onProgress, batchSize, cacheVersion, findQuery, sort }) {
  const controller = new AbortController();
  let all = [];
  let total = null;
  let offset = 1;

  while (true) {
    const data = findQuery
      ? await findRecords(layout, findQuery, batchSize, offset, controller.signal, sort)
      : await getRecords(layout, batchSize, offset, controller.signal);
    const batch = data.response?.data || [];
    if (total === null) total = data.response?.dataInfo?.foundCount ?? data.response?.dataInfo?.totalRecordCount ?? 0;
    all = all.concat(batch);
    const done = all.length >= total || batch.length === 0;
    if (onProgress) onProgress({ records: all, total, done });
    if (done) break;
    offset += batchSize;
  }

  await writeCache(layout, all, total, true, cacheVersion);
  return { records: all, total };
}

// Layouts mirrored into the server-side Redis replica (FMP layout → replica key,
// see api/_replica.js). For these, a cold load reads one fast endpoint instead
// of paginating FileMaker for minutes.
const REPLICA_LAYOUTS = {
  'Contacts_New': 'contacts',
  'Estimates_New': 'estimates',
  'Inspections_New': 'inspections',
  'trainings_New': 'trainings',
  'RMI_New': 'rmi',
  'RCD_New': 'projects',
  'OELookup_New': 'oelookup',
  'Products & Services_New': 'products',
};

// Try the Redis replica for a full-set load. Returns { records, total } or null
// to fall back to FileMaker (replica not configured, not yet populated, errored,
// or a filtered/find query the replica can't serve).
async function fetchFromReplica(layout, findQuery, onProgress) {
  const key = REPLICA_LAYOUTS[layout];
  if (!key || findQuery) return null;
  const env = getCurrentEnv();
  try {
    const all = [];
    let cursor = '0';
    let pages = 0;
    do {
      const r = await fetch(`/api/records?layout=${encodeURIComponent(key)}&db=${encodeURIComponent(env.db)}&cursor=${encodeURIComponent(cursor)}`);
      if (!r.ok) return null;
      const data = await r.json();
      if (pages === 0 && !data?.records?.length) return null; // not warmed yet → fall back to FMP
      if (data.records?.length) all.push(...data.records);
      cursor = data.cursor;
      pages++;
      if (onProgress) onProgress({ records: all, total: all.length, done: cursor === '0' });
    } while (cursor && cursor !== '0' && pages < 200);
    return all.length ? { records: all, total: all.length } : null;
  } catch {
    return null;
  }
}

// Push the current cached records for a layout/version to any live subscribers
// (the useAllRecords hook), so a background refresh updates the list on screen.
function notifySubscribers(mk) {
  const subs = cacheSubscribers.get(mk);
  if (subs?.size && memCache[mk]) {
    const { records, total } = memCache[mk];
    subs.forEach(cb => cb(records, total));
  }
}

// Stale-while-revalidate for replica-backed layouts: after serving the cached
// snapshot, quietly re-pull from the fast Redis replica and update the cache +
// list. Cheap now that replica reads are ~1-6s (vs the slow FileMaker pagination
// that LAZY_REFRESH was protecting against). Deduped so concurrent callers/
// re-renders trigger at most one refresh in flight per layout/version.
const revalidating = new Set();
async function revalidateFromReplica(layout, cacheVersion) {
  const mk = memKey(layout, cacheVersion);
  if (revalidating.has(mk)) return;
  revalidating.add(mk);
  try {
    const repl = await fetchFromReplica(layout, null);
    if (repl) {
      // Keep just-made local edits on top — the replica may not have synced them yet.
      const records = applyPendingWrites(mk, repl.records);
      await writeCache(layout, records, repl.total, true, cacheVersion);
      notifySubscribers(mk);
    }
  } catch { /* ignore — keep serving cache */ }
  finally { revalidating.delete(mk); }
}

export async function getAllRecords(layout, { onProgress, batchSize = 100, slimForStorage, cacheVersion, findQuery, sort } = {}) {
  purgeLegacyCacheKeys();
  const mk = memKey(layout, cacheVersion);
  const cached = await readCacheAsync(layout, cacheVersion);

  if (cached?.fresh && cached?.complete) {
    if (onProgress) onProgress({ records: cached.records, total: cached.total, done: true });
    return cached;
  }

  if (cached) {
    if (onProgress) onProgress({ records: cached.records, total: cached.total, done: true });
    // Serve the cache instantly, then refresh in the background so separate
    // browsers/tabs converge within seconds instead of waiting out the cache TTL.
    if (REPLICA_LAYOUTS[layout] && !findQuery) {
      revalidateFromReplica(layout, cacheVersion); // fast replica re-pull (stale-while-revalidate)
    } else if (!LAZY_REFRESH) {
      // Non-replica layouts stay lazy — a full FileMaker re-fetch is slow and
      // would starve interactive calls.
      fetchAllFromServer(layout, { batchSize, cacheVersion, findQuery, sort }).catch(() => {});
    }
    return cached;
  }

  // No local cache: try the fast Redis replica before the slow FMP pagination.
  // This is also the path a board/list Refresh takes (bustCache, then re-fetch),
  // so the pending-write overlay matters here too — without it, pressing Refresh
  // within a sync interval of an edit rolls the edit back on screen.
  const repl = await fetchFromReplica(layout, findQuery, onProgress);
  if (repl) {
    const records = applyPendingWrites(mk, repl.records);
    await writeCache(layout, records, repl.total, true, cacheVersion);
    if (onProgress) onProgress({ records, total: repl.total, done: true });
    return { records, total: repl.total };
  }

  return fetchAllFromServer(layout, { onProgress, batchSize, cacheVersion, findQuery, sort });
}

const detailCache = new Map();

// Fetches through /api/record, which merges Vibe's own edits over FileMaker's
// copy (see api/_vibeStore.js). Going direct to FileMaker here would return the
// pre-Vibe value AND write it into the list cache below — silently undoing
// every Vibe edit the moment a record was opened.
//
// Localhost has no serverless functions, so it falls back to FileMaker direct.
// The overlay is empty there anyway, which makes the two paths equivalent until
// local development gains a way to run the API.
function recordUrl(layout, recordId, env) {
  return isLocalDev()
    ? `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records/${recordId}`
    : `/api/record?db=${encodeURIComponent(env.db)}&layout=${encodeURIComponent(layout)}&recordId=${encodeURIComponent(recordId)}`;
}

export async function getRecord(layout, recordId) {
  const key = `${layout}:${recordId}`;
  if (detailCache.has(key)) return detailCache.get(key);
  const token = await getToken();
  const env = getCurrentEnv();
  const res = await _scheduledFetch(_HIGH, () => fetch(
    recordUrl(layout, recordId, env),
    // no-store: this single-record URL is constant, so the browser HTTP cache
    // would otherwise serve a stale copy after a related-row (portal) edit —
    // making BOM add/edit/remove look like nothing happened until a full reload.
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'include' }
  ));
  if (res.status === 401) {
    sessionToken = null;
    detailCache.delete(key);
    return getRecord(layout, recordId);
  }
  // Refresh the matching list row from this fresh fetch (hover/click), so the
  // displayed list reflects current data even though we don't bulk-refresh.
  const promise = res.json().then(data => {
    const rec = data?.response?.data?.[0];
    if (rec) patchCachedRecordAcrossVersions(layout, recordId, rec.fieldData, rec.portalData);
    return data;
  });
  detailCache.set(key, promise);
  return promise;
}

// Fire-and-forget prefetch — call on hover so detail is ready before click
export function prefetchRecord(layout, recordId) {
  const key = `${layout}:${recordId}`;
  if (!detailCache.has(key)) getRecord(layout, recordId);
}

// Remove a record from the detail cache so the next getRecord call hits the server
export function invalidateRecord(layout, recordId) {
  detailCache.delete(`${layout}:${recordId}`);
}

// Fetch a single record with explicit portal row limits (default getRecord caps portals).
export async function getRecordWithPortals(layout, recordId, portalLimits = {}) {
  const token = await getToken();
  const env = getCurrentEnv();
  const qs = Object.entries(portalLimits).map(([p, n]) => `_limit.${encodeURIComponent(p)}=${n}`).join('&');
  const res = await _scheduledFetch(_HIGH, () => fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records/${recordId}${qs ? '?' + qs : ''}`,
    { headers: { Authorization: `Bearer ${token}` } }
  ));
  if (res.status === 401) { sessionToken = null; return getRecordWithPortals(layout, recordId, portalLimits); }
  return res.json();
}

// Find records on an arbitrary layout (returns the raw Data API response).
export async function findInLayout(layout, query, { sort, limit = 500 } = {}) {
  const token = await getToken();
  const env = getCurrentEnv();
  const body = { query, limit };
  if (sort) body.sort = sort;
  const res = await fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/_find`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }
  );
  if (res.status === 401) { sessionToken = null; return findInLayout(layout, query, { sort, limit }); }
  return res.json();
}
