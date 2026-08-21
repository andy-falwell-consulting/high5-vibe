// The last identity `/api/me` returned, kept so the app can open without one.
//
// WHAT THIS IS NOT: authority. The session is an httpOnly cookie with a 30-day
// TTL in Redis, and every API call is authenticated server-side against it.
// Nothing here grants access to anything — a device holding a remembered
// identity but no valid cookie gets a 401 from the first request it makes, the
// same as it always did. This exists so that an iPad in a field with no signal
// shows the app instead of the login screen, because the only thing missing at
// that moment is the network to CHECK a session, not the session.
//
// `isAdmin` is deliberately dropped on the way out. It is a display flag — the
// admin endpoints check it themselves — and an offline device has no way to
// reach anything it would unlock, so there is no reason for a cached copy to
// turn admin UI on for whoever is holding the iPad.

const KEY = 'vibe:last-identity';

export function rememberIdentity(user) {
  if (!user?.email) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({
      userId: user.userId, email: user.email, name: user.name, picture: user.picture, at: Date.now(),
    }));
  } catch { /* private mode — the app simply won't boot offline */ }
}

/** The remembered identity, marked so every caller can tell it apart. */
export function lastIdentity() {
  try {
    const u = JSON.parse(localStorage.getItem(KEY));
    return u?.email ? { ...u, isAdmin: false, offline: true } : null;
  } catch { return null; }
}

/** Called on a real 401: signed out is signed out, on this device too. */
export function forgetIdentity() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
}
