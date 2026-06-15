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

// In dev the Vite proxy intercepts /fmi/* so we use a relative host.
// In production we hit the FMP server directly.
function getHost() {
  return import.meta.env.DEV ? '' : getCurrentEnv().host;
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
  const res = await fetch(`${getHost()}/fmi/data/v2/databases/${env.db}/sessions`, {
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
    `${getHost()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records?_limit=${limit}&_offset=${offset}`,
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

export function proxyImageUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return import.meta.env.DEV ? u.pathname + u.search : url;
  } catch { return url; }
}

export async function getAllRecords(layout, { onProgress, batchSize = 100 } = {}) {
  const cached = readCache(layout);
  if (cached) {
    if (onProgress) onProgress({ records: cached.records, total: cached.total, done: true });
    return cached;
  }

  const controller = new AbortController();
  let all = [];
  let total = null;
  let offset = 1;

  try {
    while (true) {
      const data = await getRecords(layout, batchSize, offset, controller.signal);
      const batch = data.response?.data || [];
      if (total === null) total = data.response?.dataInfo?.totalRecordCount || 0;
      all = all.concat(batch);
      if (onProgress) onProgress({ records: all, total, done: all.length >= total });
      if (all.length >= total || batch.length === 0) break;
      offset += batchSize;
    }
    writeCache(layout, all, total);
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  }

  return { records: all, total };
}

export async function getRecord(layout, recordId) {
  const token = await getToken();
  const env = getCurrentEnv();
  const res = await fetch(
    `${getHost()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records/${recordId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.json();
}

export async function addPortalRow(layout, recordId, portalName, rowData) {
  const token = await getToken();
  const env = getCurrentEnv();
  const res = await fetch(
    `${getHost()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records/${recordId}`,
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
    `${getHost()}/fmi/data/v2/databases/${env.db}/layouts/${encodeURIComponent(layout)}/records/${recordId}`,
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
