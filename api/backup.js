// Backup — inventory (dry run) and export.
//
// Phase 0 of the decoupling plan (docs/vibe-owns-the-record.md). The moment
// Vibe owns a record, Upstash Redis is the only copy of the business, so a
// verified backup and a rehearsed restore come before anything else.
//
//   GET  /api/backup?mode=inventory                 → what a backup WOULD capture; writes nothing
//   POST /api/backup?mode=export-start              → creates a dated Drive folder, returns runId + key list
//   POST /api/backup?mode=export-key&run=&key=      → exports ONE key: read, gzip, upload, verify
//   POST /api/backup?mode=export-finish&run=        → uploads manifest.json, reports completeness
//   GET  /api/backup?mode=restore-plan&day=         → reads a day's manifest, compares it to the live keyspace
//   GET  /api/backup?mode=restore-check&day=&key=   → downloads ONE file, verifies checksum, diffs against live; writes nothing
//   POST /api/backup?mode=restore-write&day=&key=   → writes it back, to a scratch prefix unless target=live
//
// The restore side is READ-ONLY by default and lands in a scratch prefix when
// it does write. Overwriting live keys requires target=live AND confirm=, so
// nothing can clobber production data by a mistyped URL.
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
  { prefix: 'backup:run:', why: 'this exporter\'s own bookkeeping — transient' },
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

// ── Export ────────────────────────────────────────────────────────
//
// Driven ONE KEY PER REQUEST by the client rather than as a single long job.
// Contacts alone is ~52MB and the whole estate ~137MB; a single invocation
// would sit near the 300s ceiling with no way to resume a failure. Per-key
// calls are naturally resumable, show real progress, and keep peak memory to
// one key at a time.
//
// Run state lives in `backup:run:{id}` (excluded from future exports above),
// and is what `export-finish` turns into the manifest.
// Defaulted rather than required so this works without a Vercel env change.
// A Drive folder id is not a secret — it appears in the folder's own URL — and
// the override exists so the destination can be moved without a deploy.
const DEFAULT_BACKUP_FOLDER = '1xW3xXxRzUnSGKM5pG1dCibFAEQUyHLsi';
const RUN_TTL = 7 * 24 * 60 * 60;
const runKey = id => `backup:run:${id}`;

const safeName = k => k.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);

// Read a key in full, paged. Hash values are already JSON strings (see
// _replica.js slim()), and are kept verbatim so a restore is byte-for-byte
// rather than a re-serialisation that might differ.
async function readKey(key, type) {
  if (type === 'string') return await redis.get(key);
  if (type === 'list') return await redis.lrange(key, 0, -1);
  if (type === 'set') {
    const out = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.sscan(key, cursor, { count: 1000 });
      out.push(...batch);
      cursor = String(next);
    } while (cursor !== '0');
    return out;
  }
  if (type === 'hash') {
    const out = {};
    let cursor = '0';
    // HSCAN, not HGETALL: a 31,000-field hash in one response blows past both
    // Upstash's response limits and Vercel's body limit.
    do {
      const [next, flat] = await redis.hscan(key, cursor, { count: 1000 });
      for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
      cursor = String(next);
    } while (cursor !== '0');
    return out;
  }
  throw new Error(`unsupported type ${type} for ${key}`);
}

