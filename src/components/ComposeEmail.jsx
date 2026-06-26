import { useState, useEffect } from 'react'
import './ComposeEmail.css'

// Compose + send an email as the logged-in user (via /api/google → their
// Gmail). Open it with an `initial` of { to, cc, subject, body, attachments }.
// attachments: [{ filename, mimeType, base64 }].
export default function ComposeEmail({ initial = {}, fromLabel, onClose, onSent }) {
  const [to, setTo] = useState(initial.to || '')
  const [cc, setCc] = useState(initial.cc || '')
  const [subject, setSubject] = useState(initial.subject || '')
  const [body, setBody] = useState(initial.body || '')
  const [status, setStatus] = useState(null) // null | 'sending' | 'sent' | 'error'
  const [error, setError] = useState('')
  const attachments = initial.attachments || []

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape' && status !== 'sending') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, status])

  async function send() {
    if (!to.trim() || !subject.trim()) { setError('To and Subject are required.'); setStatus('error'); return }
    setStatus('sending'); setError('')
    try {
      const r = await fetch('/api/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'gmail.send', to: to.trim(), cc: cc.trim() || undefined, subject, bodyText: body, attachments }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.error || 'Send failed')
      setStatus('sent')
      onSent?.(data)
      setTimeout(onClose, 900)
    } catch (e) {
      setError(e.message || 'Send failed'); setStatus('error')
    }
  }

  const busy = status === 'sending' || status === 'sent'

  return (
    <div className="cm-backdrop" onClick={e => e.target === e.currentTarget && status !== 'sending' && onClose()}>
      <div className="cm-panel">
        <div className="cm-header">
          <h3>New email{fromLabel ? <span className="cm-from"> · from {fromLabel}</span> : null}</h3>
          <button className="cm-close" onClick={onClose} disabled={status === 'sending'}>✕</button>
        </div>
        <div className="cm-body">
          <label className="cm-field"><span>To</span><input value={to} onChange={e => setTo(e.target.value)} placeholder="name@example.com" /></label>
          <label className="cm-field"><span>Cc</span><input value={cc} onChange={e => setCc(e.target.value)} placeholder="optional" /></label>
          <label className="cm-field"><span>Subject</span><input value={subject} onChange={e => setSubject(e.target.value)} /></label>
          <label className="cm-field wide"><span>Message</span><textarea value={body} onChange={e => setBody(e.target.value)} rows={9} /></label>
          {attachments.length > 0 && (
            <div className="cm-attach">📎 {attachments.map(a => a.filename).join(', ')}</div>
          )}
        </div>
        <div className="cm-footer">
          {status === 'error' && <span className="cm-error">{error}</span>}
          {status === 'sent' && <span className="cm-ok">✓ Sent</span>}
          <button className="cm-btn cancel" onClick={onClose} disabled={status === 'sending'}>Cancel</button>
          <button className="cm-btn send" onClick={send} disabled={busy}>{status === 'sending' ? 'Sending…' : 'Send'}</button>
        </div>
      </div>
    </div>
  )
}
