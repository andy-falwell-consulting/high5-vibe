import { getCurrentEnv } from '../config/fmpEnvironments';

// PHASE C3 — read value lists from Vibe.
//
// Replaces the browser's direct FileMaker call (src/api/filemaker.js
// getValueLists) as the FIRST choice. The server still reads through to
// FileMaker for any layout Vibe has not been seeded for, so nothing changes
// before cutover — but once seeded, the vocabulary is Vibe's and survives
// FileMaker's retirement.
//
// Cached in memory and localStorage exactly as the FileMaker path was: a
// dropdown must not wait on a round trip, and these change rarely.

const TTL_MS = 60 * 60 * 1000;
const mem = {};

const keyFor = layout => `vibevl:${getCurrentEnv().db}:${layout}`;
const fresh = e => e && Date.now() - e.at < TTL_MS;

/** `{ lists, source }` where source is 'vibe' | 'filemaker' | 'none'.
 *  Returns null on failure so the caller can fall back rather than showing an
 *  empty dropdown. */
export async function getVibeValueLists(layout) {
  const key = keyFor(layout);
  if (fresh(mem[key])) return mem[key].data;
  try {
    const cached = JSON.parse(localStorage.getItem(key));
    if (fresh(cached)) { mem[key] = cached; return cached.data; }
  } catch { /* absent or unparseable — refetch */ }

  try {
    const db = getCurrentEnv().db;
    const res = await fetch(
      `/api/value-lists?db=${encodeURIComponent(db)}&layout=${encodeURIComponent(layout)}`,
      { credentials: 'include' });
    if (!res.ok) return null;
    const body = await res.json();
    const data = { lists: body.lists || {}, source: body.source || 'none' };
    const entry = { at: Date.now(), data };
    mem[key] = entry;
    try { localStorage.setItem(key, JSON.stringify(entry)); } catch { /* quota */ }
    return data;
  } catch { return null; }
}

/** Drop the cache for a layout — called after an admin edits a list, so the
 *  change shows without waiting out the hour. */
export function invalidateValueLists(layout) {
  const key = keyFor(layout);
  delete mem[key];
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// ── Admin operations ────────────────────────────────────────────────────────

const post = async (layout, payload) => {
  const db = getCurrentEnv().db;
  const res = await fetch(
    `/api/value-lists?db=${encodeURIComponent(db)}&layout=${encodeURIComponent(layout)}`,
    { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  invalidateValueLists(layout);
  return body;
};

export const seedValueLists = layout => post(layout, { action: 'seed' });
export const setValueList = (layout, name, values) => post(layout, { action: 'set', name, values });
export const removeValueList = (layout, name) => post(layout, { action: 'remove', name });

/** What Vibe holds vs what FileMaker still has — admin only. */
export async function compareValueLists(layout) {
  const db = getCurrentEnv().db;
  const res = await fetch(
    `/api/value-lists?db=${encodeURIComponent(db)}&layout=${encodeURIComponent(layout)}&compare=1`,
    { credentials: 'include' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
