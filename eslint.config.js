import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    // Serverless API functions run on Node, not in the browser.
    files: ['api/**/*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // The service worker runs in its own global scope — `self`, `caches`,
    // `clients` and friends are not window globals.
    files: ['src/sw.js'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        // Replaced with real values at build time by serviceWorker() in
        // vite.config.js — this file is emitted, not bundled.
        __SW_VERSION__: 'readonly',
        __PRECACHE__: 'readonly',
      },
    },
  },
])
