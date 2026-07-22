import { useState, useEffect, useRef } from 'react'
import { cleanGoogleDocHtml } from '../utils/cleanDocHtml'
import './Help.css'

// In-app Help / user guide. Content is fetched live from the "Vibe — Detailed
// User Guide" Google Doc (via /api/help-content) so Andy can edit it outside
// the app without a deploy — see cleanDocHtml.js for how the Doc's export is
// turned into safe, theme-aware HTML. Falls back to a link to the Doc itself
// on localhost (no serverless functions there) or if the fetch fails.
const DOC_URL = 'https://docs.google.com/document/d/1iokkSOMjp0VQHpcmtW50gYaWdykTgo2g6gptP7sYmi4/edit'

export default function Help() {
  const [state, setState] = useState({ status: 'loading', html: '', toc: [] })
  const [active, setActive] = useState(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    if (window.location.hostname === 'localhost') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no serverless functions locally, so there's nothing to await
      setState({ status: 'unavailable', html: '', toc: [] })
      return
    }
    fetch('/api/help-content')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(({ html }) => {
        if (!mounted.current) return
        const cleaned = cleanGoogleDocHtml(html)
        setState({ status: 'ready', html: cleaned.html, toc: cleaned.toc })
        setActive(cleaned.toc[0]?.id || null)
      })
      .catch(() => { if (mounted.current) setState({ status: 'error', html: '', toc: [] }) })
    return () => { mounted.current = false }
  }, [])

  const go = (id) => {
    setActive(id)
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="hlp-container">
      <aside className="hlp-toc">
        <div className="hlp-toc-title">Help &amp; guide</div>
        <nav>
          {state.toc.map(s => (
            <button key={s.id}
              className={`hlp-toc-link${active === s.id ? ' active' : ''}`}
              onClick={() => go(s.id)}>{s.title}</button>
          ))}
        </nav>
      </aside>

      <main className="hlp-main">
        <div className="hlp-content">
          {state.status === 'loading' && <p className="hlp-muted">Loading help…</p>}
          {state.status === 'unavailable' && (
            <p className="hlp-muted">Help content isn't available in local dev — it's served by a deployed
              function. <a href={DOC_URL} target="_blank" rel="noreferrer">Open the guide directly →</a></p>
          )}
          {state.status === 'error' && (
            <p className="hlp-muted">Couldn't load the latest Help content right now.
              <a href={DOC_URL} target="_blank" rel="noreferrer"> Open the guide directly →</a></p>
          )}
          {state.status === 'ready' && (
            <div className="hlp-doc" dangerouslySetInnerHTML={{ __html: state.html }} />
          )}
          <div className="hlp-footer">Vibe — High 5 Adventure Learning Center. Press <kbd>⌘K</kbd> anywhere to search or ask the assistant.</div>
        </div>
      </main>
    </div>
  )
}
