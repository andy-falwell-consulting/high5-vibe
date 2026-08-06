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
//   GET  /api/backup?mode=sa-test                   → end-to-end check of the service-account credential
//   GET  /api/backup?mode=cron                      → the nightly run (Vercel Cron, or an admin by hand)
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
  { prefix: 'restore:', why: 'scratch restore rehearsals — expire on their own' },
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

// Read a key in full, paged.
//
// Note _replica.js stores each record as a JSON string, but the Upstash REST
// client parses anything JSON-shaped on the way back out — so what lands here
// is an object, and the export re-serialises it. Round-trip fidelity is
// therefore structural rather than byte-for-byte, which is why the restore
// diff compares serialised forms rather than raw values.
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

// Prefer the service account, fall back to the caller's own Google token.
//
// Preferred because files it writes belong to the Shared Drive rather than to
// whoever happened to click, and because it is the only credential that works
// unattended. The fallback keeps the manual buttons usable if the service
// account is ever misconfigured — but which one was used is always reported,
// so a silent downgrade can't hide a broken credential.
async function driveCredential(session) {
  const { getServiceAccountToken, serviceAccountConfigured } = await import('./_gsa.js');
  if (serviceAccountConfigured()) {
    try {
      return { token: await getServiceAccountToken(), as: 'service-account' };
    } catch (e) {
      if (!session?.accessToken) throw e;
      return { token: session.accessToken, as: 'caller (service account failed)', warning: String(e.message) };
    }
  }
  if (!session?.accessToken) throw new Error('No Google credential available.');
  return { token: session.accessToken, as: 'caller' };
}

// Defaulted rather than required so this works without a Vercel env change.
// A Drive folder id is not a secret — it appears in the folder's own URL — and
// the override exists so the destination can be moved without a deploy.
const backupParent = () => process.env.BACKUP_DRIVE_FOLDER_ID || DEFAULT_BACKUP_FOLDER;

async function startRun(token, by) {
  const { ensureFolder, trashFileByName } = await import('./_backupDrive.js');
  const all = await scanAll();
  const keys = all.filter(k => !EXCLUDED_PREFIXES.some(e => k.startsWith(e.prefix))).sort();
  const now = new Date();
  // One folder per DAY, named by date. A second run on the same day reuses it
  // and replaces the files inside, so "today's backup" is one thing rather than
  // a pile of near-identical folders. runId keeps the full timestamp so two
  // runs cannot collide over the same Redis bookkeeping.
  const day = now.toISOString().slice(0, 10);
  const runId = now.toISOString().replace(/[:.]/g, '-');
  const folder = await ensureFolder(token, day, backupParent());
  // Reusing a day's folder means its files are about to be replaced, which
  // makes the existing manifest a description of contents that will no longer
  // exist. Retire it up front: an abandoned run then leaves NO manifest, which
  // restore-plan already reads as "that run did not finish". Better nothing
  // than something that lies.
  if (folder.reused) await trashFileByName(token, 'manifest.json', folder.id);
  const meta = { runId, day, folderId: folder.id, startedAt: now.toISOString(), by, keys };
  await redis.hset(runKey(runId), { meta: JSON.stringify(meta) });
  await redis.expire(runKey(runId), RUN_TTL);
  return { meta, folder };
}

async function exportOneKey(token, meta, key) {
  const { uploadFile } = await import('./_backupDrive.js');
  const { gzipSync } = await import('node:zlib');
  const { createHash } = await import('node:crypto');

  const type = await redis.type(key);
  const data = await readKey(key, type);
  const entries = type === 'hash' ? Object.keys(data).length : Array.isArray(data) ? data.length : 1;

  const payload = Buffer.from(JSON.stringify({ key, type, entries, exportedAt: new Date().toISOString(), data }), 'utf8');
  const gz = gzipSync(payload, { level: 9 });
  const sha256 = createHash('sha256').update(gz).digest('hex');
  const md5 = createHash('md5').update(gz).digest('hex');

  const file = await uploadFile(token, { name: `${safeName(key)}.json.gz`, parentId: meta.folderId, bytes: gz });
  // Drive computes md5Checksum from what it actually received, so this is a
  // real end-to-end check rather than us marking our own homework.
  const verified = !!file.md5Checksum && file.md5Checksum === md5;
  const entry = {
    key, type, entries, file: file.name, driveId: file.id,
    rawBytes: payload.length, gzBytes: gz.length, sha256, md5,
    driveMd5: file.md5Checksum || null, verified,
  };
  await redis.hset(runKey(meta.runId), { [`file:${key}`]: JSON.stringify(entry) });
  return entry;
}

