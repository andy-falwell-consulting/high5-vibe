import { getCurrentEnv } from '../config/fmpEnvironments';

// Writes for layouts Vibe owns (see api/_vibeStore.js VIBE_OWNED).
//
// Deliberately a separate function from updateRecord rather than routing inside
// it: at a glance you can see which call sites still write to FileMaker and
// which don't, and there is no hidden branch to get wrong while layouts move
// across one phase at a time.
//
// Needs only the Google session — no per-user FileMaker account, so this cannot
// fail the way FileMaker writes did for an identity with no account in the
// current environment.
export async function updateVibeRecord(layout, recordId, fieldData) {
  const db = getCurrentEnv().db;
  const res = await fetch(`/api/vibe-record?db=${encodeURIComponent(db)}&layout=${encodeURIComponent(layout)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recordId: String(recordId), fieldData }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Save failed (${res.status})`);
  return body;
}

// Create a record that lives only in Vibe. Returns the minted `V-` record id,
// which is also the value written to the table's own primary key — so a caller
// needs no read-back to discover it, unlike a FileMaker create.
export async function createVibeRecord(layout, fieldData) {
  const db = getCurrentEnv().db;
  const res = await fetch(`/api/vibe-record?db=${encodeURIComponent(db)}&layout=${encodeURIComponent(layout)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ create: true, fieldData }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Create failed (${res.status})`);
  return body;
}
