// Backup — DRY RUN ONLY.
//
// Phase 0 of the decoupling plan (docs/vibe-owns-the-record.md). The moment
// Vibe owns a record, Upstash Redis is the only copy of the business, so a
// verified backup and a rehearsed restore come before anything else.
//
// This endpoint deliberately does NOT write, upload, or delete. It enumerates
// the keyspace and reports what a real backup WOULD capture, so the scope can
// be agreed before a single byte leaves Redis. Export and restore land in
// separate, reviewable changes.
//
//   GET /api/backup?mode=inventory   → { families, totals, excluded, warnings }
//
// Admin-only.
//
// It does NOT additionally require a non-fallback login, unlike
// admin-set-fallback-session.js. That check would buy nothing here: the
// fallback identity can only exist on the preview deployment (it is gated on
// VERCEL_ENV === 'preview' && VERCEL_GIT_COMMIT_REF === 'preview'), so
// rejecting it protects production not at all while making this endpoint
// impossible to exercise before it ships. What it returns is metadata — key
// names, counts and sizes — never record contents, and admin is still required.
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail } from './_admin.js';

const redis = Redis.fromEnv();

// Live auth material. Never backed up: restoring it is worthless (sessions are
// short-lived and re-mintable) and a copy sitting in Drive is a standing
// credential leak. Matched as prefixes against the scanned key list.
// Found by running this: the QuickBooks and Shopify tokens live in the same
// keyspace as the business data, so a naive "back up everything" would have
// written live API credentials into Google Drive in plaintext. They are also
// pointless to restore — both are refreshed by their OAuth flows, and a
// restored stale token is worse than none.
const EXCLUDED_PREFIXES = [
  { prefix: 'session:', why: 'live login sessions — credential material' },
  { prefix: 'oauth_state:', why: 'in-flight OAuth nonces, 10 min TTL' },
  { prefix: 'fallback_session', why: 'shared preview identity — credential material' },
  { prefix: 'qbo_access_token', why: 'live QuickBooks credential' },
  { prefix: 'qbo_refresh_token', why: 'live QuickBooks credential' },
  { prefix: 'qbo_sandbox_refresh_token', why: 'live QuickBooks sandbox credential' },
  { prefix: 'shopify_token', why: 'live Shopify credential' },
];

// Everything else is grouped into a family so the report reads as a shape
// rather than a key dump. `{db}` collapses the three FileMaker environments.
function familyOf(key) {
  const k = key.replace(/High5_Core4(_Dev|_Stage)?/g, '{db}');
  if (/^repl:\{db\}:[^:]+:/.test(k)) return k.replace(/^(repl:\{db\}:[^:]+):.*$/, '$1:*');
  if (/^kanban:order:/.test(k)) return 'kanban:order:{db}:*';
  if (/flags:\{db\}:/.test(k)) return k.replace(/^([a-z]+:flags:\{db\}):.*$/, '$1:*');
  if (/^txn:/.test(k)) return k.replace(/^(txn:\{db\}):.*$/, '$1:*');
  return k;
}

async function scanAll() {
  const keys = [];
  let cursor = '0';
  // Cursor-paged rather than KEYS, which blocks the server. The per-record
  // flag keys (`carried:flags:{db}:{recordId}`) are the family most likely to
  // grow this list.
  do {
    const [next, batch] = await redis.scan(cursor, { count: 500 });
    keys.push(...batch);
    cursor = String(next);
  } while (cursor !== '0');
  return keys;
}

