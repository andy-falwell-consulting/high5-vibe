import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = Redis.fromEnv();

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
].join(' ');

export default async function handler(req, res) {
  // Derive redirect URI from request host so the same code works on
  // staging and production without separate env vars.
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${proto}://${host}/api/google-callback`;

  const state = crypto.randomBytes(16).toString('hex');
  // Store redirectUri in state so the callback can use the same one.
  await redis.set(`oauth_state:${state}`, redirectUri, { ex: 600 });

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    state,
    access_type: 'offline',
    prompt: 'consent',   // always request refresh token
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
