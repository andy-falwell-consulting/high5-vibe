// Registering the service worker, and deciding when a new one takes over.
//
// The second half is the part that matters. A precached app shell means the
// build a device is running is the build it cached, so "I pushed it but I'm not
// seeing it" becomes possible in a way it never was before. Three rules keep
// that honest:
//
//   1. A new worker is told to SKIP_WAITING the moment it has installed, so it
//      is ready — but the page is NOT reloaded underneath someone. The new
//      build is live on their next load, which is how the app behaved before
//      any of this existed.
//   2. `applyUpdateNow()` exists for the one case where waiting is wrong:
//      "Take offline", where a crew is about to drive somewhere with no signal
//      and should not carry last week's build.
//   3. Nothing is registered in development, and nothing is registered on
//      localhost, where a stale precache is purely an obstacle.
//
// `isControlled()` answers a question "Take offline" has to ask: a worker only
// controls pages loaded AFTER it activated, so on the very first visit the app
// is installed but not yet in charge, and closing the lid at that moment would
// mean arriving at a site with nothing cached.

let waitingWorker = null;
const listeners = new Set();

const notify = () => { for (const fn of listeners) { try { fn(!!waitingWorker); } catch { /* a listener must not break the rest */ } } };

/** Subscribe to "a newer build is installed and ready". Returns an unsubscribe. */
export function onUpdateReady(fn) {
  listeners.add(fn);
  fn(!!waitingWorker);
  return () => listeners.delete(fn);
}

/** Is a service worker actually in charge of this page right now? */
export function isControlled() {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && !!navigator.serviceWorker.controller;
}

/** Take the newest build now and reload onto it. */
export async function applyUpdateNow() {
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return false;
  await reg.update().catch(() => {});
  const waiting = reg.waiting || waitingWorker;
  if (!waiting) return false;
  await new Promise(resolve => {
    // controllerchange fires once the waiting worker has taken over.
    navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
    waiting.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(resolve, 3000);   // never hang a button on an event that didn't come
  });
  window.location.reload();
  return true;
}

/**
 * Ask the browser to stop treating this origin's storage as disposable.
 *
 * Safari does not prompt and mostly answers false, which is why the Home-screen
 * install matters more than this call does — an installed web app is exempt
 * from the 7-day eviction that would otherwise throw away a queued field day.
 * Cheap, so it is asked for anyway.
 */
export async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}

/** Bytes used and available, for the storage line in "Take offline". */
export async function storageEstimate() {
  try {
    const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) || {};
    return { usage, quota };
  } catch { return { usage: 0, quota: 0 }; }
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  // Off on localhost, where a stale precache is purely an obstacle — except
  // when it is the thing being tested. A service worker needs a secure context,
  // so localhost is the ONLY place it can be exercised without deploying;
  // without this escape hatch the offline shell could not be checked at all
  // before it reached an iPad in a field.
  //   localStorage.setItem('vibe:sw-local', '1')   then reload, on a built app
  const localTest = (() => { try { return localStorage.getItem('vibe:sw-local') === '1'; } catch { return false; } })();
  if (!localTest && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      // Already waiting when the page loaded — a build that installed during
      // the last visit and never got taken up.
      if (reg.waiting) { waitingWorker = reg.waiting; notify(); reg.waiting.postMessage({ type: 'SKIP_WAITING' }); }

      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          // `controller` distinguishes an update from the very first install:
          // with no controller this IS the first one, and there is nothing to
          // announce.
          if (next.state === 'installed' && navigator.serviceWorker.controller) {
            waitingWorker = next;
            notify();
            next.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });

      // A tab left open for days should still notice a deploy.
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => { /* registration failing must never take the app down */ });
  });
}
