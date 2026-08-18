// Driving distance and time from a contact's address to High 5 HQ.
//
//   GET /api/contact-distance?db=High5_Core4&id=74692  → { distance, driveTime, cached }
//
// WHY THIS EXISTS RATHER THAN A FIELD. Contacts_New carries a `drive_time`
// field, but it is empty on every record sampled (0 of 400), and there is no
// distance field at all. The real values live per-PROJECT on CCS and trainings,
// written by api/distance-sync.js from the site address.
//
// So an organization's figures are derived the same way its projects' are, from
// the same Google Distance Matrix call and — crucially — the same
// `dist:addrcache` hash that job fills. Any site High 5 has already driven to
// for a project is already in that cache, so this is normally a Redis read with
// no Google call and no new stored field to keep in step with the address.
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { K } from './_contacts.js';

const redis = Redis.fromEnv();
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
const HQ = '130 Austine Dr # 170, Brattleboro, VT 05301';

// Identical to distance-sync.js, deliberately: the two must resolve to the same
// cache key or a site already looked up there would be billed again here.
const normAddr = a => String(a || '').replace(/[\r\n]+/g, ', ').replace(/\s+/g, ' ').trim().toLowerCase();
const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

// The address to route from. Prefers a Main address, then Billing, then
// whatever the contact has — matching how someone would actually drive there.
const TYPE_ORDER = ['Main', 'Course', 'Billing', 'Mailing', 'Work'];

function pickAddress(entity) {
  const rows = (entity?.addresses || []).filter(a =>
    [a.street, a.city, a.state, a.zip].some(v => String(v || '').trim()));
  if (!rows.length) return null;
  for (const t of TYPE_ORDER) {
    const hit = rows.find(r => String(r.type || '').toLowerCase() === t.toLowerCase());
    if (hit) return hit;
  }
  return rows[0];
}

const asLine = a => [a.street, a.city, a.state, a.zip].map(v => String(v || '').trim()).filter(Boolean).join(', ');

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });
  const id = String(req.query?.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    const raw = (await redis.hget(K.org(db), id)) ?? (await redis.hget(K.person(db), id));
    const entity = parse(raw);
    if (!entity) return res.status(404).json({ error: 'no such contact' });

    const addr = pickAddress(entity);
    if (!addr) return res.status(200).json({ distance: null, driveTime: null, reason: 'no address' });

    const line = asLine(addr);
    const key = normAddr(line);
    const cached = parse(await redis.hget('dist:addrcache', key));
    if (cached) {
      return res.status(200).json({ distance: cached.d ?? null, driveTime: cached.t ?? null, address: line, cached: true });
    }

    if (!MAPS_KEY) return res.status(200).json({ distance: null, driveTime: null, address: line, reason: 'no maps key' });

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?units=imperial`
      + `&origins=${encodeURIComponent(line)}&destinations=${encodeURIComponent(HQ)}&key=${MAPS_KEY}`;
    const j = await fetch(url).then(r => r.json()).catch(() => null);
    const el = j?.rows?.[0]?.elements?.[0];
    if (j?.status !== 'OK' || el?.status !== 'OK') {
      // Cache the failure too, so a bad address is not re-billed on every open.
      await redis.hset('dist:addrcache', { [key]: JSON.stringify({ d: null, t: null, err: el?.status || j?.status || 'FAIL' }) });
      return res.status(200).json({ distance: null, driveTime: null, address: line, reason: 'lookup failed' });
    }
    const out = { d: el.distance?.text || null, t: el.duration?.text || null };
    await redis.hset('dist:addrcache', { [key]: JSON.stringify(out) });
    return res.status(200).json({ distance: out.d, driveTime: out.t, address: line, cached: false });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
