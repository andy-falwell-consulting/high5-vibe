// QBO OAuth callback — Intuit redirects here with ?code&realmId&state. Exchanges
// the authorization code for tokens (server-side, using the app's client
// secret) and stores the refresh token in Redis so getAccessToken(env) uses it.
// No token value ever passes through the browser or chat.
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  const { code, realmId, state, error } = req.query || {};
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
    return res.status(502).send('Token exchange failed: ' + JSON.stringify(tok).slice(0, 400));
  }

  const rk = env === 'sandbox' ? 'qbo_sandbox_refresh_token' : 'qbo_refresh_token';
  const ak = env === 'sandbox' ? 'qbo_sandbox_access_token' : 'qbo_access_token';
  await redis.set(rk, tok.refresh_token, { ex: 86400 * 90 });
  await redis.set(ak, tok.access_token, { ex: 55 * 60 });

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`<div style="font-family:system-ui;padding:40px;max-width:520px;margin:auto">
    <h2>✓ Connected ${env} QuickBooks</h2>
    <p>Realm <b>${realmId || '(n/a)'}</b>. Refresh token stored. You can close this tab and tell Claude to re-test.</p></div>`);
}
