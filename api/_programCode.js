import { Redis } from '@upstash/redis';
import { scanReplica } from './_replica.js';

// Program Code assignment for OE Lookups.
//
// THE FORMAT IS `PREFIX-YYYY-N`, established by measuring the real data rather
// than by reading the older codes and assuming. Since 2020 this is what
// everything uses: of programs starting in 2026, 34 carry it and 2 carry the
// legacy form; 2027 is 37 to 1.
//
//   AB-2026-5   = Adventure Basics, calendar year 2026, the 5th of that year
//
// The sequence restarts each year and is scoped to (prefix, year). It is NOT
// zero-padded — `AB-2026-5`, never `AB-2026-0005`.
//
// Two older shapes exist and are READ but never written:
//   PREFIX-YYNN   703 rows — `AB-0003` is 2000 #03, `AB-1905` is 2019 #05.
//                 Confirmed at 98.1% against each program's start-date year.
//   PREFIX-NN      24 rows — `AOC-01`, no year at all.
//
// Prefixes are ALPHANUMERIC, not alphabetic: `A50` (Adventure 50), `L1`, `L2`.
// An `[A-Za-z]+` prefix pattern silently fails on 307 rows.
//
// Counters live in Redis, one per (prefix, year), seeded once from the highest
// sequence already present for that pair. Never a scan-at-write-time: the
// legacy data has 6 duplicate codes and a row coded literally "AB-", which is
// what deriving a number by looking at what exists eventually produces.

const redis = Redis.fromEnv();

const counterKey = (db, prefix, year) => `vibe:${db}:oecode:${prefix}:${year}`;

export const formatCode = (prefix, year, n) => `${prefix}-${year}-${n}`;

const MODERN = /^([A-Za-z0-9]+)-(\d{4})-(\d+)$/;
const LEGACY_YYNN = /^([A-Za-z0-9]+)-(\d{2})(\d{2})$/;
const LEGACY_NN = /^([A-Za-z0-9]+)-(\d{1,3})$/;

/** Parse any of the three shapes. Returns { prefix, year, seq, form } — `year`
 *  is null for the yearless legacy form. */
export function parseCode(code) {
  const c = String(code ?? '').trim();
  let m;
  if ((m = c.match(MODERN)))
    return { prefix: m[1].toUpperCase(), year: Number(m[2]), seq: Number(m[3]), form: 'modern' };
  if ((m = c.match(LEGACY_YYNN))) {
    const yy = Number(m[2]);
    return { prefix: m[1].toUpperCase(), year: yy >= 50 ? 1900 + yy : 2000 + yy, seq: Number(m[3]), form: 'yynn' };
  }
  if ((m = c.match(LEGACY_NN)))
    return { prefix: m[1].toUpperCase(), year: null, seq: Number(m[2]), form: 'nn' };
  return null;
}

export const normalizeType = v =>
  String(v ?? '').trim().replace(/[:\s]+$/, '').replace(/\s+/g, ' ').toLowerCase();

/** Calendar year from a FileMaker MM/DD/YYYY date. */
export const yearOfDate = d => {
  const m = String(d ?? '').match(/\/(\d{4})\b/);
  return m ? Number(m[1]) : null;
};

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

/** Survey the existing codes.
 *
 *  `maxByPrefixYear`  "AB|2026" -> highest sequence seen
 *  `typeToPrefix`     normalised Program Type -> the prefix it should use
 *
 *  The type->prefix map is built from MODERN codes first and only falls back to
 *  legacy ones for a type that has no modern code. This matters: "adventure
 *  basics" has historically carried eight different prefixes (AB:80 but also
 *  CTAB:19, BCS, SYR, ABL, RIAB, ABRI), and weighting all of history equally
 *  would let a one-off from 2004 outvote current practice. */
export async function surveyCodes(db) {
  const maxByPrefixYear = new Map();
  const modernByType = new Map();
  const legacyByType = new Map();
  const prefixes = new Set();

  const bump = (map, type, prefix) => {
    if (!map.has(type)) map.set(type, new Map());
    const m = map.get(type);
    m.set(prefix, (m.get(prefix) || 0) + 1);
  };

  for (const r of await allRows(db)) {
    const f = r?.fieldData || {};
    const p = parseCode(f['Program Code']);
    if (!p) continue;
    prefixes.add(p.prefix);
    if (p.year != null) {
      const k = `${p.prefix}|${p.year}`;
      if (!maxByPrefixYear.has(k) || p.seq > maxByPrefixYear.get(k)) maxByPrefixYear.set(k, p.seq);
    }
    const type = normalizeType(f['Program Type']);
    if (!type) continue;
    bump(p.form === 'modern' ? modernByType : legacyByType, type, p.prefix);
  }

  const pick = counts => {
    let best = null, bestN = -1;
    for (const [p, n] of counts) if (n > bestN) { best = p; bestN = n; }
    return best;
  };
  const typeToPrefix = new Map();
  for (const [type, counts] of legacyByType) { const p = pick(counts); if (p) typeToPrefix.set(type, p); }
  for (const [type, counts] of modernByType) { const p = pick(counts); if (p) typeToPrefix.set(type, p); }

  return { maxByPrefixYear, typeToPrefix, prefixes };
}

export async function prefixForType(db, programType) {
  const { typeToPrefix } = await surveyCodes(db);
  return typeToPrefix.get(normalizeType(programType)) || null;
}

const validPrefix = p => /^[A-Z0-9]+$/.test(p) && /[A-Z]/.test(p);

function cleanArgs(prefix, year) {
  const P = String(prefix || '').trim().toUpperCase();
  if (!validPrefix(P)) throw new Error(`invalid prefix: ${prefix}`);
  const Y = Number(year);
  if (!Number.isInteger(Y) || Y < 1990 || Y > 2100) throw new Error(`invalid year: ${year}`);
  return [P, Y];
}

/** Issue the next code for a (prefix, year). Seeds from the data on first use,
 *  then INCRs. `set(..., { nx: true })` so two concurrent first-uses cannot both
 *  seed — the loser is refused and both then INCR the same counter. */
export async function nextCode(db, prefix, year) {
  const [P, Y] = cleanArgs(prefix, year);
  const key = counterKey(db, P, Y);
  if (!(await redis.exists(key))) {
    const { maxByPrefixYear } = await surveyCodes(db);
    await redis.set(key, maxByPrefixYear.get(`${P}|${Y}`) ?? 0, { nx: true });
  }
  return formatCode(P, Y, await redis.incr(key));
}

/** The code that WOULD be issued, without consuming it. */
export async function peekCode(db, prefix, year) {
  const [P, Y] = cleanArgs(prefix, year);
  const cur = await redis.get(counterKey(db, P, Y));
  if (cur != null) return formatCode(P, Y, Number(cur) + 1);
  const { maxByPrefixYear } = await surveyCodes(db);
  return formatCode(P, Y, (maxByPrefixYear.get(`${P}|${Y}`) ?? 0) + 1);
}
