import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'))

// Emits `sw.js` with the real, content-hashed asset names baked in.
//
// This is the only part of a precache that cannot be hand-written: the rest of
// the service worker is policy (src/sw.js), but the list of files to cache is
// whatever this build happened to emit. Fifteen lines here rather than three
// new dependencies to have Workbox generate the same array.
//
// Build-only. In `vite dev` there is no service worker at all, which is the
// right default — a stale precache is a miserable thing to debug locally, and
// /api doesn't run there anyway.
function serviceWorker() {
  // Everything under public/ that the shell needs to render. Listed explicitly:
  // public/ also holds things a cold start does not need, and a precache that
  // quietly grows is a precache nobody trusts.
  const STATIC = [
    '/index.html',
    '/manifest.webmanifest',
    '/favicon.svg',
    '/icons.svg',
    '/apple-touch-icon.png',
    '/icon-192.png',
    '/icon-512.png',
    '/icon-512-maskable.png',
  ]

  return {
    name: 'h5-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const emitted = Object.keys(bundle)
        .filter(f => f.endsWith('.js') || f.endsWith('.css'))
        .map(f => `/${f}`)
        .sort()

      const precache = [...STATIC, ...emitted]

      // The version keys the cache. package.json's version alone is not enough:
      // two builds of the same version (a preview push, then a fix) would share
      // a cache name and the second would serve the first's assets.
      const stamp = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 8)

      const source = readFileSync('./src/sw.js', 'utf-8')
        .replace('__SW_VERSION__', JSON.stringify(`${version}-${stamp}`))
        .replace('__PRECACHE__', JSON.stringify(precache, null, 2))

      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const fmpHost = env.VITE_FMP_HOST || 'https://ILELLCO.pcifmhosting.com'

  return {
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [react(), serviceWorker()],
    server: {
      port: process.env.PORT ? parseInt(process.env.PORT) : undefined,
      proxy: {
        '/fmi': { target: fmpHost, changeOrigin: true, secure: true },
        '/Streaming_SSL': { target: fmpHost, changeOrigin: true, secure: true },
        // FileMaker OAuth (Data API per-user login) — provider discovery + auth-url.
        // Trailing slash on /oauth/ so it doesn't swallow /fmp-oauth-callback.html.
        '/oauth/': { target: fmpHost, changeOrigin: true, secure: true },
        '/fmws': { target: fmpHost, changeOrigin: true, secure: true },
      },
    },
  }
})