async function finishRun(token, meta) {
  const { uploadFile } = await import('./_backupDrive.js');
  const all = await redis.hgetall(runKey(meta.runId)) || {};
  const files = Object.entries(all)
    .filter(([f]) => f.startsWith('file:'))
    .map(([, v]) => (typeof v === 'string' ? JSON.parse(v) : v))
    .sort((a, b) => a.key.localeCompare(b.key));

  const missing = meta.keys.filter(k => !files.some(f => f.key === k));
  const unverified = files.filter(f => !f.verified).map(f => f.key);

  const manifest = {
    runId: meta.runId, day: meta.day,
    startedAt: meta.startedAt, finishedAt: new Date().toISOString(),
    by: meta.by, folderId: meta.folderId,
    complete: missing.length === 0 && unverified.length === 0,
    missing, unverified,
    excluded: EXCLUDED_PREFIXES.map(e => ({ prefix: e.prefix, why: e.why })),
    totals: {
      files: files.length,
      entries: files.reduce((n, f) => n + f.entries, 0),
      rawBytes: files.reduce((n, f) => n + f.rawBytes, 0),
      gzBytes: files.reduce((n, f) => n + f.gzBytes, 0),
    },
    files,
  };

  // The manifest goes up LAST and uncompressed, so its presence is the signal a
  // run finished and it can be read without tooling.
  const body = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  const mf = await uploadFile(token, { name: 'manifest.json', parentId: meta.folderId, bytes: body, mimeType: 'application/json' });
  await redis.del(runKey(meta.runId));
  return { manifest, manifestDriveId: mf.id };
}

