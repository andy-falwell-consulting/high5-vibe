// Vibe-owned record data. Files starting with _ are not Vercel routes.
//
// PHASE 1 of docs/vibe-owns-the-record.md.
//
// Two keyspaces, deliberately separate:
//
//   repl:{db}:{layout}:recs   FileMaker's copy. A sync REPLACES it wholesale.
//   vibe:{db}:{layout}:recs   Vibe's own edits. A sync NEVER touches it.
//
// A read merges the two, Vibe winning field by field. Because they are separate
// keys, "a sync cannot destroy Vibe work" is true by construction rather than
// by carefulness — which is the whole point. Every Kanban bug chased on
// 2026-08-05 came from those two things sharing one store, and each fix was a
// different edge of that same collapse.
//
// A fragment holds only the fields Vibe has changed, not a whole record:
//
//   { fieldData: { Status: 'Approved' }, __updatedAt, __by }
//   { __deleted: true, __updatedAt, __by }                      tombstone
//   { fieldData: {...}, __created: true, ... }                  born in Vibe
//
// Storing fragments rather than whole records means a FileMaker change to a
// field Vibe has never touched still flows through on the next sync. Only what
// Vibe actually edited is pinned.
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export const vibeKey = (db, layout) => `vibe:${db}:${layout}:recs`;

// The whole overlay, as a Map. Small by design — it holds only records Vibe has
// touched, not the 6,400-record table. If it ever grows enough for this to hurt,
// switch to HMGET of the ids in the current page plus one HGETALL on the last
// page to pick up Vibe-only records.
export async function readOverlay(db, layout) {
  const raw = (await redis.hgetall(vibeKey(db, layout))) || {};
  const map = new Map();
  for (const [id, v] of Object.entries(raw)) {
    try {
      map.set(String(id), typeof v === 'string' ? JSON.parse(v) : v);
    } catch { /* unparseable fragment: ignore rather than fail the whole read */ }
  }
  return map;
}

export async function readFragment(db, layout, recordId) {
  const v = await redis.hget(vibeKey(db, layout), String(recordId));
  if (v == null) return null;
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
}

// Vibe wins field by field. Anything Vibe hasn't set keeps FileMaker's value.
export function mergeRecord(base, frag) {
  if (!frag) return base;
  if (frag.__deleted) return null;
  if (!base) return frag.fieldData ? { recordId: frag.recordId, fieldData: { ...frag.fieldData } } : null;
  return { ...base, fieldData: { ...base.fieldData, ...(frag.fieldData || {}) } };
}

// Apply an overlay to one page of replica records.
//
// `isLastPage` matters: records created in Vibe have no FileMaker counterpart,
// so they appear in no page of the replica scan and have to be appended once —
// on the final page, since the client accumulates pages until the cursor comes
// back '0'. Appending on every page would duplicate them.
export function applyOverlay(records, overlay, isLastPage) {
  if (!overlay.size) return records;

  const out = [];
  const seen = new Set();
  for (const r of records) {
    const id = String(r.recordId);
    seen.add(id);
    const merged = mergeRecord(r, overlay.get(id));
    if (merged) out.push(merged);   // null = tombstoned, so it drops out
  }

  if (isLastPage) {
    for (const [id, frag] of overlay) {
      if (seen.has(id) || frag.__deleted || !frag.__created) continue;
      const born = mergeRecord(null, { ...frag, recordId: id });
      if (born) out.push(born);
    }
  }
  return out;
}

// Layouts whose EDITS are Vibe's rather than FileMaker's. Deliberately a short
// explicit list rather than "everything replicated": each layout moves in its
// own phase, and a layout not named here still writes to FileMaker.
export const VIBE_OWNED = new Set(['RCD_New', 'Inspections_New', 'trainings_New', 'RMI_New', 'Products & Services_New', 'Estimates_New', 'OELookup_New']);

// Layouts whose DELETION is Vibe's — PHASE A2.
//
// A separate list from VIBE_OWNED on purpose, even though it currently spans
// more layouts. Edits moved one layout at a time (A3) because each needed its
// own module changed; deletion moved in a single change because every module
// deletes through one shared component. Folding the two together would silently
// grant edit ownership to Contacts_New, which was never decided — the plan
// tracks them as separate columns for exactly this reason.
//
// OELookup_New used to be named here too. It joined VIBE_OWNED on 2026-08-19,
// deliberately and as part of building creation for it: shipping a create path
// without edit ownership would let someone create a record in Vibe and then be
// unable to correct a typo in it.
export const VIBE_DELETES = new Set([
  'RCD_New', 'Inspections_New', 'trainings_New', 'RMI_New',
  'Products & Services_New', 'Estimates_New', 'Contacts_New', 'OELookup_New',
]);

