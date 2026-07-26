import { getCurrentEnv } from '../config/fmpEnvironments';

// Client for the per-record N/A-flag set (see api/na-flags.js).
// Note: /api/* doesn't run on localhost (Vite only proxies /fmi), so these
// degrade to a no-op there.

const url = (db, recordId, ns) =>
  `/api/na-flags?db=${encodeURIComponent(db)}&recordId=${encodeURIComponent(recordId)}${ns ? `&ns=${encodeURIComponent(ns)}` : ''}`;

export async function fetchNaFlags(recordId, ns) {
  const db = getCurrentEnv().db;
  try {
    const r = await fetch(url(db, recordId, ns), { credentials: 'include' });
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    return Array.isArray(j.keys) ? j.keys.map(String) : [];
  } catch { return []; }
}

// `key` may be a single id or an array (one request for a whole batch).
export async function setNaFlag(recordId, key, on, ns) {
  const db = getCurrentEnv().db;
  const r = await fetch(url(db, recordId, ns), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: Array.isArray(key) ? key.map(String) : String(key), on }),
  });
  if (!r.ok) throw new Error('Could not update flag');
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j.keys) ? j.keys.map(String) : [];
}

// ── Carried-over inspection lines ────────────────────────────────
// Lines copied from a prior year's inspection stay flagged until someone
// edits them, so a stale finding can't quietly ship under a new date.
const CARRIED = 'carried';
export const fetchCarriedLines = recordId => fetchNaFlags(recordId, CARRIED);
export const markCarriedLines = (recordId, lineIds) => setNaFlag(recordId, lineIds, true, CARRIED);
export const clearCarriedLine = (recordId, lineId) => setNaFlag(recordId, lineId, false, CARRIED);
