import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const fmpHost = env.VITE_FMP_HOST || 'https://ILELLCO.pcifmhosting.com'

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/fmi': { target: fmpHost, changeOrigin: true, secure: true },
        '/Streaming_SSL': { target: fmpHost, changeOrigin: true, secure: true },
      },
    },
  }
})
