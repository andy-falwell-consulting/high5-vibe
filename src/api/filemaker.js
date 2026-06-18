import { getCurrentEnv } from '../config/fmpEnvironments';

// Run async tasks with max concurrency
async function pLimit(concurrency, tasks) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// /fmi/* is proxied in both dev (Vite) and prod (Vercel rewrite → /api/proxy).
function getBasePath() {
  return '';
}

let sessionToken = null;
let _tokenEnvId = null;

async function getToken() {
  const env = getCurrentEnv();
  // Invalidate token if the environment changed
  if (sessionToken && _tokenEnvId !== env.id) {
    sessionToken = null;
  }
  if (sessionToken) return sessionToken;
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
}

export async function getRecords(layout, limit = 100, offset = 1, signal) {
  const token = await getToken();
  const env = getCurrentEnv();
  const res = await fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records?_limit=${limit}&_offset=${offset}`,
    { headers: { Authorization: `Bearer ${token}` }, signal }
  );
  if (res.status === 401) {
    sessionToken = null;
    return getRecords(layout, limit, offset, signal);
  }
  return res.json();
}

const MEM_TTL_MS = 5 * 60 * 1000;
const LS_TTL_MS = 24 * 60 * 60 * 1000;
const memCache = {};

function lsKey(layout, cacheVersion) {
  return cacheVersion ? `fmp_cache__${layout}__v${cacheVersion}` : `fmp_cache__${layout}`;
}
function memKey(layout, cacheVersion) {
  return cacheVersion ? `${layout}__v${cacheVersion}` : layout;
}

function readCache(layout, cacheVersion) {
  const mk = memKey(layout, cacheVersion);
  // 1. Check in-memory cache first
  const mem = memCache[mk];
  if (mem) {
    if (Date.now() - mem.ts < MEM_TTL_MS) return { records: mem.records, total: mem.total, fresh: true, complete: mem.complete };
    delete memCache[mk];
  }
  // 2. Fall back to localStorage
  try {
    const raw = localStorage.getItem(lsKey(layout, cacheVersion));
    if (raw) {
      const entry = JSON.parse(raw);
      if (Date.now() - entry.ts < LS_TTL_MS) return { records: entry.records, total: entry.total, fresh: false, complete: entry.complete ?? true };
      localStorage.removeItem(lsKey(layout, cacheVersion));
    }
  } catch { /* storage unavailable */ }
  return null;
}

function writeCache(layout, records, total, complete = true, storageRecords = null, cacheVersion) {
  const mk = memKey(layout, cacheVersion);
  const ts = Date.now();
  if (complete) memCache[mk] = { ts, records, total, complete };
  // Write slim records to localStorage (caller may pass a smaller subset to stay within quota)
  const lsRecords = storageRecords ?? records;
  try { localStorage.setItem(lsKey(layout, cacheVersion), JSON.stringify({ ts, records: lsRecords, total, complete })); } catch { /* quota exceeded */ }
}

export function bustCache(layout, cacheVersion) {
  delete memCache[memKey(layout, cacheVersion)];
  try { localStorage.removeItem(lsKey(layout, cacheVersion)); } catch { /* ignore */ }
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

async function findRecords(layout, query, limit, offset, signal) {
  const token = await getToken();
  const env = getCurrentEnv();
  const res = await fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/_find`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit, offset }),
      signal,
    }
  );
  if (res.status === 401) {
    sessionToken = null;
    return findRecords(layout, query, limit, offset, signal);
  }
  return res.json();
}

const CHECKPOINT_EVERY = 10; // batches between localStorage checkpoints during initial fetch

async function fetchAllFromServer(layout, { onProgress, batchSize, slimForStorage, cacheVersion, findQuery }) {
  const controller = new AbortController();
  let all = [];
  let total = null;
  let offset = 1;
  let batchCount = 0;

  while (true) {
    const data = findQuery
      ? await findRecords(layout, findQuery, batchSize, offset, controller.signal)
      : await getRecords(layout, batchSize, offset, controller.signal);
    const batch = data.response?.data || [];
    if (total === null) total = data.response?.dataInfo?.foundCount ?? data.response?.dataInfo?.totalRecordCount ?? 0;
    all = all.concat(batch);
    batchCount++;
    const done = all.length >= total || batch.length === 0;
    if (onProgress) onProgress({ records: all, total, done });
    // Checkpoint partial progress to localStorage so a refresh can serve stale data immediately
    if (batchCount % CHECKPOINT_EVERY === 0 && !done) {
      const slim = slimForStorage ? all.map(slimForStorage) : null;
      writeCache(layout, all, total, false, slim, cacheVersion);
    }
    if (done) break;
    offset += batchSize;
  }

  const slim = slimForStorage ? all.map(slimForStorage) : null;
  writeCache(layout, all, total, true, slim, cacheVersion);
  return { records: all, total };
}

export async function getAllRecords(layout, { onProgress, batchSize = 100, slimForStorage, cacheVersion, findQuery } = {}) {
  const cached = readCache(layout, cacheVersion);

  if (cached?.fresh && cached?.complete) {
    if (onProgress) onProgress({ records: cached.records, total: cached.total, done: true });
    return cached;
  }

  if (cached) {
    if (onProgress) onProgress({ records: cached.records, total: cached.total, done: true });
    fetchAllFromServer(layout, { batchSize, slimForStorage, cacheVersion, findQuery }).catch(() => {});
    return cached;
  }

  return fetchAllFromServer(layout, { onProgress, batchSize, slimForStorage, cacheVersion, findQuery });
}

const detailCache = new Map();

export async function getRecord(layout, recordId) {
  const key = `${layout}:${recordId}`;
  if (detailCache.has(key)) return detailCache.get(key);
  const token = await getToken();
  const env = getCurrentEnv();
  const res = await fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records/${recordId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const promise = res.json();
  detailCache.set(key, promise);
  return promise;
}

// Fire-and-forget prefetch — call on hover so detail is ready before click
export function prefetchRecord(layout, recordId) {
  const key = `${layout}:${recordId}`;
  if (!detailCache.has(key)) getRecord(layout, recordId);
}

export async function createRecord(layout, fieldData) {
  const token = await getToken();
  const env = getCurrentEnv();
  const res = await fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fieldData }),
    }
  );
  if (res.status === 401) { sessionToken = null; return createRecord(layout, fieldData); }
  return res.json();
}

export async function addPortalRow(layout, recordId, portalName, rowData) {
  const token = await getToken();
  const env = getCurrentEnv();
  const res = await fetch(
    `${getBasePath()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records/${recordId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ portalData: { [portalName]: [rowData] } }),
    }
  );
  if (res.status === 401) { sessionToken = null; return addPortalRow(layout, recordId, portalName, rowData); }
  return res.json();
}

export async function updateRecord(layout, recordId, fieldData) {
  const token = await getToken();
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
    sessionToken = null;
    return updateRecord(layout, recordId, fieldData);
  }
  return res.json();
}