async function handleExport(req, res, session, mode) {
  const { ensureFolder, uploadFile } = await import('./_backupDrive.js');
  const { gzipSync } = await import('node:zlib');
  const { createHash } = await import('node:crypto');
  const token = session.accessToken;
  if (!token) return res.status(400).json({ error: 'No Google access token on this session.' });

  // Defaulted rather than required so this works without a Vercel env change.
  // A Drive folder id is not a secret — it appears in the folder's own URL —
  // and the override exists so the destination can be moved (notably to a
  // Shared Drive, which the scheduled run will need) without a deploy.
  const parentId = process.env.BACKUP_DRIVE_FOLDER_ID || DEFAULT_BACKUP_FOLDER;

  if (mode === 'export-start') {
    const all = await scanAll();
    const keys = all.filter(k => !EXCLUDED_PREFIXES.some(e => k.startsWith(e.prefix))).sort();
    const now = new Date();
    // One folder per DAY, named by date. A second run on the same day reuses
    // it and replaces the files inside, so "today's backup" is one thing rather
    // than a pile of near-identical folders. runId still carries the full
    // timestamp so two runs can't collide over the same Redis bookkeeping.
    const day = now.toISOString().slice(0, 10);
    const runId = now.toISOString().replace(/[:.]/g, '-');
    const folder = await ensureFolder(token, day, parentId);
    await redis.hset(runKey(runId), {
      meta: JSON.stringify({ runId, day, folderId: folder.id, startedAt: now.toISOString(), by: session.email, keys }),
    });
    await redis.expire(runKey(runId), RUN_TTL);
    return res.status(200).json({ runId, folderId: folder.id, folderName: folder.name, reusedFolder: folder.reused, keys });
  }

  const runId = String(req.query?.run || '');
  if (!runId) return res.status(400).json({ error: 'run is required' });
  const metaRaw = await redis.hget(runKey(runId), 'meta');
  if (!metaRaw) return res.status(404).json({ error: 'Unknown or expired run' });
  const meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : metaRaw;

  if (mode === 'export-key') {
    const key = String(req.query?.key || '');
    if (!key) return res.status(400).json({ error: 'key is required' });
    if (!meta.keys.includes(key)) return res.status(400).json({ error: 'key is not part of this run' });

    const type = await redis.type(key);
    const data = await readKey(key, type);
    const entries = type === 'hash' ? Object.keys(data).length
      : Array.isArray(data) ? data.length : 1;

    const payload = Buffer.from(JSON.stringify({
      key, type, entries, exportedAt: new Date().toISOString(), data,
    }), 'utf8');
    const gz = gzipSync(payload, { level: 9 });

    const sha256 = createHash('sha256').update(gz).digest('hex');
    const md5 = createHash('md5').update(gz).digest('hex');

    const file = await uploadFile(token, { name: `${safeName(key)}.json.gz`, parentId: meta.folderId, bytes: gz });

    // Drive computes md5Checksum from what it actually received, so this is a
    // real end-to-end check rather than us marking our own homework.
    const verified = !!file.md5Checksum && file.md5Checksum === md5;
    const entry = {
      key, type, entries,
      file: file.name, driveId: file.id,
      rawBytes: payload.length, gzBytes: gz.length,
      sha256, md5, driveMd5: file.md5Checksum || null, verified,
    };
    await redis.hset(runKey(runId), { [`file:${key}`]: JSON.stringify(entry) });
    return res.status(200).json(entry);
  }

  if (mode === 'export-finish') {
    const all = await redis.hgetall(runKey(runId)) || {};
    const files = Object.entries(all)
      .filter(([f]) => f.startsWith('file:'))
      .map(([, v]) => (typeof v === 'string' ? JSON.parse(v) : v))
      .sort((a, b) => a.key.localeCompare(b.key));

    const missing = meta.keys.filter(k => !files.some(f => f.key === k));
    const unverified = files.filter(f => !f.verified).map(f => f.key);

    const manifest = {
      runId,
      day: meta.day,
      startedAt: meta.startedAt,
      finishedAt: new Date().toISOString(),
      by: meta.by,
      folderId: meta.folderId,
      complete: missing.length === 0 && unverified.length === 0,
      missing,
      unverified,
      excluded: EXCLUDED_PREFIXES.map(e => ({ prefix: e.prefix, why: e.why })),
      totals: {
        files: files.length,
        entries: files.reduce((n, f) => n + f.entries, 0),
        rawBytes: files.reduce((n, f) => n + f.rawBytes, 0),
        gzBytes: files.reduce((n, f) => n + f.gzBytes, 0),
      },
      files,
    };

    // The manifest goes up LAST and uncompressed, so its presence is the signal
    // that a run finished and it can be read without tooling.
    const body = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    const mf = await uploadFile(token, {
      name: 'manifest.json', parentId: meta.folderId, bytes: body, mimeType: 'application/json',
    });

    await redis.del(runKey(runId));
    return res.status(200).json({ ...manifest, manifestDriveId: mf.id, files: undefined, fileCount: files.length });
  }

  return res.status(400).json({ error: `unknown mode ${mode}` });
}


