// Fills "Distance to High5" + "Drive Time" on trainings and CCS (RCD) records
// from the Google Maps Distance Matrix API — driving distance/time from the
// record's site (its contact's address) to High 5 HQ. EMPTY FIELDS ONLY:
// hand-entered values are never touched. Values are written in Google's text
// format ("102 mi", "1 hour 56 mins"), matching the data already in FMP.
//
// Resumable + time-bounded (cron-driven): each run scans records where the
// distance field is empty, resolves the contact's address, computes (with a
// Redis per-address cache so one site = one Google call ever), and writes.
// The same job is the backfill (loop it) and the keep-current mechanism.
//
// GET/POST /api/distance-sync?db=High5_Core4          run a slice
//          &layout=trainings|rcd                      optional: one layout only
//          &dry=1                                     compute but don't write
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { fmpToken, fmUpdate, fmFind, ALLOWED_DBS } from './_fmp.js';

export const config = { maxDuration: 300 };

const redis = Redis.fromEnv();
const SYNC_KEY = process.env.QBO_SYNC_KEY;
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const HQ = '130 Austine Dr # 170, Brattleboro, VT 05301';
const PAGE = 100;
const MAX_GOOGLE_CALLS_PER_RUN = 400; // cost guard; cache fills over runs

const TARGETS = {
  trainings: { layout: 'trainings_New', distField: 'Distance To High5', timeField: 'Drive Time', addrFallback: 'Location Address' },
  rcd:       { layout: 'RCD_New',       distField: 'Distance to High5', timeField: 'Drive Time' },
};

async function authorized(req) {
  if (SYNC_KEY && (req.headers['x-sync-key'] === SYNC_KEY || req.query?.key === SYNC_KEY)) return true;
  const cron = process.env.CRON_SECRET;
  if (cron && req.headers.authorization === `Bearer ${cron}`) return true;
  return !!(await getGoogleSession(req));
}

const normAddr = a => String(a || '').replace(/[\r\n]+/g, ', ').replace(/\s+/g, ' ').trim().toLowerCase();

