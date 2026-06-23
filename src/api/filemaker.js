import { getCurrentEnv } from '../config/fmpEnvironments';

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

// ── Per-user OAuth session (for write attribution) ────────────────
// When a user connects their FileMaker identity via Google OAuth (see
// api/fmpOAuth.js), we hold a user-bound Data API token here and use it for
// MUTATING calls only — so zz__Modified_By records the real person. Reads keep
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

// Clear write auth after a 401 so the next attempt falls back to admin.
function invalidateWriteAuth() {
  if (_userToken) setFmpUserSession(null);
  sessionToken = null;
}

async function getToken({ write = false } = {}) {
  // Mutating calls prefer the user-bound token (correct attribution); reads and
  // any fallback use the shared admin token.
  if (write) {
    const ut = activeUserToken();
    if (ut) return ut;
  }
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

const MEM_TTL_MS = 5 * 60 * 1000;
const IDB_TTL_MS = 24 * 60 * 60 * 1000;
const memCache = {};

// When true, a present (even stale) cache is displayed as-is and NOT bulk-
// refreshed in the background — individual records refresh on hover/click
// instead (see getRecord). This keeps the all-records fetch from starving
// interactive calls. Flip to false to restore eager background refresh.
const LAZY_REFRESH = true;

function idbKey(layout, cacheVersion) {
  return cacheVersion ? `fmp_cache__${layout}__v${cacheVersion}` : `fmp_cache__${layout}`;
}
function memKey(layout, cacheVersion) {
  return cacheVersion ? `${layout}__v${cacheVersion}` : layout;
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

// Patch a single record in memCache + IDB and notify subscribers.
export function patchCachedRecord(layout, cacheVersion, recordId, fieldData) {
  const mk = memKey(layout, cacheVersion);
  const rid = String(recordId);

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

// Patch a record into every cached version of a layout and notify subscribers.
// Lets a fresh single-record fetch (hover/click) update the displayed list row
// without the caller needing to know its cacheVersion.
function patchCachedRecordAcrossVersions(layout, recordId, fieldData) {
  const rid = String(recordId);
  const prefix = `${layout}__v`;
  for (const mk of Object.keys(memCache)) {
    if (mk !== layout && !mk.startsWith(prefix)) continue;
    const entry = memCache[mk];
    if (!entry?.records) continue;
    let changed = false;
    entry.records = entry.records.map(r => {
      if (String(r.recordId) !== rid) return r;
      changed = true;
      return { ...r, fieldData: { ...r.fieldData, ...fieldData } };
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

async function findRecords(layout, query, limit, offset, signal, sort) {
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

export async function getAllRecords(layout, { onProgress, batchSize = 100, slimForStorage, cacheVersion, findQuery, sort } = {}) {
  const cached = await readCacheAsync(layout, cacheVersion);

  if (cached?.fresh && cached?.complete) {
    if (onProgress) onProgress({ records: cached.records, total: cached.total, done: true });
    return cached;
  }

  if (cached) {
    if (onProgress) onProgress({ records: cached.records, total: cached.total, done: true });
    // Lazy mode: show the cache and let hover/click refresh individual records,
    // rather than re-fetching everything (which starves interactive calls).
    if (!LAZY_REFRESH) fetchAllFromServer(layout, { batchSize, cacheVersion, findQuery, sort }).catch(() => {});
    return cached;
  }

  return fetchAllFromServer(layout, { onProgress, batchSize, cacheVersion, findQuery, sort });
}

const detailCache = new Map();

export async function getRecord(layout, recordId) {
  const key = `${layout}:${recordId}`;
  if (detailCache.has(key)) return detailCache.get(key);
  const token = await getToken();
  const env = getCurrentEnv();
  const res = await _scheduledFetch(_HIGH, () => fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records/${recordId}`,
    { headers: { Authorization: `Bearer ${token}` } }
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
    if (rec) patchCachedRecordAcrossVersions(layout, recordId, rec.fieldData);
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

export async function createRecord(layout, fieldData) {
  const token = await getToken({ write: true });
  const env = getCurrentEnv();
  const res = await fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fieldData }),
    }
  );
  if (res.status === 401) { invalidateWriteAuth(); return createRecord(layout, fieldData); }
  return res.json();
}

export async function addPortalRow(layout, recordId, portalName, rowData) {
  const token = await getToken({ write: true });
  const env = getCurrentEnv();
  const res = await fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records/${recordId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ portalData: { [portalName]: [rowData] } }),
    }
  );
  if (res.status === 401) { invalidateWriteAuth(); return addPortalRow(layout, recordId, portalName, rowData); }
  return res.json();
}

export async function updateRecord(layout, recordId, fieldData) {
  const token = await getToken({ write: true });
  const env = getCurrentEnv();
  const res = await fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records/${recordId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fieldData }),
    }
  );
  if (res.status === 401) {
    invalidateWriteAuth();
    return updateRecord(layout, recordId, fieldData);
  }
  return res.json();
}

export async function deleteRecord(layout, recordId) {
  const token = await getToken({ write: true });
  const env = getCurrentEnv();
  const res = await fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records/${recordId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.status === 401) { invalidateWriteAuth(); return deleteRecord(layout, recordId); }
  return res.json();
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

// Upload a file (Blob/File) into a container field on a record. Works through the
// /fmi proxy in dev and prod (multipart body is forwarded).
export async function uploadContainer(layout, recordId, field, file, filename) {
  const token = await getToken({ write: true });
  const env = getCurrentEnv();
  const fd = new FormData();
  fd.append('upload', file, filename || file.name || 'file');
  const res = await fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records/${recordId}/containers/${encodeURIComponent(field)}/1`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd }
  );
  if (res.status === 401) { invalidateWriteAuth(); return uploadContainer(layout, recordId, field, file, filename); }
  return res.json();
}
