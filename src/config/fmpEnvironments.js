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
const DEFAULT_ENV = import.meta.env.VITE_FMP_ENV ?? 'development'

export function getCurrentEnvId() {
  return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_ENV
}

export function getCurrentEnv() {
  const id = getCurrentEnvId()
  return FMP_ENVIRONMENTS.find((e) => e.id === id) ?? FMP_ENVIRONMENTS[0]
}

export function setCurrentEnvId(id) {
  localStorage.setItem(STORAGE_KEY, id)
}
