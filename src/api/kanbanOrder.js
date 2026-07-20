import { getCurrentEnv } from '../config/fmpEnvironments';

// Client for the shared per-column card order (see api/kanban-order.js).
// Note: /api/* doesn't run on localhost (Vite only proxies /fmi), so these
// degrade to a no-op there.

export async function fetchKanbanOrders() {
  const db = getCurrentEnv().db;
  try {
    const r = await fetch(`/api/kanban-order?db=${encodeURIComponent(db)}`, { credentials: 'include' });
    if (!r.ok) return {};
    const j = await r.json().catch(() => ({}));
    return j.orders || {};
  } catch { return {}; }
}

// Overwrite one column's order; returns the full { [columnId]: [recordId,...] } map.
export async function setColumnOrder(columnId, order) {
  const db = getCurrentEnv().db;
  const r = await fetch(`/api/kanban-order?db=${encodeURIComponent(db)}&columnId=${encodeURIComponent(columnId)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  });
  if (!r.ok) throw new Error('Could not save card order');
  const j = await r.json().catch(() => ({}));
  return j.orders || {};
}
