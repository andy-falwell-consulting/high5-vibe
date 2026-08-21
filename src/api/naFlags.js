import { getCurrentEnv } from '../config/fmpEnvironments';
import { getPinned } from './offlineStore';

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

/**
 * Which lines are still carried over and unreviewed.
 *
 * fetchNaFlags answers [] on any failure, which is right for a flag whose
 * absence is harmless and wrong for this one: offline, an empty answer would
 * clear every carried-over badge on the screen and present last year's grades
 * as this year's reviewed findings. So when the request fails, the offline copy
 * is consulted before an empty list is believed.
 */
export async function fetchCarriedLines(recordId) {
  const db = getCurrentEnv().db;
  try {
    const r = await fetch(url(db, recordId, CARRIED), { credentials: 'include' });
    if (!r.ok) throw new Error(`Request failed (${r.status})`);
    const j = await r.json();
    return Array.isArray(j.keys) ? j.keys.map(String) : [];
  } catch {
    const pin = await getPinned(db, 'Inspections_New', recordId).catch(() => null);
    return Array.isArray(pin?.carried) ? pin.carried.map(String) : [];
  }
}
export const markCarriedLines = (recordId, lineIds) => setNaFlag(recordId, lineIds, true, CARRIED);
export const clearCarriedLine = (recordId, lineId) => setNaFlag(recordId, lineId, false, CARRIED);
