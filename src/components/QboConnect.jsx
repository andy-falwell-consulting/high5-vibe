import { useState, useEffect, useCallback } from 'react';
import './QboConnect.css';

// QuickBooks connection status + Connect/Reconnect button, mirroring
// ShopifyConnect. Reads the read-only health check (GET /api/qbo) and starts
// Intuit's OAuth consent via /api/qbo-auth.
//
// Worth having a light on this: QBO refresh tokens expire, and when they do
// every QBO path fails silently on its cron (invoice mirror, estimate status
// sync) with nothing surfaced in the UI.
export default function QboConnect() {
  const [status, setStatus] = useState(undefined); // undefined = loading
  const [toast, setToast] = useState(null);

  const check = useCallback(() => {
    return fetch('/api/qbo')
      .then(r => (r.ok ? r.json() : { unreachable: true }))
      .catch(() => ({ unreachable: true }));
  }, []);

  useEffect(() => {
    let alive = true;
    const p = new URLSearchParams(window.location.search);
    if (p.get('qbo')) {
      const t = p.get('qbo') === 'connected'
        ? { ok: true, text: 'Connected to QuickBooks' }
        : { ok: false, text: `Connect failed: ${p.get('reason') || 'error'}` };
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time OAuth return handling
      setToast(t);
      p.delete('qbo'); p.delete('reason'); p.delete('env');
      const qs = p.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
      setTimeout(() => { if (alive) setToast(null); }, 5000);
    }
    check().then(s => { if (alive) setStatus(s); });
    return () => { alive = false; };
  }, [check]);

  const connected = status?.ok === true;
  const expired = status?.reason === 'expired';
  const state = status === undefined ? 'loading'
    : connected ? 'on'
    : status?.unreachable ? 'unknown' : 'off';

  const label = status === undefined ? 'Checking QuickBooks…'
    : connected ? `QuickBooks connected${status.realmId ? ` · realm ${status.realmId}` : ''}`
    : status.unreachable ? 'QuickBooks status unavailable'
    : expired ? 'QuickBooks token expired — reconnect to restore syncing'
    : 'QuickBooks not connected';

  return (
    <div className="qbo-connect">
      <div className="qc-row">
        <span className={`qc-dot ${state}`} />
        <span className="qc-label" title={status?.detail || label}>{label}</span>
        {status !== undefined && !status?.unreachable && (
          <button className="qc-btn" onClick={() => { window.location.href = '/api/qbo-auth?env=production'; }}>
            {connected ? 'Reconnect' : 'Connect'}
          </button>
        )}
      </div>
      {expired && (
        <p className="qc-note">
          Invoice mirroring and estimate status sync stay stopped until this is reconnected.
        </p>
      )}
      {toast && <div className={`qc-toast ${toast.ok ? 'ok' : 'err'}`}>{toast.text}</div>}
    </div>
  );
}