// Each table's own primary key, which a record born in Vibe has to mint for
// itself because FileMaker is not there to auto-enter one. Verified against the
// live layouts rather than inferred from the naming pattern.
export const VIBE_PK = {
  'RCD_New': '_kpt__RCD_ID',
  'Inspections_New': '_kpt__Inspection_ID',
  'RMI_New': '_kpt__RMI_ID',
  'Estimates_New': '_kpt__Estimate_ID',
  'trainings_New': '_kpt__TrainingProposal_ID',
  'Products & Services_New': '_kpt__Item_ID',
  // Added to the FileMaker layout by Andy on 2026-08-19 specifically to make
  // this possible — before that the layout had no key of any kind and
  // createFragment could only throw. Backfilled and clean on arrival: 1,247 of
  // 1,247 rows, all unique, no blanks.
  'OELookup_New': '_kpt__WorkshopLookup_ID',
};

// Ids for records born in Vibe: `V-100001`, from a per-layout counter.
//
// The prefix is deliberate and is shown wherever the id is shown, including on
// printed reports (decided 2026-08-17). FileMaker's ids are bare integers, so
// anything prefixed is unambiguously Vibe's, and when FileMaker is retired the
// prefixed set is exactly the set with no counterpart to reconcile. Minting
// numbers inside FileMaker's own sequence would have risked a silent collision
// for the sake of cosmetics.
//
// Ids are opaque STRINGS everywhere; a codebase audit before Contacts shipped
// found no numeric coercion of record ids, and a re-check before this one found
// none either. That property has to be preserved, not assumed.
const SEQ_START = 100000;

export async function nextRecordId(db, layout) {
  const n = await redis.incr(`vibe:${db}:seq:${layout}`);
  return `V-${SEQ_START + n}`;
}

export const isVibeRecordId = id => /^V-/.test(String(id ?? ''));

// Create a record that exists only in Vibe. `__created` is what makes
// applyOverlay append it to the last page of a list read and api/record.js
// serve it when FileMaker has no counterpart — both already built and, until
// now, unreachable because nothing wrote this flag.
// ── The change index ──────────────────────────────────────────────
//
// One ZSET per layout: score = when the record last changed (ms), member =
// recordId. It is what makes an incremental refresh possible — without it the
// only way to answer "what changed since X" is to read the whole hash, which is
// what put 90 GB through Upstash.
//
// BOTH writers maintain it, and that is the point. The replica sync knows when
// FileMaker last modified a record; the overlay below knows when someone edited
// one in Vibe. A record can change either way, so an index fed by only one of
// them would silently miss half the edits — a colleague's change to a record
// you already have cached would never arrive.
//
// Shared with api/_replica.js, which owns the `repl:` half of the same key
// space, so the name lives here and is imported there.
export const changeKey = (db, layout) => `repl:${db}:${layout}:bymod`;

/** Note that `ids` changed at `atMs`. Best-effort: an index miss costs a stale
 *  row until the next full refresh, never a wrong write, so it must never
 *  break the write it is recording. */
export async function noteChanged(db, layout, ids, atMs = Date.now()) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!list.length) return;
  try {
    await redis.zadd(changeKey(db, layout), ...list.map(id => ({ score: atMs, member: id })));
  } catch { /* index is an optimisation, not a source of truth */ }
}

export async function createFragment(db, layout, fieldData, by) {
  const pk = VIBE_PK[layout];
  if (!pk) throw new Error(`no primary key known for ${layout}`);
  const id = await nextRecordId(db, layout);
  const frag = {
    fieldData: { ...fieldData, [pk]: id },
    __created: true,
    __updatedAt: new Date().toISOString(),
    __by: by || null,
  };
  await redis.hset(vibeKey(db, layout), { [id]: JSON.stringify(frag) });
  await noteChanged(db, layout, id);
  return { recordId: id, fragment: frag };
}

// Merge a set of changed fields into a record's fragment.
//
// Read-modify-write rather than blind overwrite, so two people editing
// different fields of the same record don't erase each other. Not a
// transaction — a genuine simultaneous write to the SAME field still resolves
// last-writer-wins, which matches how the app behaved against FileMaker.
export async function writeFragment(db, layout, recordId, fieldData, by) {
  const id = String(recordId);
  const existing = (await readFragment(db, layout, id)) || {};
  const frag = {
    ...existing,
    fieldData: { ...(existing.fieldData || {}), ...fieldData },
    __updatedAt: new Date().toISOString(),
    __by: by || null,
  };
  await redis.hset(vibeKey(db, layout), { [id]: JSON.stringify(frag) });
  await noteChanged(db, layout, id);
  return frag;
}

