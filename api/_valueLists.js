import { Redis } from '@upstash/redis';
import { fmpToken } from './_fmp.js';

// PHASE C3 — value lists become Vibe's.
//
// Today's dropdowns call FileMaker's Data API from the browser for each
// layout's value lists (src/api/filemaker.js getValueLists), with a hard-coded
// array in the component as the fallback when that call fails. After cutover
// the call always fails, so every dropdown in the app silently freezes at
// whatever was hard-coded on the day it shipped.
//
// That is not hypothetical drift. Measured 2026-08-19: CCS's `Lead Builder`
// fallback lists 11 people and FileMaker lists 12 — Reese Bernard is missing
// from the copy in the code. Freeze it there and the only way to add a builder,
// a trainer or a program type is a code change and a deploy.
//
// So Vibe holds them, seeded from FileMaker while FileMaker is still there, and
// editable afterwards.
//
// Storage: ONE hash per db, field per layout, value = { listName: [values] }.
// These are small (the largest real vocabulary is 45 trainers) and read
// together per layout, so a field-per-list would only add round trips.

const redis = Redis.fromEnv();
const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';

export const vlKey = db => `vibe:${db}:vlists`;

// Lists longer than this are not vocabularies — they are record lookups that
// happen to be exposed as value lists. RCD_New carries `Contacts_Lookup` with
// 4,821 entries; nothing should render that in a <select>, and nothing should
// copy it into Redis either. Mirrors VL_MAX_VALUES in src/api/filemaker.js.
export const MAX_VALUES = 200;

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

/** Vibe's lists for one layout, or null if it has never been seeded.
 *  null is meaningfully different from {} — "not seeded" must fall back to
 *  FileMaker, while "seeded and then emptied" must not. */
export async function readLists(db, layout) {
  const raw = await redis.hget(vlKey(db), layout);
  const v = parse(raw);
  return v && typeof v === 'object' ? v : null;
}

/** Every layout Vibe holds lists for. */
export async function readAll(db) {
  const all = await redis.hgetall(vlKey(db));
  const out = {};
  for (const [layout, raw] of Object.entries(all || {})) {
    const v = parse(raw);
    if (v && typeof v === 'object') out[layout] = v;
  }
  return out;
}

async function writeLists(db, layout, lists) {
  await redis.hset(vlKey(db), { [layout]: JSON.stringify(lists) });
  return lists;
}

/** Replace one list's values. Trims, drops blanks, de-dupes, keeps order. */
export async function setList(db, layout, name, values) {
  const clean = [...new Set((values || []).map(v => String(v ?? '').trim()).filter(Boolean))];
  if (clean.length > MAX_VALUES) throw new Error(`too many values (${clean.length} > ${MAX_VALUES})`);
  const lists = (await readLists(db, layout)) || {};
  lists[name] = clean;
  return writeLists(db, layout, lists);
}

/** Remove a list entirely. */
export async function removeList(db, layout, name) {
  const lists = await readLists(db, layout);
  if (!lists || !(name in lists)) return { removed: false, lists: lists || {} };
  delete lists[name];
  return { removed: true, lists: await writeLists(db, layout, lists) };
}

/** Read one layout's value lists straight from FileMaker. */
export async function fetchFromFileMaker(db, layout) {
  const token = await fmpToken(db);
  try {
    const res = await fetch(
      `${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${encodeURIComponent(layout)}`,
      { headers: { Authorization: `Bearer ${token}` } });
    const j = await res.json();
    const out = {};
    const skipped = [];
    for (const vl of (j?.response?.valueLists || [])) {
      // FileMaker pads lists with null and whitespace-only placeholders — drop
      // them, or a <select> renders blank options.
      const values = [...new Set(
        (vl.values || []).map(v => String(v?.displayValue ?? '').trim()).filter(Boolean))];
      if (!values.length) continue;
      if (values.length > MAX_VALUES) { skipped.push({ name: vl.name, count: values.length }); continue; }
      out[vl.name] = values;
    }
    return { lists: out, skipped };
  } finally {
    // Release the session rather than leaving it to time out — seeding runs
    // over several layouts and FileMaker's session count is finite.
    await fetch(`${FMP_HOST}/fmi/data/v2/databases/${db}/sessions/${token}`, { method: 'DELETE' })
      .catch(() => {});
  }
}

/** Seed (or re-seed) one layout from FileMaker.
 *
 *  `merge` keeps any list Vibe already holds that FileMaker no longer has, and
 *  lets FileMaker win where both do. That is the safe default for a re-seed:
 *  a list added in Vibe after cutover has no FileMaker counterpart and must not
 *  be wiped by someone re-running the seed. */
export async function seedLayout(db, layout, { merge = true } = {}) {
  const { lists: fresh, skipped } = await fetchFromFileMaker(db, layout);
  const existing = (await readLists(db, layout)) || {};
  const next = merge ? { ...existing, ...fresh } : fresh;
  await writeLists(db, layout, next);
  return {
    layout,
    seeded: Object.keys(fresh).length,
    kept: merge ? Object.keys(existing).filter(k => !(k in fresh)).length : 0,
    total: Object.keys(next).length,
    skipped,
  };
}