// Distance Matrix lookup, cached forever per normalized address.
async function lookup(address, counters) {
  const key = normAddr(address);
  if (!key) return null;
  const cached = await redis.hget('dist:addrcache', key);
  if (cached) { counters.cacheHits++; return typeof cached === 'string' ? JSON.parse(cached) : cached; }
  if (counters.googleCalls >= MAX_GOOGLE_CALLS_PER_RUN) { counters.budgetSkips++; return null; }
  counters.googleCalls++;
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?units=imperial&origins=${encodeURIComponent(address)}&destinations=${encodeURIComponent(HQ)}&key=${MAPS_KEY}`;
  const j = await fetch(url).then(r => r.json()).catch(() => null);
  const el = j?.rows?.[0]?.elements?.[0];
  if (j?.status !== 'OK' || el?.status !== 'OK') {
    // Cache failures too (as null) so a bad address doesn't re-bill every run.
    await redis.hset('dist:addrcache', { [key]: JSON.stringify({ d: null, t: null, err: el?.status || j?.status || 'FAIL' }) });
    counters.lookupFails++;
    return null;
  }
  const out = { d: el.distance?.text || null, t: el.duration?.text || null };
  await redis.hset('dist:addrcache', { [key]: JSON.stringify(out) });
  return out;
}

// The record's site address, composed from the contact's address-portal
// components (Street/City/State/Zip — the display calcs come back empty via
// the Data API). Requires at least a city or zip to be routable.
function contactAddress(contact) {
  const rows = contact?.portalData?.cntct_ADDR || [];
  for (const r of rows) {
    const street = r['cntct_ADDR::Street'], city = r['cntct_ADDR::City'],
      state = r['cntct_ADDR::State'], zip = r['cntct_ADDR::Zip'];
    if (!String(city || '').trim() && !String(zip || '').trim()) continue;
    return [street, city, state, zip].map(s => String(s || '').trim()).filter(Boolean).join(', ');
  }
  return null;
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  if (!MAPS_KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not configured' });
  const db = req.query?.db || 'High5_Core4';
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });
  const dry = req.query?.dry === '1';
  const only = req.query?.layout;

  // Probe mode: one Google lookup for a given address, no FMP scanning.
  // GET ?probe=Brattleboro Union High School, Brattleboro VT
  if (req.query?.probe) {
    const counters = { googleCalls: 0, cacheHits: 0, lookupFails: 0, budgetSkips: 0 };
    const hit = await lookup(String(req.query.probe), counters);
    return res.status(200).json({ probe: req.query.probe, result: hit, ...counters });
  }

  const maxRecords = Math.max(1, Number(req.query?.max || 100000));
  const BUDGET_MS = 220000; // return well under Vercel's 300s kill
  const started = Date.now();
  const token = await fmpToken(db);

  const counters = { googleCalls: 0, cacheHits: 0, lookupFails: 0, budgetSkips: 0 };
  const out = {};
  const contactCache = new Map(); // contactId -> address (per run)

  for (const [key, cfg] of Object.entries(TARGETS)) {
    if (only && only !== key) continue;
    let updated = 0, noContact = 0, noAddress = 0, noRoute = 0, scanned = 0, remaining = null;
    let offset = 1;
    while (Date.now() - started < BUDGET_MS && scanned < maxRecords) {
      // records where the distance field is EMPTY (never touch filled ones)
      const r = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${encodeURIComponent(cfg.layout)}/_find`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: [{ [cfg.distField]: '=' }], limit: PAGE, offset, sort: [{ fieldName: 'zz__Created_On', sortOrder: 'descend' }] }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.messages?.[0]?.code === '401') { remaining = 0; break; }
      const rows = j?.response?.data || [];
      remaining = j?.response?.dataInfo?.foundCount ?? 0;
      if (!rows.length) break;

      for (const rec of rows) {
        if (Date.now() - started >= BUDGET_MS || scanned >= maxRecords) break;
        scanned++;
        const cid = rec.fieldData?._kft__Contact_ID;
        let addr = null;
        if (cid) {
          addr = contactCache.get(String(cid));
          if (addr === undefined) {
            // Redis-backed contact→address cache ("" = known addressless), so
            // re-scanning skip-heavy pages costs ~10ms/record, not an FMP find.
            const cached = await redis.hget('dist:contactaddr', String(cid));
            if (cached != null) {
              addr = cached === '' ? null : cached;
            } else {
              const c = (await fmFind(db, 'Contacts_New', [{ _kpt__Contact_ID: `==${cid}` }], token, 1))[0];
              addr = c ? contactAddress(c) : null;
              await redis.hset('dist:contactaddr', { [String(cid)]: addr || '' });
            }
            contactCache.set(String(cid), addr);
          }
        }
        // Fallback: the record's own location-address field (trainings).
        if (!addr && cfg.addrFallback) {
          const own = String(rec.fieldData?.[cfg.addrFallback] || '').trim();
          if (own.length > 8) addr = own;
        }
        if (!addr) { if (!cid) noContact++; else noAddress++; offset++; continue; }
        const hit = await lookup(addr, counters);
        if (!hit || !hit.d) { noRoute++; offset++; continue; }
        if (!dry) {
          const fieldData = { [cfg.distField]: hit.d };
          if (!String(rec.fieldData?.[cfg.timeField] || '').trim()) fieldData[cfg.timeField] = hit.t || '';
          await fmUpdate(db, cfg.layout, rec.recordId, fieldData, token);
        }
        updated++;
        // updated records leave the empty-set, so the find re-pages naturally;
        // only skipped records need the offset to advance past them.
      }
    }
    out[key] = { updated, scanned, noContact, noAddress, noRoute, remainingEmpty: remaining };
  }

  return res.status(200).json({ db, dry, ...counters, targets: out });
}
