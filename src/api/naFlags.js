import { getCurrentEnv } from '../config/fmpEnvironments';

// Client for the per-record N/A-flag set (see api/na-flags.js).
// Note: /api/* doesn't run on localhost (Vite only proxies /fmi), so these
// degrade to a no-op there.

export async function fetchNaFlags(recordId) {
  const db = getCurrentEnv().db;
  try {
    const r = await fetch(`/api/na-flags?db=${encodeURIComponent(db)}&recordId=${encodeURIComponent(recordId)}`, { credentials: 'include' });
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    return Array.isArray(j.keys) ? j.keys.map(String) : [];
  } catch { return []; }
}

export async function setNaFlag(recordId, key, on) {
  const db = getCurrentEnv().db;
  const r = await fetch(`/api/na-flags?db=${encodeURIComponent(db)}&recordId=${encodeURIComponent(recordId)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: String(key), on }),
  });
  if (!r.ok) throw new Error('Could not update N/A flag');
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j.keys) ? j.keys.map(String) : [];
}