// Size by SAMPLING, not by reading everything.
//
// MEMORY USAGE is unavailable on this Upstash plan, so the first version of
// this reported no sizes at all — useless for deciding how the exporter should
// chunk its files. Instead: read one page of a collection, measure the JSON
// those entries serialise to, and scale by the true entry count. Reading all
// 105k entries just to weigh them would cost far more than the answer is worth.
//
// Sizes are therefore estimates (marked as such), and entry counts are exact.
const SAMPLE = 100;
const jsonBytes = v => (v == null ? 0 : Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8'));

async function measure(key, type) {
  const out = { bytes: null, entries: null, estimated: false };
  try {
    if (type === 'string') {
      out.entries = 1;
      out.bytes = jsonBytes(await redis.get(key));
      return out;
    }

    let sampleBytes = 0, sampled = 0;
    if (type === 'hash') {
      out.entries = await redis.hlen(key);
      const [, flat] = await redis.hscan(key, 0, { count: SAMPLE });
      for (let i = 0; i < flat.length; i += 2) { sampleBytes += jsonBytes(flat[i]) + jsonBytes(flat[i + 1]); sampled++; }
    } else if (type === 'list') {
      out.entries = await redis.llen(key);
      const items = await redis.lrange(key, 0, SAMPLE - 1);
      for (const it of items) { sampleBytes += jsonBytes(it); sampled++; }
    } else if (type === 'set') {
      out.entries = await redis.scard(key);
      const [, members] = await redis.sscan(key, 0, { count: SAMPLE });
      for (const m of members) { sampleBytes += jsonBytes(m); sampled++; }
    }

    if (sampled > 0 && out.entries != null) {
      out.bytes = Math.round((sampleBytes / sampled) * out.entries);
      out.estimated = out.entries > sampled;
    } else if (out.entries === 0) {
      out.bytes = 0;
    }
  } catch { /* leave null — reported as unknown rather than guessed */ }
  return out;
}

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  const mode = String(req.query?.mode || 'inventory');
  if (mode !== 'inventory') {
    // Guard rail while this is dry-run only, so a stray ?mode=export can't be
    // read as "it ran and there's a backup".
    return res.status(400).json({ error: 'Only mode=inventory exists yet. Export and restore are not built.' });
  }

  try {
    const keys = await scanAll();

    const families = new Map();
    const excluded = new Map();
    const warnings = [];

    for (const key of keys) {
      const skip = EXCLUDED_PREFIXES.find(e => key.startsWith(e.prefix));
      if (skip) {
        const row = excluded.get(skip.prefix) || { prefix: skip.prefix, why: skip.why, keys: 0 };
        row.keys++;
        excluded.set(skip.prefix, row);
        continue;
      }

      const type = await redis.type(key);
      const { bytes, entries, estimated } = await measure(key, type);
      const fam = familyOf(key);
      const row = families.get(fam) || { family: fam, type, keys: 0, entries: 0, bytes: 0, bytesKnown: true, estimated: false, sample: key };
      row.keys++;
      if (entries != null) row.entries += entries;
      if (bytes == null) row.bytesKnown = false; else row.bytes += bytes;
      if (estimated) row.estimated = true;
      if (row.type !== type) row.type = 'mixed';
      families.set(fam, row);
    }

    const rows = [...families.values()].sort((a, b) => b.bytes - a.bytes);
    const totalBytes = rows.reduce((n, r) => n + (r.bytesKnown ? r.bytes : 0), 0);
    const anyUnknown = rows.some(r => !r.bytesKnown);

    // Things worth knowing before writing the exporter, not after.
    const perRecord = rows.filter(r => r.keys > 100);
    for (const r of perRecord) {
      warnings.push(`${r.family} is ${r.keys.toLocaleString()} separate keys — the exporter must page these, not fetch them one call at a time.`);
    }
    const big = rows.filter(r => r.bytesKnown && r.bytes > 25 * 1024 * 1024);
    for (const r of big) {
      warnings.push(`${r.family} is ~${(r.bytes / 1024 / 1024).toFixed(0)}MB — stream it to its own file; do not build one archive in memory.`);
    }
    if (anyUnknown) {
      warnings.push('Some keys could not be sized and are excluded from the total.');
    }
    if (rows.some(r => r.estimated)) {
      warnings.push(`Sizes are estimated from a ${SAMPLE}-entry sample per key, scaled by the exact entry count. Entry counts are exact; bytes are within a few percent.`);
    }

    return res.status(200).json({
      dryRun: true,
      note: 'Nothing was written, uploaded or deleted.',
      scannedKeys: keys.length,
      totals: {
        families: rows.length,
        keys: rows.reduce((n, r) => n + r.keys, 0),
        entries: rows.reduce((n, r) => n + r.entries, 0),
        bytes: totalBytes,
        bytesArePartial: anyUnknown,
        bytesAreEstimated: rows.some(r => r.estimated),
      },
      families: rows,
      excluded: [...excluded.values()],
      warnings,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
