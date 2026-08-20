import { getCurrentEnv } from '../config/fmpEnvironments';

// Client for the shared Trainings Kanban board-membership set (see
// api/trainings-kanban-board.js). Mirrors src/api/kanbanBoard.js for CCS.
// Note: /api/* doesn't run on localhost (Vite only proxies /fmi), so these
// degrade to a no-op there — the board simply shows empty in local dev.

export async function fetchBoardIds() {
  const db = getCurrentEnv().db;
  try {
    const r = await fetch(`/api/trainings-kanban-board?db=${encodeURIComponent(db)}`, { credentials: 'include' });
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    return Array.isArray(j.ids) ? j.ids.map(String) : [];
  } catch { return []; }
}

// Add (on=true) or remove (on=false) a recordId; returns the updated id list.
export async function setBoardMembership(id, on) {
  const db = getCurrentEnv().db;
  const r = await fetch(`/api/trainings-kanban-board?db=${encodeURIComponent(db)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: String(id), on }),
  });
  if (!r.ok) throw new Error('Could not update the board');
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j.ids) ? j.ids.map(String) : [];
}

/** Put many trainings on the board at once.
 *
 *  Adds only — existing cards are untouched and nothing is removed, so running
 *  it twice is harmless and it can never clear a curated board. Returns
 *  `{ seeded, alreadyOnBoard, ids }` so the caller can say what actually
 *  changed rather than claiming a number it did not verify.
 */
export async function seedBoard(ids) {
  const db = getCurrentEnv().db;
  const r = await fetch(`/api/trainings-kanban-board?db=${encodeURIComponent(db)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seedIds: ids }),
  });
  if (!r.ok) throw new Error(`trainings-kanban-board ${r.status}`);
  return r.json();
}
