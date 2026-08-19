import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { nextCode, peekCode, prefixForType, surveyCodes, yearOfDate } from './_programCode.js';

// Program Codes for OE Lookups — `PREFIX-YYYY-N` (see _programCode.js).
//
//   GET  ?db=…&programType=…&startDate=03/24/2026
//        -> { prefix, year, preview }        — read-only, consumes nothing
//   GET  ?db=…&prefixes=1
//        -> { prefixes: [...] }              — for picking one on a new type
//   POST ?db=…  { programType | prefix, startDate }
//        -> { code, prefix, year }           — CONSUMES the next number
//
// GET and POST are split deliberately: the form previews the code while you
// type, and a preview that consumed a number would burn one on every keystroke
// and every abandoned form.

// The sequence is scoped to the program's own calendar year, so the year comes
// from the START DATE, not from today. A 2027 program entered in 2026 must be
// numbered in the 2027 series — which is not hypothetical, since 37 programs
// starting in 2027 already exist.
const resolveYear = (startDate, fallbackYear) =>
  yearOfDate(startDate) || Number(fallbackYear) || new Date().getFullYear();

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  try {
    if (req.method === 'GET') {
      if (req.query?.prefixes === '1') {
        const { prefixes } = await surveyCodes(db);
        return res.status(200).json({ prefixes: [...prefixes].sort() });
      }
      const explicit = String(req.query?.prefix || '').trim().toUpperCase();
      const programType = String(req.query?.programType || '');
      const prefix = explicit || (programType ? await prefixForType(db, programType) : null);
      const year = resolveYear(req.query?.startDate, req.query?.year);
      // A Program Type nobody has used before has no prefix to infer. Say so
      // rather than guessing from initials — "Managing an Adventure Program" is
      // MAP but "Adventure Games & Initiatives" is AGI, and A50/L1/L2 are not
      // initials at all.
      if (!prefix) return res.status(200).json({ prefix: null, year, preview: null, newType: true });
      return res.status(200).json({ prefix, year, preview: await peekCode(db, prefix, year), newType: false });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const explicit = String(body.prefix || '').trim().toUpperCase();
      const prefix = explicit || (body.programType ? await prefixForType(db, body.programType) : null);
      if (!prefix) return res.status(400).json({ error: 'no prefix for that Program Type — supply one' });
      const year = resolveYear(body.startDate, body.year);
      return res.status(200).json({ code: await nextCode(db, prefix, year), prefix, year });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
