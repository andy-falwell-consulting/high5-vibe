// Per-record "N/A" flags for CCS phase-checklist items. Not every project needs
// every checklist item (e.g. an item that only applies to certain project
// types) — marking an item N/A lets it count toward phase completion without
// forcing a real checkbox that doesn't apply. Lives in Redis, not FMP (no
// schema change), one set per CCS record so a fetch stays small regardless of
// how many records exist total.
//
//   GET  /api/na-flags?db=High5_Core4&recordId=16688            → { keys: [...] }
//   POST /api/na-flags?db=High5_Core4&recordId=16688 { key, on } → toggle
// `key` is an opaque per-item id (phaseId::itemKey) — the client owns its shape.
//
// An optional `ns` picks the flag set, so unrelated features can share this
// endpoint (and its serverless function) instead of each adding their own:
//   ns=na       (default) CCS phase-checklist N/A flags
//   ns=carried  inspection line items copied from a prior year, not yet reviewed
// Namespaces are isolated by Redis key, so they can never collide.
//
// Auth: a Google session (same as the rest of the app), or x-sync-key for
// scripts/debugging (matches kanban-board.js / distance-sync.js).
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';

const redis = Redis.fromEnv();
const SYNC_KEY = process.env.QBO_SYNC_KEY;
const NAMESPACES = new Set(['na', 'carried']);
const keyFor = (db, recordId, ns) => `${ns === 'na' ? 'na' : ns}:flags:${db}:${recordId}`;
const asList = v => (Array.isArray(v) ? v.map(String) : []);

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });
  const recordId = String(req.query?.recordId || '').trim();
  if (!recordId) return res.status(400).json({ error: 'recordId required' });
  const ns = String(req.query?.ns || 'na').trim() || 'na';
  if (!NAMESPACES.has(ns)) return res.status(400).json({ error: 'ns not allowed' });
  const key = keyFor(db, recordId, ns);

  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      // `key` accepts a single id or an array — copying an inspection flags
      // dozens of lines at once, which would otherwise be dozens of requests.
      const itemKeys = (Array.isArray(body.key) ? body.key : [body.key])
        .map(k => String(k ?? '').trim()).filter(Boolean);
      if (!itemKeys.length) return res.status(400).json({ error: 'key required' });
      if (body.on === false) await redis.srem(key, ...itemKeys);
      else await redis.sadd(key, ...itemKeys);
    } else if (req.method !== 'GET') {
      return res.status(405).json({ error: 'method not allowed' });
    }
    return res.status(200).json({ keys: asList(await redis.smembers(key)) });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