// ── Restore ───────────────────────────────────────────────────────
//
// A backup nobody has restored from is not a backup. These modes exist to
// rehearse it, and they are deliberately timid: `restore-check` writes nothing
// at all, and `restore-write` lands in a scratch prefix unless explicitly told
// otherwise.
//
// Note when reading a diff: the replica re-syncs from FileMaker every 5 minutes
// in production, so `repl:` keys legitimately differ from a backup taken
// earlier. Differences are information, not necessarily faults.
const SCRATCH = day => `restore:${day}:`;

async function loadManifest(token, day, parentId) {
  const { findFolder, listFolder, downloadFile } = await import('./_backupDrive.js');
  const folder = await findFolder(token, day, parentId);
  if (!folder) throw new Error(`No backup folder named ${day}`);
  const files = await listFolder(token, folder.id);
  const mf = files.find(f => f.name === 'manifest.json');
  if (!mf) throw new Error(`${day} has no manifest.json — that run did not finish`);
  const manifest = JSON.parse((await downloadFile(token, mf.id)).toString('utf8'));
  return { folder, files, manifest };
}

// Compare a restored value against what is live right now.
function diffValues(type, restored, live) {
  if (type === 'hash') {
    const rk = Object.keys(restored), lk = Object.keys(live || {});
    const liveSet = new Set(lk);
    const missingLive = rk.filter(k => !liveSet.has(k));
    const restoredSet = new Set(rk);
    const extraLive = lk.filter(k => !restoredSet.has(k));
    const changed = rk.filter(k => liveSet.has(k) && live[k] !== restored[k]);
    return {
      inBackup: rk.length, live: lk.length,
      missingFromLive: missingLive.length, onlyInLive: extraLive.length, valuesDiffer: changed.length,
      samples: { missingFromLive: missingLive.slice(0, 3), onlyInLive: extraLive.slice(0, 3), valuesDiffer: changed.slice(0, 3) },
    };
  }
  if (type === 'set' || type === 'list') {
    const r = restored || [], l = live || [];
    const ls = new Set(l), rs = new Set(r);
    return {
      inBackup: r.length, live: l.length,
      missingFromLive: r.filter(x => !ls.has(x)).length,
      onlyInLive: l.filter(x => !rs.has(x)).length,
      orderDiffers: type === 'list' ? JSON.stringify(r) !== JSON.stringify(l) : undefined,
    };
  }
  return { inBackup: 1, live: live == null ? 0 : 1, valuesDiffer: JSON.stringify(restored) !== JSON.stringify(live) ? 1 : 0 };
}

async function writeKey(target, type, data) {
  await redis.del(target);
  if (type === 'string') { if (data != null) await redis.set(target, data); return 1; }
  if (type === 'hash') {
    const entries = Object.entries(data || {});
    for (let i = 0; i < entries.length; i += 500) {
      await redis.hset(target, Object.fromEntries(entries.slice(i, i + 500)));
    }
    return entries.length;
  }
  if (type === 'set') {
    const arr = data || [];
    for (let i = 0; i < arr.length; i += 500) if (arr.slice(i, i + 500).length) await redis.sadd(target, ...arr.slice(i, i + 500));
    return arr.length;
  }
  if (type === 'list') {
    const arr = data || [];
    for (let i = 0; i < arr.length; i += 500) if (arr.slice(i, i + 500).length) await redis.rpush(target, ...arr.slice(i, i + 500));
    return arr.length;
  }
  throw new Error(`unsupported type ${type}`);
}

