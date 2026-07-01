// Shared QuickBooks Online core — token + request helpers. Imported by
// api/qbo.js (HTTP actions), the mirror jobs, and the write flows.
// Files starting with _ are not Vercel routes.
//
// Environment-aware: every helper takes an optional `env` ('production' |
// 'sandbox'), defaulting to 'production' so existing callers are unchanged.
// Sandbox uses the Intuit sandbox base URL + its own app keys / realm / token
// and separate Redis keys, so the two never cross-contaminate.
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const ENVS = {
  production: {
    host: 'https://quickbooks.api.intuit.com',
    realm: () => process.env.QBO_REALM_ID,
    clientId: () => process.env.QBO_CLIENT_ID,
    clientSecret: () => process.env.QBO_CLIENT_SECRET,
    refreshSeed: () => process.env.QBO_REFRESH_TOKEN,
    rk: 'qbo_refresh_token', ak: 'qbo_access_token',
  },
  sandbox: {
    host: 'https://sandbox-quickbooks.api.intuit.com',
    realm: () => process.env.QBO_SANDBOX_REALM_ID || process.env.QBO_REALM_ID,
    clientId: () => process.env.QBO_SANDBOX_CLIENT_ID,
    clientSecret: () => process.env.QBO_SANDBOX_CLIENT_SECRET,
    refreshSeed: () => process.env.QBO_SANDBOX_REFRESH_TOKEN,
    rk: 'qbo_sandbox_refresh_token', ak: 'qbo_sandbox_access_token',
  },
};
const cfg = env => ENVS[env] || ENVS.production;
export const qboBase = (env = 'production') => `${cfg(env).host}/v3/company/${cfg(env).realm()}`;

// Back-compat: production base URL as a constant (used by qbo.js / txn-pdf.js).
export const QBO_BASE = `https://quickbooks.api.intuit.com/v3/company/${process.env.QBO_REALM_ID}`;

export async function getAccessToken(env = 'production') {
  const c = cfg(env);
  const cached = await redis.get(c.ak);
  if (cached) return cached;
  const refreshToken = (await redis.get(c.rk)) || c.refreshSeed();
  if (!refreshToken) throw new Error(`QBO[${env}]: no refresh token configured`);
  const resp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${c.clientId()}:${c.clientSecret()}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const tokens = await resp.json();
  if (!resp.ok || !tokens.access_token) throw new Error(`QBO[${env}] token refresh failed: ${JSON.stringify(tokens)}`);
  await redis.set(c.rk, tokens.refresh_token, { ex: 86400 * 90 });
  await redis.set(c.ak, tokens.access_token, { ex: 55 * 60 });
  return tokens.access_token;
}

export async function qboRequest(path, method, body, env = 'production') {
  const token = await getAccessToken(env);
  const resp = await fetch(`${qboBase(env)}${path}?minorversion=65`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  return data;
}

// Run a QBO SQL query, returning the QueryResponse object.
export async function qboQuery(sql, env = 'production') {
  const token = await getAccessToken(env);
  const r = await fetch(`${qboBase(env)}/query?query=${encodeURIComponent(sql)}&minorversion=65`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data.QueryResponse || {};
}