async function handleExport(req, res, session, mode) {
  const cred = await driveCredential(session);
  const token = cred.token;
  const parentId = backupParent();

  if (mode === 'export-start') {
    const { meta, folder } = await startRun(token, session.email);
    return res.status(200).json({
      runId: meta.runId, folderId: folder.id, folderName: folder.name,
      reusedFolder: folder.reused, keys: meta.keys, credential: cred.as, credentialWarning: cred.warning,
    });
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
    return res.status(200).json(await exportOneKey(token, meta, key));
  }

  if (mode === 'export-finish') {
    const { manifest, manifestDriveId } = await finishRun(token, meta);
    return res.status(200).json({ ...manifest, manifestDriveId, files: undefined, fileCount: manifest.files.length });
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
// Scratch restores expire on their own. A rehearsal of the Contacts hash puts
// another 26MB into Redis, and leaving that lying around would bloat storage
// and turn up in the next inventory. Excluded from backups above, and gone
// within a day either way.
const SCRATCH_TTL = 24 * 60 * 60;

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
//
// Values are compared by SERIALISED form, not by ===. The Upstash REST client
// auto-deserialises anything that parses as JSON, so hash values come back as
// objects rather than the strings _replica.js stored — and === on two
// structurally identical objects is always false. The first run of this
// reported every one of 15,589 contacts as changed for exactly that reason.
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function diffValues(type, restored, live) {
  if (type === 'hash') {
    const rk = Object.keys(restored), lk = Object.keys(live || {});
    const liveSet = new Set(lk);
    const missingLive = rk.filter(k => !liveSet.has(k));
    const restoredSet = new Set(rk);
    const extraLive = lk.filter(k => !restoredSet.has(k));
    const changed = rk.filter(k => liveSet.has(k) && !sameValue(live[k], restored[k]));
    return {
      inBackup: rk.length, live: lk.length,
      missingFromLive: missingLive.length, onlyInLive: extraLive.length, valuesDiffer: changed.length,
      samples: { missingFromLive: missingLive.slice(0, 3), onlyInLive: extraLive.slice(0, 3), valuesDiffer: changed.slice(0, 3) },
    };
  }
  if (type === 'set' || type === 'list') {
    const r = (restored || []).map(x => JSON.stringify(x));
    const l = (live || []).map(x => JSON.stringify(x));
    const ls = new Set(l), rs = new Set(r);
    return {
      inBackup: r.length, live: l.length,
      missingFromLive: r.filter(x => !ls.has(x)).length,
      onlyInLive: l.filter(x => !rs.has(x)).length,
      orderDiffers: type === 'list' ? r.join('\u0000') !== l.join('\u0000') : undefined,
    };
  }
  return { inBackup: 1, live: live == null ? 0 : 1, valuesDiffer: sameValue(restored, live) ? 0 : 1 };
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
  const { token } = await driveCredential(session);
  const parentId = backupParent();

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
    if (target !== 'live') await redis.expire(dest, SCRATCH_TTL);
    const readBack = await readKey(dest, payload.type);
    return res.status(200).json({
      key, target, dest, written,
      expiresInSeconds: target === 'live' ? null : SCRATCH_TTL,
      // Diff the thing we just wrote against the backup: proves the write path
      // round-trips, which is the part a read-only check cannot show.
      roundTrip: diffValues(payload.type, payload.data, readBack),
      wrote: true,
    });
  }

  return res.status(400).json({ error: `unknown mode ${mode}` });
}


// ── Service-account connectivity test ─────────────────────────────
//
// The nightly backup will authenticate as a service account rather than as
// whoever happens to be signed in (see _gsa.js for why). Getting that wired up
// involves several things that can each fail silently — a malformed PEM, the
// Drive API not enabled, the account not added to the Shared Drive, Workspace
// policy blocking external members — and Google's errors are not always plain
// about which.
//
// So rather than guess, this walks the whole path and reports each step: mint a
// token, resolve the folder, list it, write a probe file, read it back, and
// remove the probe. It leaves nothing behind, and on failure it says which step
// broke and what to do about it.
async function handleSaTest(req, res) {
  const { getServiceAccountToken, serviceAccountConfigured } = await import('./_gsa.js');
  const { listFolder, uploadFile, downloadFile, trashFileByName } = await import('./_backupDrive.js');
  const parentId = process.env.BACKUP_DRIVE_FOLDER_ID || DEFAULT_BACKUP_FOLDER;

  const steps = [];
  const step = (name, ok, detail, hint) => { steps.push({ name, ok, detail, hint }); return ok; };

  if (!serviceAccountConfigured()) {
    step('Credential present', false, 'GDRIVE_SA_EMAIL / GDRIVE_SA_PRIVATE_KEY are not both set',
      'Add both in the Vercel project settings, then redeploy — env changes need a new deployment to take effect.');
    return res.status(200).json({ ok: false, folderId: parentId, steps });
  }
  step('Credential present', true, `${process.env.GDRIVE_SA_EMAIL}${process.env.GDRIVE_SA_SUBJECT ? ` impersonating ${process.env.GDRIVE_SA_SUBJECT}` : ''}`);

  let token;
  try {
    token = await getServiceAccountToken({ force: true });
    step('Mint access token', true, 'Google accepted the signed assertion');
  } catch (e) {
    const msg = String(e.message);
    step('Mint access token', false, msg,
      /sign with GDRIVE_SA_PRIVATE_KEY/.test(msg)
        ? 'The private key did not parse. Paste the whole PEM including the BEGIN/END lines.'
        : /unauthorized_client/.test(msg)
          ? 'If GDRIVE_SA_SUBJECT is set, domain-wide delegation is not authorised for this client ID and scope in the Admin console.'
          : 'Check the service account still exists and its key has not been revoked.');
    return res.status(200).json({ ok: false, folderId: parentId, steps });
  }

  // Listing proves both that the Drive API is on and that the account can
  // actually see the folder — the step that fails when sharing was missed.
  let existing;
  try {
    existing = await listFolder(token, parentId);
    step('See the backup folder', true, `${existing.length} item(s) visible`);
  } catch (e) {
    const msg = String(e.message);
    step('See the backup folder', false, msg,
      /has not been used|disabled/i.test(msg)
        ? 'Enable the Google Drive API for this Cloud project (APIs & Services → Library).'
        : /404|notFound/i.test(msg)
          ? 'The service account cannot see this folder. Add its email as a Content Manager on the Shared Drive — it will not autocomplete, type the full address and press Enter.'
          : 'Check the folder id and that the account has at least reader access.');
    return res.status(200).json({ ok: false, folderId: parentId, steps });
  }

  const probeName = `connectivity-test-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  const body = Buffer.from('Vibe backup connectivity test. Safe to delete.\n', 'utf8');
  let file;
  try {
    file = await uploadFile(token, { name: probeName, parentId, bytes: body, mimeType: 'text/plain' });
    step('Write a file', true, `created ${probeName}`);
  } catch (e) {
    step('Write a file', false, String(e.message),
      'The account can see the folder but not write to it — its role is probably Viewer or Commenter. Content Manager is what it needs.');
    return res.status(200).json({ ok: false, folderId: parentId, steps });
  }

  try {
    const back = await downloadFile(token, file.id);
    const same = back.equals(body);
    step('Read it back', same, same ? `${back.length} bytes, byte-identical` : 'content did not match what was written',
      same ? undefined : 'Downloads are being altered in transit — unexpected; do not rely on this backup until understood.');
  } catch (e) {
    step('Read it back', false, String(e.message), 'Written but not readable — check the account has more than write-only access.');
  }

  try {
    await trashFileByName(token, probeName, parentId);
    step('Clean up', true, 'probe file moved to the bin');
  } catch (e) {
    step('Clean up', false, String(e.message), `Harmless, but ${probeName} is still in the folder — delete it by hand.`);
  }

  const ok = steps.every(s => s.ok);
  return res.status(200).json({ ok, folderId: parentId, steps });
}


// ── Nightly run ───────────────────────────────────────────────────
//
// The manual export is driven one key per request from the browser, which a
// cron cannot do — so this is the server-side equivalent, bounded by a deadline
// well inside Vercel's 300s ceiling. A measured full run takes ~115s for 51
// keys, so there is real headroom; if a run ever does overrun, it still writes
// a manifest, which records exactly what it did and did not capture. A backup
// that is honest about its gaps beats one that silently truncates.
//
// Redis cost is about 150 commands per night — negligible against the daily
// budget, unlike the 5-minute crons that exhausted the quota on 2026-07-19.
const CRON_BUDGET_MS = 240_000;

// Keep every day for KEEP_DAYS, then the first of each month forever. Without
// this the folder grows by ~15MB a night indefinitely. Folders are TRASHED
// rather than deleted, so a mistake here is recoverable from Drive's bin.
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 30);

async function pruneOldBackups(token, parentId, todayIso) {
  const { listFolder, trashFileById } = await import('./_backupDrive.js');
  const cutoff = new Date(todayIso);
  cutoff.setUTCDate(cutoff.getUTCDate() - KEEP_DAYS);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const items = await listFolder(token, parentId);
  const trashed = [];
  for (const f of items) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.name)) continue;   // only dated folders
    if (f.name >= cutoffIso) continue;                     // inside the window
    if (f.name.endsWith('-01')) continue;                  // month marker, kept
    try { await trashFileById(token, f.id); trashed.push(f.name); } catch { /* leave it */ }
  }
  return trashed;
}

async function handleCron(req, res) {
  const started = Date.now();
  const { token, as } = await driveCredential(null);
  const { meta } = await startRun(token, `cron (${as})`);

  const failures = [];
  let done = 0;
  for (const key of meta.keys) {
    if (Date.now() - started > CRON_BUDGET_MS) {
      failures.push(`ran out of time after ${done}/${meta.keys.length} keys`);
      break;
    }
    try {
      const entry = await exportOneKey(token, meta, key);
      if (!entry.verified) failures.push(`${key}: Drive did not confirm the checksum`);
    } catch (e) {
      // Keep going. A partial backup whose manifest names the gaps is worth
      // more than stopping at the first bad key.
      failures.push(`${key}: ${String(e.message).slice(0, 160)}`);
    }
    done++;
  }

  const { manifest } = await finishRun(token, meta);
  let pruned = [];
  if (manifest.complete) pruned = await pruneOldBackups(token, backupParent(), meta.day);

  return res.status(200).json({
    day: meta.day,
    credential: as,
    complete: manifest.complete,
    files: manifest.totals.files,
    entries: manifest.totals.entries,
    gzBytes: manifest.totals.gzBytes,
    missing: manifest.missing.length,
    unverified: manifest.unverified.length,
    failures,
    // Pruning only runs after a complete backup — never trim history on the
    // strength of a run that did not finish.
    pruned,
    elapsedMs: Date.now() - started,
  });
}

export default async function handler(req, res) {
  const mode0 = String(req.query?.mode || 'inventory');

  // Vercel Cron sends Authorization: Bearer $CRON_SECRET. Checked before the
  // session lookup because a cron has no login and never will.
  if (mode0 === 'cron') {
    const secret = process.env.CRON_SECRET;
    const authed = secret && req.headers.authorization === `Bearer ${secret}`;
    if (!authed) {
      const s = await getGoogleSession(req);
      if (!s || !(await isAdminEmail(s.email))) return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      return await handleCron(req, res);
    } catch (e) {
      return res.status(502).json({ error: String(e?.message || e).slice(0, 400) });
    }
  }

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

  if (mode === 'sa-test') {
    try {
      return await handleSaTest(req, res);
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
