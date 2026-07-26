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
// statuses that are Kanban board columns. Duplicated rather than imported:
// no api/*.js file imports from src/ anywhere else in this codebase, and this
// list changes rarely enough that keeping both in sync by hand is fine.
const ACTIVE_STAGES = ['Inquiry', 'In Process', 'Proposed', 'Approved', 'Sent Contract & DI', 'Confirmed/Scheduled'];
const keyFor = (db, columnId) => `kanban:order:${db}:${columnId}`;
const asList = v => (Array.isArray(v) ? v.map(String) : []);

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}

async function allOrders(db) {
  const entries = await Promise.all(ACTIVE_STAGES.map(async col => [col, asList(await redis.lrange(keyFor(db, col), 0, -1))]));
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
