import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { nextCode, peekCode, prefixForType, surveyCodes } from './_programCode.js';

// Program Codes for OE Lookups.
//
//   GET  /api/program-code?db=…&programType=Adventure%20Basics
//        -> { prefix, preview }            — read-only, consumes nothing
//   GET  /api/program-code?db=…&prefixes=1
//        -> { prefixes: [{ prefix, max }] } — for picking one on a NEW type
//   POST /api/program-code?db=…  { programType } | { prefix }
//        -> { code }                        — CONSUMES the next number
//
// GET and POST are split deliberately. The form shows the code it is about to
// assign while you are still typing, and doing that with the consuming call
// would burn a number on every keystroke and every abandoned form.

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  try {
    if (req.method === 'GET') {
      if (req.query?.prefixes === '1') {
        const { maxByPrefix } = await surveyCodes(db);
        const prefixes = [...maxByPrefix.entries()]
          .map(([prefix, max]) => ({ prefix, max }))
          .sort((a, b) => a.prefix.localeCompare(b.prefix));
        return res.status(200).json({ prefixes });
      }
      const programType = String(req.query?.programType || '');
      const explicit = String(req.query?.prefix || '').trim().toUpperCase();
      const prefix = explicit || (programType ? await prefixForType(db, programType) : null);
      // A Program Type nobody has used before has no prefix to infer. Say so
      // rather than guessing from initials — the caller asks for one.
      if (!prefix) return res.status(200).json({ prefix: null, preview: null, newType: true });
      return res.status(200).json({ prefix, preview: await peekCode(db, prefix), newType: false });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const explicit = String(body.prefix || '').trim().toUpperCase();
      const prefix = explicit || (body.programType ? await prefixForType(db, body.programType) : null);
      if (!prefix) return res.status(400).json({ error: 'no prefix for that Program Type — supply one' });
      return res.status(200).json({ code: await nextCode(db, prefix), prefix });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
