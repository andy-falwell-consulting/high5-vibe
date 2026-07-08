import { useState } from 'react'
import './ReadOnlyBanner.css'

// Persistent strip across the top of the app when the logged-in user has no
// matching FileMaker account — writes are hard-blocked in this state (see
// getToken in api/filemaker.js), so this tells them plainly rather than
// letting them discover it only when a save silently fails.
export default function ReadOnlyBanner({ onRetry }) {
  const [retrying, setRetrying] = useState(false)
  const [justFailed, setJustFailed] = useState(false)

  async function handleRetry() {
    setRetrying(true); setJustFailed(false)
    const ok = await onRetry()
    setRetrying(false)
    if (!ok) { setJustFailed(true); setTimeout(() => setJustFailed(false), 3000) }
  }

  return (
    <div className="rob-bar">
      <span className="rob-icon">👁</span>
      <span className="rob-text">
        <strong>Read-only mode</strong> — your FileMaker account isn't connected, so changes won't be saved.
      </span>
      <button className="rob-retry" onClick={handleRetry} disabled={retrying}>
        {retrying ? 'Checking…' : justFailed ? 'Still not connected' : 'Retry'}
      </button>
    </div>
  )
}
