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
// Admin-only, and a real login — not the preview fallback identity, which is a
// shared credential and shouldn't be able to enumerate the estate.
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail } from './_admin.js';

const redis = Redis.fromEnv();

// Live auth material. Never backed up: restoring it is worthless (sessions are
// short-lived and re-mintable) and a copy sitting in Drive is a standing
// credential leak. Matched as prefixes against the scanned key list.
const EXCLUDED_PREFIXES = [
  { prefix: 'session:', why: 'live login sessions — credential material' },
  { prefix: 'oauth_state:', why: 'in-flight OAuth nonces, 10 min TTL' },
  { prefix: 'fallback_session', why: 'shared preview identity — credential material' },
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
  // Cursor-paged rather than KEYS: `na:flags:{db}:{recordId}` is one key PER
  // RECORD, so this list can run to thousands and KEYS would block the server.
  do {
    const [next, batch] = await redis.scan(cursor, { count: 500 });
    keys.push(...batch);
    cursor = String(next);
  } while (cursor !== '0');
  return keys;
}

// Size without transferring the payload. MEMORY USAGE is an estimate including
// Redis overhead — good enough to size a backup, and far cheaper than reading
// every hash just to measure it.
async function measure(key, type) {
  const out = { bytes: null, entries: null };
  try {
    if (type === 'hash') out.entries = await redis.hlen(key);
    else if (type === 'set') out.entries = await redis.scard(key);
    else if (type === 'list') out.entries = await redis.llen(key);
    else if (type === 'string') out.entries = 1;
  } catch { /* leave null — reported as unknown rather than guessed */ }
  try {
    const r = await redis.memory.usage(key);
    if (typeof r === 'number') out.bytes = r;
  } catch { /* MEMORY USAGE unsupported on this plan — bytes stay null */ }
  return out;
}

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session || session.isFallback) {
    return res.status(401).json({ error: 'Sign in with your own Google account first.' });
  }
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
      const { bytes, entries } = await measure(key, type);
      const fam = familyOf(key);
      const row = families.get(fam) || { family: fam, type, keys: 0, entries: 0, bytes: 0, bytesKnown: true, sample: key };
      row.keys++;
      if (entries != null) row.entries += entries;
      if (bytes == null) row.bytesKnown = false; else row.bytes += bytes;
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
      warnings.push('MEMORY USAGE is unavailable on this Redis plan, so byte sizes are partial. Entry counts are exact.');
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
      },
      families: rows,
      excluded: [...excluded.values()],
      warnings,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
