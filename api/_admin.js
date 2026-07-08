// Shared admin-access helper — imported by api/me.js and api/admin-users.js.
// Files starting with _ are not treated as Vercel API routes.
//
// Two tiers, so the owner can never be locked out:
//  - ADMIN_EMAILS env var (Vercel) — permanent, always-admin, not editable via
//    the UI (there's nothing in Redis to remove for these).
//  - Redis set `admin_emails` — additional admins added/removed via the
//    Admin > FMP tab. Safe to wipe; the env-seeded set still gets in.
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const KEY = 'admin_emails';

const norm = e => String(e || '').trim().toLowerCase();

function envAdmins() {
  return new Set(String(process.env.ADMIN_EMAILS || '').split(',').map(norm).filter(Boolean));
}

export async function isAdminEmail(email) {
  const e = norm(email);
  if (!e) return false;
  if (envAdmins().has(e)) return true;
  try { return !!(await redis.sismember(KEY, e)); } catch { return false; }
}

// { env: [...permanent, not removable], dynamic: [...added via UI, removable] }
export async function listAdminEmails() {
  const env = [...envAdmins()].sort();
  let dynamic = [];
  try { dynamic = (await redis.smembers(KEY)).sort(); } catch { /* Redis unreachable — env set still works */ }
  return { env, dynamic };
}

export async function addAdminEmail(email) {
  const e = norm(email);
  if (!e || !e.includes('@')) throw new Error('Enter a valid email address');
  await redis.sadd(KEY, e);
  return e;
}

export async function removeAdminEmail(email) {
  const e = norm(email);
  if (!e) return;
  await redis.srem(KEY, e);
}
