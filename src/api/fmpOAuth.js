// FileMaker Data API OAuth login (Google) for per-user write attribution.
//
// Host reality (pcifmhosting.com, nginx-fronted), verified live:
//   - Data API app-type (9) is BLOCKED for /oauth/getoauthurl (400/25000).
//   - WebDirect app-type (7) works, BUT it does NOT honor X-FMS-Return-URL — it
//     renders the identifier as JSON on FileMaker's own /oauth/redirect page
//     instead of bouncing the browser back to our callback. So the automatic
//     popup→postMessage capture can't work on this host today.
//
// Until PCI enables a return-URL redirect (or Data API OAuth), we use a manual
// bridge: open the Google login popup, the user copies the `identifier` value
// from the JSON FileMaker shows, and we exchange it for a user-bound token.
//
// Flow:
//   1. GET /oauth/getoauthurl (app-type 7) → Google auth URL + X-FMS-Request-ID
//   2. popup → Google → FileMaker shows { data: { identifier }, result: 0 }
//   3. POST /fmi/.../sessions with the request id + identifier → user token

import { getCurrentEnv } from '../config/fmpEnvironments'
import { setFmpUserSession } from './filemaker'

const APP_TYPE = '7'        // WebDirect (Data API app-type 9 is blocked on this host)
const APP_VERSION = '15'
const PROVIDER = 'googlecustom'  // custom OIDC IdP name in FMS (replaced built-in "Google")

function hostAddress() {
  try { return new URL(getCurrentEnv().host).host } catch { return '' }
}

// Step 1+2: get the auth URL, open the popup. Returns the request id needed to
// complete the exchange.
export async function startFmpConnect() {
  const addr = hostAddress()
  const returnUrl = `${window.location.origin}/fmp-oauth-callback.html`
  const res = await fetch(
    `/oauth/getoauthurl?trackingID=${Date.now()}&provider=${encodeURIComponent(PROVIDER)}&address=${encodeURIComponent(addr)}&X-FMS-OAuth-AuthType=2`,
    { headers: {
      'X-FMS-Application-Type': APP_TYPE,
      'X-FMS-Application-Version': APP_VERSION,
      'X-FMS-Return-URL': returnUrl,
    } }
  )
  const requestId = res.headers.get('x-fms-request-id')
  const authUrl = (await res.text()).trim()
  if (!requestId || !/^https?:\/\//.test(authUrl)) {
    throw new Error(`Could not start FileMaker sign-in (HTTP ${res.status}, result ${res.headers.get('x-fms-result') || '?'})`)
  }
  const popup = window.open(authUrl, 'fmp_oauth', 'width=520,height=660')
  if (!popup) throw new Error('Popup blocked — allow popups for this site and try again')
  return { requestId }
}

// Step 3: exchange the request id + identifier for a user-bound Data API token.
// `identifier` is the value the user copies from FileMaker's JSON page, or one
// extracted automatically if the callback ever postMessages it.
export async function completeFmpConnect(requestId, identifier, displayName) {
  const env = getCurrentEnv()
  const id = String(identifier || '').trim()
  if (!requestId) throw new Error('No request in progress — start sign-in again')
  if (!id) throw new Error('Paste the identifier value first')

  const s = await fetch(`/fmi/data/v2/databases/${env.db}/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-FM-Data-OAuth-Request-Id': requestId,
      'X-FM-Data-OAuth-Identifier': id,
    },
    body: '{}',
  })
  const data = await s.json().catch(() => ({}))
  const token = data?.response?.token
  if (!token) {
    throw new Error(data?.messages?.[0]?.message || `FileMaker rejected the sign-in (HTTP ${s.status})`)
  }
  setFmpUserSession(token, displayName)
  return { token, name: displayName }
}
