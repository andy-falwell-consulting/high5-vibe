export const FMP_ENVIRONMENTS = [
  {
    id: 'development',
    label: 'Development',
    host: 'https://ILELLCO.pcifmhosting.com',
    db: 'High5_Core4_Dev',
    user: 'admin',
    pass: 'itstime',
  },
  {
    id: 'staging',
    label: 'Staging',
    host: 'https://ILELLCO.pcifmhosting.com',
    db: 'High5_Core4_Stage',
    user: 'admin',
    pass: 'itstime',
  },
  {
    id: 'production',
    label: 'Production',
    host: 'https://ILELLCO.pcifmhosting.com',
    db: 'High5_Core4',
    user: 'admin',
    pass: 'itstime',
  },
]

const STORAGE_KEY = 'fmp_env'

// PRODUCTION, not development.
//
// This read `import.meta.env.VITE_FMP_ENV ?? 'development'`, and Vercel never
// set VITE_FMP_ENV — so the fallback applied and the DEPLOYED PRODUCTION BUNDLE
// defaulted to the Dev database. Confirmed by reading the live asset:
//
//     db-livid.vercel.app/assets/index-UvLFBgHs.js   …fmp_env`,S=`development`
//
// Anyone whose browser had never touched the environment picker was therefore
// reading High5_Core4_Dev on production, with no symptom other than quietly
// wrong data. getCurrentEnvId() returns the default WITHOUT persisting it, so
// there was no stored record of who was affected.
//
// The env var is gone rather than repointed: a default that depends on a
// variable nobody set is what caused this, and there is now only one right
// answer anyway.
const DEFAULT_ENV = 'production'

// Values that are no longer reachable from the UI. The picker was removed with
// this change, so a browser still holding 'development' or 'staging' would have
// been STUCK there permanently — the exact trap the default above created,
// preserved for anyone who had ever used the picker. Migrating on read is what
// makes the removal safe.
const RETIRED = new Set(['development', 'staging'])

export function getCurrentEnvId() {
  // An explicit ?env= wins, and DOES NOT PERSIST. This is the only remaining
  // way to reach Dev or Staging, kept because cutover is not done and someone
  // may still need to look at them.
  //
  // Deliberately not sticky: the query string survives hash navigation, so it
  // holds for as long as the URL carries it and is gone the moment someone
  // opens the app normally. Storing it would put the visitor right back in the
  // trap this change exists to close — pointed at a non-production database
  // with no visible indication and no control to get out.
  //
  // Delete this block and RETIRED together on the day FileMaker is retired.
  if (typeof window !== 'undefined') {
    const asked = new URLSearchParams(window.location.search).get('env')
    if (asked && FMP_ENVIRONMENTS.some(e => e.id === asked)) return asked
  }
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return DEFAULT_ENV
  if (RETIRED.has(stored)) {
    // Clear it rather than just ignoring it, so the migration happens once
    // instead of on every read.
    localStorage.setItem(STORAGE_KEY, DEFAULT_ENV)
    return DEFAULT_ENV
  }
  return stored
}

export function getCurrentEnv() {
  const id = getCurrentEnvId()
  return FMP_ENVIRONMENTS.find((e) => e.id === id) ?? FMP_ENVIRONMENTS[0]
}

export function setCurrentEnvId(id) {
  localStorage.setItem(STORAGE_KEY, id)
}
