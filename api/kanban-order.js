// Manual card order within each Kanban column — shared across the team
// (Redis), so if Ian drags a card to the top of a lane, everyone sees that
// same order. One ordered list per column; cards not yet in a column's
// stored order (new to the board, or never manually placed) fall back to the
// existing default order (created-date descending) at render time.
//
//   GET  /api/kanban-order?db=High5_Core4                          → { orders: { [columnId]: [recordId,...] } }
//   POST /api/kanban-order?db=High5_Core4&columnId=Proposed { order: [...] } → overwrite that column, returns { orders }
// Auth: a Google session (same as the rest of the app), or x-sync-key.
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';

const redis = Redis.fromEnv();
const SYNC_KEY = process.env.QBO_SYNC_KEY;
// Mirrors ACTIVE_STAGES in src/config/ccsStatus.js — the active/in-flight CCS
// statuses that are Kanban board columns.
//
// Still duplicated rather than imported, and now for a concrete reason: modules
// under src/ use extensionless relative imports (ccsStatus.js does
// `from './brandColors'`), which Vite resolves at build time but Node's ESM
// loader will not. Importing it here would break this function at runtime.
//
// KEEP IN SYNC WITH src/config/ccsStatus.js. This list silently drifted once,
// at the v1.0.256 status rename: it kept the retired vocabulary while the board
// moved on, so POSTing an order for three of the six lanes 404'd on the name
// check and every save of a card's position in those lanes was rejected (the
// client swallows the error). Reordering appeared to work and was gone on
// reload. If you rename a stage, change it in BOTH files and add the old name
// to LEGACY_COLUMNS below.
const ACTIVE_STAGES = [
  'Inquiry', 'In Process', 'Approved', 'Proposed Dates, Sent Contract & DI',
  'Confirmed/ Job Prep by Date', 'Confirmed/ Ready to go',
];

// Orders saved under a stage's PREVIOUS name, read as a fallback so the rename
// doesn't throw away ordering the team already set (production still holds 11
// records under the retired 'Proposed' key). Read-only and non-destructive: the
// legacy list is used only while the current key is empty, and the first
// reorder of that lane writes the new key, which then wins. Two stages merged
// into one in v1.0.256, so a stage can have more than one predecessor.
const LEGACY_COLUMNS = {
  'Proposed Dates, Sent Contract & DI': ['Proposed', 'Sent Contract & DI'],
  'Confirmed/ Job Prep by Date': ['Confirmed/Scheduled'],
};
const keyFor = (db, columnId) => `kanban:order:${db}:${columnId}`;
const asList = v => (Array.isArray(v) ? v.map(String) : []);

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}

async function orderFor(db, col) {
  const current = asList(await redis.lrange(keyFor(db, col), 0, -1));
  if (current.length) return current;
  // Nothing under the current name — fall back to the stage's previous name(s).
  const merged = [];
  for (const legacy of LEGACY_COLUMNS[col] || []) {
    for (const id of asList(await redis.lrange(keyFor(db, legacy), 0, -1))) {
      if (!merged.includes(id)) merged.push(id);
    }
  }
  return merged;
}

async function allOrders(db) {
  const entries = await Promise.all(ACTIVE_STAGES.map(async col => [col, await orderFor(db, col)]));
  return Object.fromEntries(entries);
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  try {
    if (req.method === 'POST') {
      const columnId = String(req.query?.columnId || '');
      if (!ACTIVE_STAGES.includes(columnId)) return res.status(400).json({ error: 'columnId not recognized' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const order = asList(body.order);
      const key = keyFor(db, columnId);
      await redis.del(key);
      if (order.length) await redis.rpush(key, ...order);
    } else if (req.method !== 'GET') {
      return res.status(405).json({ error: 'method not allowed' });
    }
    return res.status(200).json({ orders: await allOrders(db) });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
