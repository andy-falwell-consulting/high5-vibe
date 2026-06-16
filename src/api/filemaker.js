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

const CACHE_TTL_MS = 5 * 60 * 1000;
const memCache = {};

function readCache(layout) {
  const entry = memCache[layout];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { delete memCache[layout]; return null; }
  return { records: entry.records, total: entry.total };
}

function writeCache(layout, records, total) {
  memCache[layout] = { ts: Date.now(), records, total };
}

export function bustCache(layout) {
  delete memCache[layout];
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

export async function getAllRecords(layout, { onProgress, batchSize = 1000, concurrency = 5 } = {}) {
  const cached = readCache(layout);
  if (cached) {
    if (onProgress) onProgress({ records: cached.records, total: cached.total, done: true });
    return cached;
  }

  const controller = new AbortController();

  try {
    // First batch reveals total count
    const first = await getRecords(layout, batchSize, 1, controller.signal);
    const firstBatch = first.response?.data || [];
    const total = first.response?.dataInfo?.totalRecordCount || 0;

    let all = firstBatch;
    if (onProgress) onProgress({ records: all, total, done: all.length >= total });

    if (all.length < total) {
      // Build remaining page tasks and fetch in parallel
      const offsets = [];
      for (let offset = batchSize + 1; offset <= total; offset += batchSize) offsets.push(offset);

      const tasks = offsets.map(offset => () => getRecords(layout, batchSize, offset, controller.signal));
      const results = await pLimit(concurrency, tasks);

      for (const data of results) {
        all = all.concat(data.response?.data || []);
        if (onProgress) onProgress({ records: all, total, done: all.length >= total });
      }
    }

    writeCache(layout, all, total);
    return { records: all, total };
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
    return { records: [], total: 0 };
  }
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
