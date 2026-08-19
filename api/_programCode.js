import { Redis } from '@upstash/redis';
import { scanReplica } from './_replica.js';

// Program Code assignment for OE Lookups.
//
// Codes are `<PREFIX>-<4-digit sequence>`: AB-0003, AGI-0001, MAP-0001. The
// prefix groups a Program Type ("Adventure Basics" -> AB), the sequence counts
// within that prefix.
//
// This is the SKU problem again, and it gets the SKU answer: ONE authoritative
// counter, never a scan-at-write-time. FileMaker's own mechanism derives the
// next code by looking at what exists, and the production data shows exactly
// what that costs — 1,241 codes of which only 1,232 are distinct, so six
// collisions plus a row coded literally "AB-" with no number at all. Two people
// adding a program in the same minute is all it takes.
//
// Redis holds one counter per prefix, seeded ONCE from the highest sequence
// already in the replica for that prefix. After seeding, a code costs a single
// INCR and cannot collide.

const redis = Redis.fromEnv();

const counterKey = (db, prefix) => `vibe:${db}:oecode:${prefix}`;
const seenKey = db => `vibe:${db}:oecode:__prefixes`;

export const PAD = 4;
export const formatCode = (prefix, n) => `${prefix}-${String(n).padStart(PAD, '0')}`;

/** "AB-0003" -> { prefix: 'AB', seq: 3 }. Tolerates the junk in the real data:
 *  "AB-" yields seq 0, an unprefixed or malformed code yields null. */
export function parseCode(code) {
  const m = String(code ?? '').trim().match(/^([A-Za-z]+)-(\d*)$/);
  if (!m) return null;
  return { prefix: m[1].toUpperCase(), seq: m[2] === '' ? 0 : Number(m[2]) };
}

/** Every OE Lookup row, straight from the replica. ~1,250 rows, one page. */
async function allRows(db) {
  const out = [];
  let cursor = '0';
  do {
    const page = await scanReplica(db, 'oelookup', cursor, 1500);
    out.push(...(page.records || []));
    cursor = page.cursor;
  } while (cursor !== '0');
  return out;
}

/** Prefix -> highest sequence seen, and Program Type -> prefix, both derived
 *  from what is already stored. Deriving the prefix from the DATA rather than
 *  from the Program Type's initials matters: "Managing an Adventure Program"
 *  is MAP but "Adventure Games & Initiatives" is AGI, and several types differ
 *  only by a trailing colon or a stray space. Initials would guess wrong. */
export async function surveyCodes(db) {
  const maxByPrefix = new Map();
  const prefixByType = new Map();   // normalised Program Type -> Map(prefix -> count)
  for (const r of await allRows(db)) {
    const f = r?.fieldData || {};
    const parsed = parseCode(f['Program Code']);
    if (!parsed) continue;
    const { prefix, seq } = parsed;
    if (!maxByPrefix.has(prefix) || seq > maxByPrefix.get(prefix)) maxByPrefix.set(prefix, seq);
    const type = normalizeType(f['Program Type']);
    if (!type) continue;
    if (!prefixByType.has(type)) prefixByType.set(type, new Map());
    const m = prefixByType.get(type);
    m.set(prefix, (m.get(prefix) || 0) + 1);
  }
  // Collapse each type to its most-used prefix.
  const typeToPrefix = new Map();
  for (const [type, counts] of prefixByType) {
    let best = null, bestN = -1;
    for (const [p, n] of counts) if (n > bestN) { best = p; bestN = n; }
    if (best) typeToPrefix.set(type, best);
  }
  return { maxByPrefix, typeToPrefix };
}

export const normalizeType = v =>
  String(v ?? '').trim().replace(/[:\s]+$/, '').replace(/\s+/g, ' ').toLowerCase();

/** The prefix a given Program Type should use, or null if the type is new.
 *  A new type has no precedent, so the caller must supply a prefix. */
export async function prefixForType(db, programType) {
  const { typeToPrefix } = await surveyCodes(db);
  return typeToPrefix.get(normalizeType(programType)) || null;
}

/** Issue the next code for a prefix. Seeds the counter from the data the first
 *  time a prefix is used, then INCRs.
 *
 *  Seeding is `set(..., { nx: true })` so two concurrent first-uses cannot both
 *  seed — the loser's write is refused and both then INCR the same counter. */
export async function nextCode(db, prefix) {
  const P = String(prefix || '').trim().toUpperCase();
  if (!/^[A-Z]+$/.test(P)) throw new Error(`invalid prefix: ${prefix}`);
  const key = counterKey(db, P);
  if (!(await redis.exists(key))) {
    const { maxByPrefix } = await surveyCodes(db);
    await redis.set(key, maxByPrefix.get(P) ?? 0, { nx: true });
  }
  await redis.sadd(seenKey(db), P);
  const n = await redis.incr(key);
  return formatCode(P, n);
}

/** What a prefix's counter currently stands at, without consuming a number.
 *  Read-only — used by the UI to preview the code it is about to assign. */
export async function peekCode(db, prefix) {
  const P = String(prefix || '').trim().toUpperCase();
  const cur = await redis.get(counterKey(db, P));
  if (cur != null) return formatCode(P, Number(cur) + 1);
  const { maxByPrefix } = await surveyCodes(db);
  return formatCode(P, (maxByPrefix.get(P) ?? 0) + 1);
}
