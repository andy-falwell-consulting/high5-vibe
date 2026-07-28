import { useState, useEffect } from 'react'
import './QboHealthBanner.css'

// Shown to admins when the daily health check (api/qbo-health.js) has found the
// QuickBooks connection broken. Reads the recorded state rather than testing
// live, so this costs one cheap Redis read on load instead of a token exchange.
//
// This exists because the connection died once and stayed dead for about a
// week — invoice mirroring and estimate status sync failing every 15 minutes
// with nothing visible anywhere in the app.
export default function QboHealthBanner({ isAdmin }) {
  const [health, setHealth] = useState(null)
  const [now] = useState(() => Date.now()) // captured once — fine for a coarse "N days" display

  useEffect(() => {
    if (!isAdmin) return
    let alive = true
    fetch('/api/qbo-health?peek=1')
      .then(r => (r.ok ? r.json() : null))
      .then(h => { if (alive) setHealth(h) })
      .catch(() => {})
    return () => { alive = false }
  }, [isAdmin])

  if (!isAdmin || !health || health.ok !== false) return null

  const days = health.brokenSince
    ? Math.max(0, Math.floor((now - new Date(health.brokenSince).getTime()) / 86400000))
    : null
  const howLong = days == null ? '' : days >= 1 ? ` for ${days} day${days === 1 ? '' : 's'}` : ' since today'

  return (
    <div className="qhb-bar">
      <span className="qhb-icon">⚠</span>
      <span className="qhb-text">
        <strong>QuickBooks is disconnected{howLong}.</strong>{' '}
        Invoice mirroring and estimate status sync are stopped until it's reconnected.
      </span>
      <a className="qhb-btn" href="#admin">Fix in Admin →</a>
    </div>
  )
}
