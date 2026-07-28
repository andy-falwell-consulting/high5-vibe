// QBO OAuth callback — Intuit redirects here with ?code&realmId&state. Exchanges
// the authorization code for tokens (server-side, using the app's client
// secret) and stores the refresh token in Redis so getAccessToken(env) uses it.
// No token value ever passes through the browser or chat.
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  const { code, state, error } = req.query || {};
  if (error) return res.status(400).send(`Intuit returned: ${error}`);
  if (!code || !state) return res.status(400).send('Missing code/state.');

  const env = await redis.get(String(state));
  if (!env) return res.status(400).send('State expired or invalid — restart from /api/qbo-auth.');
  await redis.del(String(state));

  const clientId = env === 'sandbox' ? process.env.QBO_SANDBOX_CLIENT_ID : process.env.QBO_CLIENT_ID;
  const clientSecret = env === 'sandbox' ? process.env.QBO_SANDBOX_CLIENT_SECRET : process.env.QBO_CLIENT_SECRET;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const redirectUri = `${proto}://${req.headers.host}/api/qbo-callback`;

  const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code), redirect_uri: redirectUri }),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.refresh_token) {
    // Bounce back to the Admin panel with the reason, same shape as the
    // success path, so the QuickBooks card can show a failure toast.
    // Query goes BEFORE the hash — the app is hash-routed, and anything after
    // `#` never reaches window.location.search where the card reads it.
    const why = encodeURIComponent(String(tok?.error || 'exchange-failed').slice(0, 80));
    return res.redirect(302, `/?qbo=failed&reason=${why}#admin`);
  }

  const rk = env === 'sandbox' ? 'qbo_sandbox_refresh_token' : 'qbo_refresh_token';
  const ak = env === 'sandbox' ? 'qbo_sandbox_access_token' : 'qbo_access_token';
  await redis.set(rk, tok.refresh_token, { ex: 86400 * 90 });
  await redis.set(ak, tok.access_token, { ex: 55 * 60 });

  // Return the user to the Admin panel rather than a dead-end page — the
  // QuickBooks card picks up ?qbo=connected and re-checks its status.
  res.redirect(302, `/?qbo=connected&env=${encodeURIComponent(env)}#admin`);
}