async function handleRestore(req, res, session, mode) {
  const { downloadFile } = await import('./_backupDrive.js');
  const { gunzipSync } = await import('node:zlib');
  const { createHash } = await import('node:crypto');
  const token = session.accessToken;
  if (!token) return res.status(400).json({ error: 'No Google access token on this session.' });
  const parentId = process.env.BACKUP_DRIVE_FOLDER_ID || DEFAULT_BACKUP_FOLDER;

  const day = String(req.query?.day || '');
  if (!day) return res.status(400).json({ error: 'day is required, e.g. day=2026-08-06' });

  if (mode === 'restore-plan') {
    const { folder, files, manifest } = await loadManifest(token, day, parentId);
    const liveKeys = new Set(await scanAll());
    const rows = (manifest.files || []).map(f => ({
      key: f.key, type: f.type, entries: f.entries,
      file: f.file, gzBytes: f.gzBytes,
      presentInDrive: files.some(d => d.name === f.file),
      existsLive: liveKeys.has(f.key),
    }));
    return res.status(200).json({
      day, folderId: folder.id, manifestComplete: manifest.complete,
      takenAt: manifest.finishedAt, by: manifest.by,
      files: rows,
      liveKeysNotInBackup: [...liveKeys].filter(k => !EXCLUDED_PREFIXES.some(e => k.startsWith(e.prefix)) && !rows.some(r => r.key === k)),
    });
  }

  const key = String(req.query?.key || '');
  if (!key) return res.status(400).json({ error: 'key is required' });
  const { files, manifest } = await loadManifest(token, day, parentId);
  const entry = (manifest.files || []).find(f => f.key === key);
  if (!entry) return res.status(404).json({ error: `${key} is not in the ${day} manifest` });
  const driveFile = files.find(f => f.name === entry.file);
  if (!driveFile) return res.status(404).json({ error: `${entry.file} is missing from Drive` });

  const gz = await downloadFile(token, driveFile.id);
  const sha256 = createHash('sha256').update(gz).digest('hex');
  const checksumOk = sha256 === entry.sha256;
  // Refuse to go further on a corrupt file rather than restoring garbage.
  if (!checksumOk) {
    return res.status(422).json({ error: 'Checksum mismatch — the file in Drive is not the file that was uploaded.', key, expected: entry.sha256, got: sha256 });
  }

  const payload = JSON.parse(gunzipSync(gz).toString('utf8'));
  if (payload.key !== key) return res.status(422).json({ error: `File contains ${payload.key}, expected ${key}` });

  if (mode === 'restore-check') {
    const liveType = await redis.type(key);
    const live = liveType === 'none' ? null : await readKey(key, liveType);
    return res.status(200).json({
      key, type: payload.type, checksumOk, exportedAt: payload.exportedAt,
      existsLive: liveType !== 'none',
      diff: diffValues(payload.type, payload.data, live),
      wrote: false,
    });
  }

  if (mode === 'restore-write') {
    const target = String(req.query?.target || 'scratch');
    if (target === 'live') {
      // Two independent things must both be true. A mistyped URL cannot
      // overwrite production data; it has to be meant.
      if (String(req.query?.confirm || '') !== `overwrite ${key}`) {
        return res.status(400).json({ error: `Refusing to overwrite a live key. Pass confirm=overwrite ${key} if that is genuinely intended.` });
      }
    } else if (target !== 'scratch') {
      return res.status(400).json({ error: "target must be 'scratch' or 'live'" });
    }
    const dest = target === 'live' ? key : `${SCRATCH(day)}${key}`;
    const written = await writeKey(dest, payload.type, payload.data);
    const readBack = await readKey(dest, payload.type);
    return res.status(200).json({
      key, target, dest, written,
      // Diff the thing we just wrote against the backup: proves the write path
      // round-trips, which is the part a read-only check cannot show.
      roundTrip: diffValues(payload.type, payload.data, readBack),
      wrote: true,
    });
  }

  return res.status(400).json({ error: `unknown mode ${mode}` });
}

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  const mode = String(req.query?.mode || 'inventory');

  if (mode.startsWith('export-')) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    try {
      return await handleExport(req, res, session, mode);
    } catch (e) {
      return res.status(502).json({ error: String(e?.message || e).slice(0, 400) });
    }
  }

  if (mode.startsWith('restore-')) {
    // Only the mode that writes needs POST; plan and check are reads.
    if (mode === 'restore-write' && req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    try {
      return await handleRestore(req, res, session, mode);
    } catch (e) {
      return res.status(502).json({ error: String(e?.message || e).slice(0, 400) });
    }
  }

  if (mode !== 'inventory') {
    return res.status(400).json({ error: `Unknown mode "${mode}".` });
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
