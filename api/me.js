import { getGoogleSession } from './_googleSession.js';

// FileMaker per-user write token (Option 1). When called with ?fmpDb=<db>, also
// mint a Data API token by Basic-authing as the user's internal FileMaker
// account (name = their email, password = shared server secret). Folded into
// /api/me to stay under the Hobby-plan serverless-function limit. The token is
// used for writes only so edits are attributed to the real person; if the user
// has no FileMaker account it's simply omitted and the app falls back to admin.
const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const ALLOWED_DBS = new Set(['High5_Core4_Dev', 'High5_Core4_Stage', 'High5_Core4']);

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const out = {
    userId: session.userId,
    email: session.email,
    name: session.name,
    picture: session.picture,
  };

  const db = String(req.query.fmpDb || '');
  if (db && ALLOWED_DBS.has(db) && process.env.FMP_USER_PASSWORD) {
    try {
      const auth = Buffer.from(`${session.email}:${process.env.FMP_USER_PASSWORD}`).toString('base64');
      const r = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${db}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
        body: '{}',
      });
      const data = await r.json().catch(() => ({}));
      if (data?.response?.token) out.fmpToken = data.response.token;
    } catch { /* no FM account / unreachable — client falls back to admin */ }
  }

  return res.json(out);
}
