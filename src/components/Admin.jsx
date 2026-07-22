import { useState, useEffect, useCallback } from 'react';
import ShopifyConnect from './ShopifyConnect';
import './Admin.css';

const TABS = [
  { id: 'integrations', label: 'Integrations' },
  { id: 'preview', label: 'Preview access' },
  { id: 'fmp', label: 'FMP' },
];

function IntegrationsTab() {
  return (
    <section className="admin-section">
      <h2 className="admin-section-title">Integrations</h2>
      <div className="admin-cards">
        <div className="admin-card">
          <div className="admin-card-head">
            <span className="admin-card-icon">◫</span>
            <div className="admin-card-meta">
              <div className="admin-card-title">Shopify</div>
              <div className="admin-card-desc">Connect the store to sync products and prices.</div>
            </div>
          </div>
          <ShopifyConnect />
        </div>
      </div>
    </section>
  );
}

// Captures the current admin's own login as the shared fallback session that
// the preview deployment falls back to when a visitor has no login of their
// own (see api/_googleSession.js / api/admin-set-fallback-session.js).
// Google expires refresh tokens for this unverified (Testing mode) OAuth app
// after 7 days, so this needs re-running roughly weekly, not just once.
function PreviewAccessTab() {
  const [meta, setMeta] = useState(undefined); // undefined = loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [justCaptured, setJustCaptured] = useState(false);
  const [now] = useState(() => Date.now()); // captured once — fine for a coarse "Nd ago" display

  const load = useCallback(() => {
    fetch('/api/admin-set-fallback-session')
      .then(r => r.json())
      .then(d => setMeta(d.meta || null))
      .catch(() => setMeta(null));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function capture() {
    setBusy(true); setError(null); setJustCaptured(false);
    try {
      const res = await fetch('/api/admin-set-fallback-session', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not capture session');
      setMeta(body.meta);
      setJustCaptured(true);
      setTimeout(() => setJustCaptured(false), 3000);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const capturedDate = meta?.capturedAt ? new Date(meta.capturedAt) : null;
  const daysAgo = capturedDate ? Math.floor((now - capturedDate.getTime()) / 86400000) : null;
  const stale = daysAgo != null && daysAgo >= 6;

  return (
    <section className="admin-section">
      <h2 className="admin-section-title">Preview access</h2>
      <p className="admin-sub" style={{ marginBottom: 16, maxWidth: 560 }}>
        The rolling <code>preview</code> deployment can let anyone with the link in without signing
        in, using a stored copy of your own login. Click below (while signed in normally) to
        capture — or refresh — that stored session. Google expires it after about a week, so this
        needs redoing periodically, not just once.
      </p>

      <div className="admin-cards">
        <div className="admin-card">
          <div className="admin-card-head">
            <span className="admin-card-icon">🔓</span>
            <div className="admin-card-meta">
              <div className="admin-card-title">Fallback session</div>
              <div className="admin-card-desc">
                {meta === undefined ? 'Loading…' : !meta
                  ? 'Not set up yet — preview requires a real login until this is captured.'
                  : <>Captured {daysAgo === 0 ? 'today' : `${daysAgo}d ago`} by {meta.capturedBy}
                      {stale && <span style={{ color: '#f59e0b' }}> — likely expired, recapture it</span>}</>}
              </div>
            </div>
          </div>
          <button
            onClick={capture}
            disabled={busy}
            style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#e87722', color: '#fff', fontSize: 15, fontWeight: 600, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit', opacity: busy ? 0.6 : 1 }}
          >
            {busy ? 'Capturing…' : justCaptured ? '✓ Captured' : meta ? 'Recapture my session' : 'Capture my session'}
          </button>
          {error && <div className="admin-email-error">{error}</div>}
        </div>
      </div>
    </section>
  );
}

// Manage which emails are allowed to see the Admin panel. Backed by
// /api/admin-users (GET status/list, POST add/remove).
function FmpTab() {
  const [data, setData] = useState(undefined); // undefined = loading
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    fetch('/api/admin-users')
      .then(r => r.json())
      .then(setData)
      .catch(() => setData({ isAdmin: false }));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function addEmail(e) {
    e.preventDefault();
    const email = input.trim();
    if (!email) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/admin-users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', email }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not add');
      setInput('');
      load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function removeEmail(email) {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/admin-users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', email }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not remove');
      load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (data === undefined) return <section className="admin-section"><p className="admin-sub">Loading…</p></section>;
  if (!data.isAdmin) return <section className="admin-section"><p className="admin-sub">You don't have access to this section.</p></section>;

  return (
    <section className="admin-section">
      <h2 className="admin-section-title">Admin panel access</h2>
      <p className="admin-sub" style={{ marginBottom: 16 }}>
        Only the email addresses below can see the Admin panel.
      </p>

      <form className="admin-email-add" onSubmit={addEmail}>
        <input
          type="email"
          placeholder="name@example.com"
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>Add</button>
      </form>
      {error && <div className="admin-email-error">{error}</div>}

      <ul className="admin-email-list">
        {data.envEmails.map(email => (
          <li key={email} className="admin-email-row">
            <span className="admin-email-addr">{email}</span>
            <span className="admin-email-tag" title="Set via server configuration — not removable here">permanent</span>
          </li>
        ))}
        {data.emails.map(email => (
          <li key={email} className="admin-email-row">
            <span className="admin-email-addr">{email}</span>
            <button className="admin-email-remove" onClick={() => removeEmail(email)} disabled={busy}>Remove</button>
          </li>
        ))}
        {data.envEmails.length === 0 && data.emails.length === 0 && (
          <li className="admin-email-empty">No admins configured yet.</li>
        )}
      </ul>
    </section>
  );
}

// Admin / settings hub. Add future integration + system cards here.
export default function Admin() {
  const [tab, setTab] = useState('integrations');

  return (
    <main className="admin-main">
      <div className="admin-head">
        <h1>Admin</h1>
        <p className="admin-sub">Integrations and system settings</p>
      </div>

      <div className="admin-tabs">
        {TABS.map(t => (
          <button key={t.id} className={`admin-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'integrations' && <IntegrationsTab />}
      {tab === 'preview' && <PreviewAccessTab />}
      {tab === 'fmp' && <FmpTab />}
    </main>
  );
}
