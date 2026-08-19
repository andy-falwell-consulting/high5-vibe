// Google service-account auth. Files starting with _ are not Vercel routes.
//
// WHY THIS EXISTS
// The nightly backup can't ride a human's OAuth token. This app's consent
// screen is in "Testing" publishing status, and Google expires refresh tokens
// for Testing-status apps after 7 days — the same rule that already forces the
// preview fallback session to be re-captured weekly. A cron on that credential
// would fail silently about once a week, which is the worst possible failure
// mode for a backup.
//
// A service account sidesteps user OAuth entirely: sign a JWT with the private
// key, exchange it for a short-lived access token. No consent screen, no
// refresh token, no publishing status, nothing to expire.
//
// Env:
//   GDRIVE_SA_EMAIL         the service account's client_email
//   GDRIVE_SA_PRIVATE_KEY   its private_key (PEM)
//   GDRIVE_SA_SUBJECT       optional — an account to impersonate via
//                           domain-wide delegation. Set this when Workspace
//                           policy blocks adding an external service account
//                           to the Shared Drive; the account then acts as an
//                           internal user and needs no sharing at all.
import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive';
export const DRIVE_SCOPE = SCOPE;
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Vercel env vars store newlines escaped, so a pasted PEM arrives as one line
// containing a literal backslash-n. Left as-is the key fails to parse with a
// misleading "error:1E08010C:DECODER routines::unsupported".
function normalisePem(raw) {
  const s = String(raw || '').trim().replace(/^["']|["']$/g, '');
  return s.includes('\\n') ? s.replace(/\\n/g, '\n') : s;
}

export function serviceAccountConfigured() {
  return !!(process.env.GDRIVE_SA_EMAIL && process.env.GDRIVE_SA_PRIVATE_KEY);
}

// Cached until shortly before expiry — a backup run makes ~100 Drive calls and
// there is no sense minting a token for each.
//
// Keyed by scope AND subject, because a token is only valid for the pair it was
// minted with. A single shared slot was fine while Drive was the only caller;
// once mail-as-a-shared-address is also asking, one cache entry would hand a
// Drive token to a Gmail call and fail in a way that looks like a permissions
// problem rather than a caching one.
const cache = new Map();

export async function getServiceAccountToken({ force = false, scope = SCOPE, subject } = {}) {
  const email = process.env.GDRIVE_SA_EMAIL;
  const key = normalisePem(process.env.GDRIVE_SA_PRIVATE_KEY);
  const sub = subject || process.env.GDRIVE_SA_SUBJECT || undefined;
  const slot = `${scope}|${sub || ''}`;
  const hit = cache.get(slot);
  if (!force && hit && hit.expiresAt - Date.now() > 60_000) return hit.token;

  if (!email || !key) throw new Error('GDRIVE_SA_EMAIL / GDRIVE_SA_PRIVATE_KEY are not set');

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email,
    scope,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
    ...(sub ? { sub } : {}),
  }));

  let signature;
  try {
    signature = b64url(createSign('RSA-SHA256').update(`${header}.${claim}`).sign(key));
  } catch (e) {
    // Almost always a malformed PEM rather than anything to do with Google.
    throw new Error(`Could not sign with GDRIVE_SA_PRIVATE_KEY — check the PEM is complete and its newlines survived: ${e.message}`);
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const detail = body.error_description || body.error || `HTTP ${res.status}`;
    throw new Error(`Service account token request rejected: ${detail}`);
  }

  const entry = { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  cache.set(slot, entry);
  return entry.token;
}
