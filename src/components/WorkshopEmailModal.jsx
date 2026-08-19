import { useState, useEffect } from 'react'
import { TEMPLATE_VERSIONS, previewEmail, sendEmail } from '../api/workshopEmail'
import './WorkshopEmailModal.css'

// Send a workshop e-mail to one registrant.
//
// Preview first, always. The message goes to a customer from a shared mailbox
// and cannot be recalled, so the exact subject, body and recipient are on screen
// before the Send button does anything — and the button says who it is going to.

export default function WorkshopEmailModal({ workshop, courseLabel, onClose, onSent }) {
  const [version, setVersion] = useState(workshop?.emailVersionSent || 'Training')
  const [preview, setPreview] = useState(null)
  // Starts true so the first paint reads "Building preview…" rather than
  // flashing an empty panel — the effect below cannot set it synchronously.
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [sentTo, setSentTo] = useState(null)
  const [to, setTo] = useState('')

  // Fetch first, then set state — a synchronous setState in an effect body
  // triggers a cascading render. Switching version re-previews, so the message
  // on screen always matches the version selected.
  useEffect(() => {
    let alive = true
    previewEmail(workshop.id, version)
      .then(p => {
        if (!alive) return
        setPreview(p); setTo(p.recipient?.address || ''); setError(null); setLoading(false)
      })
      .catch(e => { if (alive) { setError(e.message); setLoading(false) } })
    return () => { alive = false }
  }, [workshop.id, version])

  async function send() {
    setSending(true); setError(null)
    try {
      const r = await sendEmail(workshop.id, version, to)
      setSentTo(r.to)
      onSent?.(r.workshop)
    } catch (e) { setError(e.message) }
    finally { setSending(false) }
  }

  const alts = preview?.recipient?.alternatives || []

  return (
    <div className="wem-backdrop" onClick={e => e.target === e.currentTarget && !sending && onClose()}>
      <div className="wem-panel">
        <div className="wem-head">
          <div>
            <h2>Send workshop e-mail</h2>
            <div className="wem-sub">{workshop.contactName || 'Unassigned'} · {courseLabel}</div>
          </div>
          <button className="wem-x" onClick={onClose} disabled={sending}>✕</button>
        </div>

        {sentTo ? (
          <div className="wem-body">
            <div className="wem-sent">
              <div className="wem-sent-icon">✓</div>
              <p>Sent to <strong>{sentTo}</strong> from {preview?.from}.</p>
              <p className="wem-sub">Recorded on this registration.</p>
            </div>
            <div className="wem-foot"><button className="wem-btn" onClick={onClose}>Close</button></div>
          </div>
        ) : (
          <div className="wem-body">
            <label className="wem-field">
              <span>E-mail version</span>
              <select value={version} onChange={e => setVersion(e.target.value)} disabled={sending}>
                {TEMPLATE_VERSIONS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>

            {preview?.alreadySent && (
              <div className="wem-warn">
                A <strong>{preview.lastVersion}</strong> e-mail was already sent for this
                registration on {String(preview.alreadySent).split('T')[0]}. Sending again will
                deliver a second message.
              </div>
            )}

            <label className="wem-field">
              <span>To</span>
              <input type="email" value={to} onChange={e => setTo(e.target.value)}
                placeholder={loading ? 'Resolving…' : 'No address on file'} disabled={sending} />
            </label>
            {alts.length > 0 && (
              <div className="wem-alts">
                Also on file:{' '}
                {alts.map(a => (
                  <button key={a} className="wem-alt" onClick={() => setTo(a)} disabled={sending}>{a}</button>
                ))}
              </div>
            )}

            {loading ? <div className="wem-loading">Building preview…</div>
              : preview?.templateMissing ? (
                <div className="wem-warn">
                  The <strong>{version}</strong> template has not been written yet.
                  An admin can add it under Admin → Workshop e-mails.
                </div>
              ) : preview?.rendered ? (
                <div className="wem-preview">
                  <div className="wem-preview-head">
                    <span className="wem-from">From {preview.from}</span>
                    <span className="wem-subject">{preview.rendered.subject || '(no subject)'}</span>
                  </div>
                  <pre className="wem-preview-body">{preview.rendered.body}</pre>
                  {preview.rendered.attachments?.length > 0 && (
                    <div className="wem-attach">
                      {preview.rendered.attachments.length} attachment
                      {preview.rendered.attachments.length === 1 ? '' : 's'}
                    </div>
                  )}
                </div>
              ) : null}

            {error && <div className="wem-error">{error}</div>}

            <div className="wem-foot">
              <button className="wem-btn wem-btn--ghost" onClick={onClose} disabled={sending}>Cancel</button>
              <button className="wem-btn wem-btn--go" onClick={send}
                disabled={sending || loading || !to || preview?.templateMissing}>
                {sending ? 'Sending…' : to ? `Send to ${to}` : 'Send'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