// Drop a fragment entirely, so the record goes back to being FileMaker's.
// Returns whether there was one to remove, so a caller can tell "reverted" from
// "there was nothing to revert".
export async function dropFragment(db, layout, recordId) {
  const n = await redis.hdel(vibeKey(db, layout), String(recordId));
  // Reverting to FileMaker's version is a change too — a client holding the
  // overridden values needs to hear about it.
  if (n > 0) await noteChanged(db, layout, recordId);
  return n > 0;
}

// Mark a record deleted — PHASE A2.
//
// Deliberately NOT the same operation as dropFragment above, which means the
// opposite: drop reverts a record to FileMaker's version, tombstone hides it.
// They are one keystroke apart in effect and total opposites in intent, so they
// are separate functions rather than one with a flag.
//
// The tombstone REPLACES any field edits rather than joining them. Once a record
// is deleted, what Vibe used to display is irrelevant, and keeping the fields
// would resurrect stale values if the tombstone were ever lifted by hand.
//
// A record born in Vibe is dropped outright instead: it has no FileMaker row to
// hide, so a tombstone for it is litter that every future read steps over.
//
// This is what makes a deletion survive a refresh. A sync replaces `repl:`
// wholesale and never touches `vibe:`, so a deleted row keeps arriving back in
// the replica and is hidden again on every read. Deleting from `repl:` alone
// would last exactly until the next sync — the trap api/_contacts.js already
// records for contacts, which is why they got tombstones first.
export async function tombstoneFragment(db, layout, recordId, by) {
  const id = String(recordId);
  const existing = await readFragment(db, layout, id);
  if (existing?.__created) {
    await dropFragment(db, layout, id);
    return { tombstoned: false, bornInVibe: true };
  }
  const frag = { __deleted: true, __updatedAt: new Date().toISOString(), __by: by || null };
  await redis.hset(vibeKey(db, layout), { [id]: JSON.stringify(frag) });
  await noteChanged(db, layout, id);
  return { tombstoned: true, bornInVibe: false };
}

// ── Shadowed FileMaker changes ────────────────────────────────────
//
// The honest cost of one-way sync: when FileMaker changes a field Vibe has
// already overridden, that change arrives, lands in repl:, and is then hidden
// under the overlay. Nobody sees it. This records those so the loss is visible
// rather than silent.
//
// It is also how the open question gets answered with evidence instead of
// opinion: if this stays empty, nobody is editing CCS records in FMP Pro, and
// the merge layer can eventually be deleted. If it fills up, we know exactly
// who is working where and on which fields.
export const shadowKey = (db, layout) => `vibe:${db}:${layout}:shadowed`;

// Guards against an unbounded hash if something upstream goes haywire — the
// signal is "is this empty or not", and a few hundred examples is plenty to
// act on.
const SHADOW_MAX = 500;

// Compare an incoming batch of FileMaker records against what Vibe overrides.
// `previous` is the repl: copy from BEFORE this sync wrote over it, so this
// detects a genuine FileMaker CHANGE rather than merely "Vibe differs from FMP"
// (which is true of every edit Vibe has ever made and would say nothing).
export async function recordShadowed(db, layout, incoming, previous, overlay) {
  if (!overlay.size) return 0;
  const entries = {};

  for (const rec of incoming) {
    const id = String(rec.recordId);
    const frag = overlay.get(id);
    if (!frag?.fieldData) continue;
    const before = previous.get(id);
    if (!before) continue;   // new to the replica: nothing was overwritten

    const changed = [];
    for (const [field, vibeShows] of Object.entries(frag.fieldData)) {
      const was = before.fieldData?.[field];
      const now = rec.fieldData?.[field];
      if (JSON.stringify(was) === JSON.stringify(now)) continue;  // FMP didn't touch it
      // FileMaker changed, but landed on the value Vibe already shows — the two
      // agree, so nothing is being hidden and there is nothing to report.
      // Without this the list fills with entries whose fmpNow and vibeShows are
      // identical, and a signal that cries wolf gets ignored.
      if (JSON.stringify(now) === JSON.stringify(vibeShows)) continue;
      changed.push({ field, fmpWas: was ?? null, fmpNow: now ?? null, vibeShows });
    }
    if (changed.length) entries[id] = JSON.stringify({ at: new Date().toISOString(), fields: changed });
  }

  const n = Object.keys(entries).length;
  if (!n) return 0;
  if ((await redis.hlen(shadowKey(db, layout))) < SHADOW_MAX) {
    await redis.hset(shadowKey(db, layout), entries);
  }
  return n;
}

export async function readShadowed(db, layout) {
  const raw = (await redis.hgetall(shadowKey(db, layout))) || {};
  return Object.entries(raw).map(([recordId, v]) => {
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    return { recordId, ...parsed };
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export async function clearShadowed(db, layout) {
  await redis.del(shadowKey(db, layout));
}
