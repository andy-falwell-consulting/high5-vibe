// Kicks off the QBO OAuth connect flow. Visit in a browser while signed into
// Belay: /api/qbo-auth?env=sandbox  (or ?env=production to re-auth prod).
// Redirects to Intuit consent; the callback exchanges the code + stores the
// refresh token in Redis. The registered redirect URI must be this host's
// /api/qbo-callback (add it to the Intuit app's redirect URIs).
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (!(await getGoogleSession(req))) return res.status(401).send('Sign in to Belay first, then open this link again.');
  const env = req.query?.env === 'sandbox' ? 'sandbox' : 'production';
  const clientId = env === 'sandbox' ? process.env.QBO_SANDBOX_CLIENT_ID : process.env.QBO_CLIENT_ID;
  if (!clientId) return res.status(500).send(`Missing ${env} client id`);

  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const redirectUri = `${proto}://${req.headers.host}/api/qbo-callback`;
  const state = 'qbo_oauth:' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  await redis.set(state, env, { ex: 600 });

  const url = 'https://appcenter.intuit.com/connect/oauth2'
    + `?client_id=${encodeURIComponent(clientId)}`
    + '&response_type=code'
    + `&scope=${encodeURIComponent('com.intuit.quickbooks.accounting')}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(state)}`;
  res.writeHead(302, { Location: url });
  res.end();
}
