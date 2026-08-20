// Client for the Vibe-only "Operations Lead" field (see api/ops-lead.js).
// Not a FileMaker field — it lives in Redis, so none of the filemaker.js cache
// machinery applies here.

// First-render fallback only. The roster returned by the API is authoritative;
// this exists so a dropdown is never briefly empty, exactly as useValueLists
// seeds FileMaker value lists.
export const OPS_LEAD_FALLBACK = ['Ian', 'Krister', 'Jamie', 'Todd', 'Kyle'];

// `kind` namespaces the assignments — 'ccs' or 'trainings'. Both identify
// records by FileMaker recordId, and those are only unique within a table, so
// sharing one namespace would show one record's lead on another's card.
// Defaults to 'ccs' so every existing call site is unchanged.
const q = (db, kind) =>
  `db=${encodeURIComponent(db)}${kind && kind !== 'ccs' ? `&kind=${encodeURIComponent(kind)}` : ''}`;

/** Every assignment for an environment, in one request. → { leads, roster } */
export async function fetchOpsLeads(db, kind) {
  const r = await fetch(`/api/ops-lead?${q(db, kind)}`, { credentials: 'include' });
  if (!r.ok) throw new Error(`ops-lead ${r.status}`);
  return r.json();
}

/** Set one record's lead. Pass '' to clear it. */
export async function setOpsLead(db, recordId, name, kind) {
  const r = await fetch(`/api/ops-lead?${q(db, kind)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recordId: String(recordId), name }),
  });
  if (!r.ok) throw new Error(`ops-lead ${r.status}`);
  return r.json();
}

/**
 * Assign the lead from the caller's own session — used right after a CCS
 * project is created in Vibe. The server resolves the name and applies the
 * roster rule (no match → left blank), and will not overwrite an existing
 * assignment. Returns `{ name }`, which is '' when the creator isn't on the
 * roster.
 */
export async function autoAssignOpsLead(db, recordId, kind) {
  const r = await fetch(`/api/ops-lead?${q(db, kind)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recordId: String(recordId), auto: true }),
  });
  if (!r.ok) throw new Error(`ops-lead ${r.status}`);
  return r.json();
}
