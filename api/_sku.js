// The product SKU counter — Vibe's, not Tray's.
//
// WHAT A SKU ACTUALLY IS. Measured across all 1,267 products (2026-08-20):
//
//     378  1-6 digits          the counter, range 123 -> 2512
//     499  vendor part numbers "115-STAP500x08", "106K-GAC9/375-0000"
//      36  ISBNs               12-14 digits. Books. Never came from a counter
//      18  miscellaneous
//     336  no SKU at all
//
// So two-thirds of SKUs in the system never came from a counter and never will.
// This module issues the next integer and leaves every other kind alone. It
// NEVER renumbers anything.
//
// WHY THE COUNTER STARTS AT 3000.
//
// Until cutover, FileMaker Pro can still create a product, and its script
// trigger draws from the Tray counter that Vibe used to share. Two counters
// issuing into one namespace collide, so the only safe move while both exist is
// to give them ranges that cannot meet.
//
// Seeding from the observed maximum would NOT have been safe. The sequence is
// gappy right at the top — 2497 -> 2505, 2505 -> 2508 — and those gaps are
// numbers Tray has already issued that never reached a saved product. Tray's
// true counter is therefore above 2512 and Vibe cannot see how far above.
//
// 3000 leaves Tray 488 issues of headroom, which at any rate this catalogue has
// ever seen is years, and cutover retires Tray long before that. It also leaves
// a rule that stays readable in the data forever: a numeric SKU at or above
// 3000 was issued by Vibe. Numeric VENDOR codes (55504, 145071, 320966,
// 852491) sit above 10000 and are clear of the range either way.
//
// The one-time gap from 2512 to 3000 is cosmetic. This sequence has always had
// gaps — a burned number, a deleted product — and 8 duplicate SKUs already
// exist in the data, which is the failure the range separation prevents.
import { Redis } from '@upstash/redis';
import { ALLOWED_DBS } from './_fmp.js';

const redis = Redis.fromEnv();

export const SKU_FLOOR = 3000;
export const skuKey = db => `vibe:${db}:seq:sku`;

// Only the counter's own shape. A vendor code or an ISBN is not a candidate for
// "is this number already taken", and treating one as such would push the
// counter into the 100,000s on the first read.
const isCounterSku = s => /^\d{1,5}$/.test(s) && Number(s) < 10000;

/** Highest counter-style SKU currently on a product, or 0. */
async function observedMax(db) {
  const [repl, vibe] = await Promise.all([
    redis.hgetall(`repl:${db}:Products & Services_New:recs`).catch(() => null),
    redis.hgetall(`vibe:${db}:Products & Services_New:recs`).catch(() => null),
  ]);
  let max = 0;
  for (const store of [repl, vibe]) {
    if (!store) continue;
    for (const raw of Object.values(store)) {
      let rec = raw;
      if (typeof rec === 'string') { try { rec = JSON.parse(rec); } catch { continue; } }
      const sku = String(rec?.fieldData?.SKU ?? '').trim();
      if (isCounterSku(sku)) max = Math.max(max, Number(sku));
    }
  }
  return max;
}

/** Issue the next SKU. Returns a STRING — SKUs are text, always. */
export async function nextSku(db) {
  if (!ALLOWED_DBS.has(db)) throw new Error('db not allowed: ' + db);
  const key = skuKey(db);

  // Seed once, and seed defensively: normally the floor wins, but if a product
  // somehow already carries a number at or above it (a hand-typed SKU, a
  // restored backup), start above that instead of handing out a duplicate.
  if (!(await redis.exists(key))) {
    const seed = Math.max(SKU_FLOOR - 1, await observedMax(db));
    await redis.set(key, seed, { nx: true });
  }
  return String(await redis.incr(key));
}

/** Read the counter without consuming a number. For the Admin panel. */
export async function peekSku(db) {
  if (!ALLOWED_DBS.has(db)) throw new Error('db not allowed: ' + db);
  const cur = await redis.get(skuKey(db));
  return {
    seeded: cur != null,
    current: cur == null ? null : Number(cur),
    next: cur == null ? SKU_FLOOR : Number(cur) + 1,
    floor: SKU_FLOOR,
  };
}
