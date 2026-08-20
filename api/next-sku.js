// Issues the next product SKU from VIBE'S OWN counter.
//
// This used to POST to a Tray workflow that owned the counter
// (TRAY_SKU_WEBHOOK_URL). That was the last Tray dependency in the app, and it
// meant Vibe could not create a product if Tray was down, while a number
// governing a business key lived somewhere nobody at High 5 could inspect. The
// counter is now Redis, alongside nextRecordId and the Program Code counter —
// see api/_sku.js for the range and why it starts where it does.
//
// FileMaker Pro's own script trigger STILL draws from Tray until cutover. That
// is deliberate and safe: the two counters are given ranges that cannot meet.
//
//   POST /api/next-sku?db=High5_Core4   -> { sku: "3001" }
//   GET  /api/next-sku?db=High5_Core4   -> { seeded, current, next, floor }
//
// GET consumes nothing, so the Admin panel can show the counter without
// burning a number.
//
// Auth gate (mirrors qbo.js): a logged-in user (Google session cookie) OR a
// server job presenting the sync key (x-sync-key header / ?key=).
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { nextSku, peekSku } from './_sku.js';

const SYNC_KEY = process.env.QBO_SYNC_KEY;

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  return !!(await getGoogleSession(req));
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  try {
    if (req.method === 'GET') return res.status(200).json(await peekSku(db));
    return res.status(200).json({ sku: await nextSku(db) });
  } catch (e) {
    return res.status(502).json({ error: 'could not issue a SKU', detail: String(e?.message || e).slice(0, 300) });
  }
}
