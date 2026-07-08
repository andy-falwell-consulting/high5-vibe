// Manage the list of emails allowed to see the Admin panel — backs the
// Admin > FMP tab. GET is safe for any logged-in user (just reports whether
// THEY are an admin; only includes the full list when they are). POST
// (add/remove) requires the caller to already be an admin.
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail, listAdminEmails, addAdminEmail, removeAdminEmail } from './_admin.js';

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const admin = await isAdminEmail(session.email);

  if (req.method === 'GET') {
    if (!admin) return res.status(200).json({ isAdmin: false });
    const { env, dynamic } = await listAdminEmails();
    return res.status(200).json({ isAdmin: true, envEmails: env, emails: dynamic });
  }

  if (!admin) return res.status(403).json({ error: 'Admins only' });

  if (req.method === 'POST') {
    const { action, email } = req.body || {};
    try {
      if (action === 'add') {
        const e = await addAdminEmail(email);
        return res.status(200).json({ ok: true, email: e });
      }
      if (action === 'remove') {
        await removeAdminEmail(email);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'Unknown action' });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  return res.status(405).end();
}
