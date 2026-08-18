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
export const VIBE_OWNED = new Set(['RCD_New', 'Inspections_New', 'trainings_New', 'RMI_New', 'Products & Services_New']);

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
  return frag;
}

// Drop a fragment entirely, so the record goes back to being FileMaker's.
// Returns whether there was one to remove, so a caller can tell "reverted" from
// "there was nothing to revert".
export async function dropFragment(db, layout, recordId) {
  const n = await redis.hdel(vibeKey(db, layout), String(recordId));
  return n > 0;
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
