import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';

// Serves the in-app Help page's content, sourced live from a Google Doc so it
// can be edited outside the app (see Vibe — Detailed User Guide). Any signed-in
// user's Google token can read it — the Doc is shared "anyone with the link" —
// we just need a valid OAuth token to call the Drive API with, same pattern
// agent.js already uses for its Drive tool actions.
const HELP_DOC_ID = '1iokkSOMjp0VQHpcmtW50gYaWdykTgo2g6gptP7sYmi4';
const CACHE_KEY = 'help_doc_html';
const CACHE_TTL = 300; // 5 min — long enough to spare repeat Help opens a fetch, short enough that edits show up promptly

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session?.accessToken) return res.status(401).json({ error: 'Not authenticated' });

  const redis = Redis.fromEnv();
  const cached = await redis.get(CACHE_KEY).catch(() => null);
  if (cached) return res.json({ html: cached, cached: true });

  try {
    const url = `https://www.googleapis.com/drive/v3/files/${HELP_DOC_ID}/export?mimeType=${encodeURIComponent('text/html')}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${session.accessToken}` } });
    if (!r.ok) return res.status(502).json({ error: `Could not fetch Help doc (${r.status})` });
    const html = await r.text();
    await redis.set(CACHE_KEY, html, { ex: CACHE_TTL }).catch(() => {});
    return res.json({ html, cached: false });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Could not fetch Help doc' });
  }
}
