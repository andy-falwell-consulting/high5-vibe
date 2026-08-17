// Inspection line items — the findings that make up an inspection report.
// Files starting with _ are not Vercel routes.
//
//   vibe:{db}:inspli   inspectionId → [ { id, Description, Quantity, … }, … ]
//
// ONE HASH FIELD PER INSPECTION, not per line, and deliberately NOT on the
// record's Vibe fragment. Measured across all 208,416 rows before choosing:
//
//   lines per inspection   median 40 | p90 80 | p99 125 | max 201
//   stored per inspection  median 12.9 KB | p99 42.4 KB | max 67.1 KB
//   total                  67.6 MB
//
// Contact methods embed on the contact because they top out at 8 per record.
// These do not, for a reason that has nothing to do with the averages:
// `readOverlay` in _vibeStore.js does an HGETALL of the whole overlay hash on
// every records page. Putting 67.6 MB of findings in there would pull all of it
// on every read — a broken read path, not a slow one. Here they are read with a
// single HGET when an inspection is opened, and never in bulk.
//
// Keyed by the inspection's own `_kpt__Inspection_ID`, not FileMaker's
// recordId: recordIds are FileMaker internals that die with it, and every other
// Vibe store (contacts, files) already keys on the business id.
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export const linesKey = db => `vibe:${db}:inspli`;

// The fields this app owns. `ITEM::Name` also appears in the portal but belongs
// to a related item record, so it is read-only and deliberately not stored —
// same call the FileMaker version made.
export const LINE_FIELDS = ['Description', 'Quantity', 'Equipment', 'Element_Grade', 'Category', 'Flag_Checkbox'];

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

export async function readLines(db, inspectionId) {
  const v = await redis.hget(linesKey(db), String(inspectionId));
  const arr = parse(v);
  return Array.isArray(arr) ? arr : [];
}

export async function writeLines(db, inspectionId, lines) {
  if (!lines.length) {
    await redis.hdel(linesKey(db), String(inspectionId));
    return [];
  }
  await redis.hset(linesKey(db), { [String(inspectionId)]: JSON.stringify(lines) });
  return lines;
}

// Lines added in Vibe get a VL- id, the same convention as V-/VM-/VF- elsewhere:
// a bare number came from FileMaker, anything prefixed is ours.
export async function nextLineId(db) {
  const n = await redis.incr(`vibe:${db}:seq:inspli`);
  return `VL-${100000 + n}`;
}

// Only the owned fields, and only ones with a value — the same shape `toRow`
// built for the portal, so a migrated line and a new one are indistinguishable.
export function cleanLine(input, id) {
  const out = { id };
  for (const f of LINE_FIELDS) {
    const v = input?.[f];
    if (v !== undefined && v !== null && String(v) !== '') out[f] = v;
  }
  return out;
}
