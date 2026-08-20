import { useState, useEffect, useCallback, Fragment } from 'react';
import ShopifyConnect from './ShopifyConnect';
import { getVibeValueLists, seedValueLists, setValueList, compareValueLists } from '../api/valueLists';
import { getTemplates, saveTemplate, TEMPLATE_VERSIONS, templateAttachments, sendTestEmail } from '../api/workshopEmail';
import { getAgentConfig, saveAgentConfig } from '../api/agentConfig';
import { getDriftReport, runReconcile, BUCKET_LABEL, linkRecord, isLinkable, needsJudgement, compareValues } from '../api/productDrift';
import { updateVibeRecord } from '../api/vibeRecords';
import { getCurrentEnv } from '../config/fmpEnvironments';
import { pushToShopify, pushToQBO } from '../api/integrations';
import MarkdownEditor from './MarkdownEditor';
import QboConnect from './QboConnect';
import './Admin.css';

const TABS = [
  { id: 'integrations', label: 'Integrations' },
  { id: 'preview', label: 'Preview access' },
  { id: 'fmp', label: 'FMP' },
  { id: 'backup', label: 'Backup' },
  { id: 'vocab', label: 'Vocabularies' },
  { id: 'wsemail', label: 'Workshop e-mails' },
  { id: 'agent', label: 'Assistant' },
  { id: 'drift', label: 'Product drift' },
];

const ago = iso => {
  if (!iso) return 'never';
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3600000);
  return h < 1 ? 'just now' : h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

const PRODUCTS_LAYOUT = 'Products & Services_New';
const money = v => (v == null ? '—' : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));

// One bucket, unfolded.
//
// THE ACTION MATCHES THE RISK, which is why there is not one "Fix" button:
//
//   linkable  the product and the item already share a SKU, so storing the id
//             changes nothing in either external system. Safe, and it clears 73
//             of 157 records with no judgement required.
//   drift     pushing OUR value OVERWRITES theirs. Shown side by side and
//             opt-in per row, because sometimes QuickBooks is the one that is
//             right and a blanket push would destroy that silently.
//   dupes     which product owns a SKU is a business question. Listed, with a
//             link through to each product, and no bulk action at all.
function DriftBucket({ bucket, rows, truncated, onDone }) {
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const linkable = isLinkable(bucket);
  const judgement = needsJudgement(bucket);
  const target = bucket.startsWith('qbo') ? 'qbo' : 'shopify';
  const actionable = !judgement;

  const toggle = id => setSel(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOn = rows.length > 0 && sel.size === rows.length;

  async function apply() {
    setBusy(true); setResult(null);
    const chosen = rows.filter(r => sel.has(r.recordId));
    let ok = 0; const failed = [];
    for (const row of chosen) {
      try {
        if (linkable) {
          await linkRecord(updateVibeRecord, PRODUCTS_LAYOUT, row, target);
        } else {
          // Re-push through the SAME path the per-product sync button uses.
          const f = { Name: row.name, Unit_Price: row.price, SKU: row.sku, Description: '' };
          if (target === 'qbo') await pushToQBO(f, row.qboId || null, null);
          else await pushToShopify(f, row.recordId, row.productId || null);
        }
        ok++;
      } catch (e) { failed.push(`${row.sku || row.recordId}: ${e.message}`); }
    }
    setResult({ ok, failed });
    setBusy(false);
    setSel(new Set());
    if (ok) onDone?.();
  }

  return (
    <div className="admin-drift-detail">
      {truncated && (
        <p className="admin-note admin-missing">
          Showing the first {rows.length} of {truncated}. Run the reconciliation again after
          fixing these to see the rest.
        </p>
      )}
      <table className="h5-table">
        <thead>
          <tr>
            {actionable && (
              <th style={{ width: 30 }}>
                <input type="checkbox" checked={allOn} disabled={busy}
                  onChange={() => setSel(allOn ? new Set() : new Set(rows.map(r => r.recordId)))} />
              </th>
            )}
            <th>SKU</th><th>Product</th>
            <th>{linkable ? 'Matches' : 'In Vibe'}</th>
            <th>{linkable ? '' : `In ${target === 'qbo' ? 'QuickBooks' : 'Shopify'}`}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const cmp = compareValues(bucket, r);
            const cand = linkable ? (r.qboCandidates?.[0] || r.shopCandidates?.[0]) : null;
            return (
              <tr key={r.recordId || r.sku}>
                {actionable && (
                  <td><input type="checkbox" checked={sel.has(r.recordId)} disabled={busy}
                    onChange={() => toggle(r.recordId)} /></td>
                )}
                <td className="admin-drift-sku">{r.sku || <em>none</em>}</td>
                <td>{r.name || (r.recordIds ? `${r.recordIds.length} products` : '—')}</td>
                <td>{cmp ? (cmp.money ? money(cmp.ours) : String(cmp.ours ?? '—')) : (cand ? cand.name || cand.title : '—')}</td>
                <td className={cmp ? 'admin-drift-theirs' : undefined}>
                  {cmp ? (cmp.money ? money(cmp.theirs) : String(cmp.theirs ?? '—')) : (cand ? money(cand.price) : '')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {judgement ? (
        <p className="admin-note">
          Which product should own a shared SKU is a business decision, so there is no bulk
          action here. Open each product to resolve it.
        </p>
      ) : (
        <div className="admin-agent-foot">
          <button className="admin-btn" disabled={busy || sel.size === 0} onClick={apply}>
            {busy ? 'Working…'
              : linkable ? `Link ${sel.size || ''} selected`
              : `Push Vibe's value to ${target === 'qbo' ? 'QuickBooks' : 'Shopify'} (${sel.size || 0})`}
          </button>
          {!linkable && (
            <span className="admin-note" style={{ margin: 0 }}>
              This <strong>overwrites</strong> the value on the right.
            </span>
          )}
          {linkable && (
            <span className="admin-note" style={{ margin: 0 }}>
              Stores the id only — nothing in {target === 'qbo' ? 'QuickBooks' : 'Shopify'} is changed.
            </span>
          )}
        </div>
      )}
      {result && (
        <p className={result.failed.length ? 'admin-error' : 'admin-testsend-ok'}>
          {result.ok} done{result.failed.length ? `, ${result.failed.length} failed: ${result.failed.slice(0, 3).join('; ')}` : ''}
        </p>
      )}
    </div>
  );
}

// The SKU counter, read-only. It lives in Redis now rather than in a Tray
// workflow, and the whole point of moving it was that someone at High 5 can
// look at it — so it needs somewhere to be looked at. GET /api/next-sku peeks
// without consuming, so opening this page can never burn a number.
function SkuCounter() {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    const db = getCurrentEnv().db;
    fetch(`/api/next-sku?db=${encodeURIComponent(db)}`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setInfo).catch(e => setErr(e.message));
  }, []);
  return (
    <section className="admin-section">
      <h2 className="admin-section-title">Product SKU counter</h2>
      <p className="admin-note">
        Vibe issues product SKUs from its own counter. It starts at {info?.floor ?? 3000} so
        it can never collide with the Tray counter FileMaker&apos;s script trigger still
        uses — a numeric SKU at or above {info?.floor ?? 3000} was issued here. Vendor part
        numbers and ISBNs are left alone; this only ever issues the next integer.
      </p>
      {err && <p className="admin-error">{err}</p>}
      {!info ? <p>Loading…</p> : (
        <div className="admin-drift-head">
          <div className="admin-drift-total">
            <span>{info.next}</span><label>next SKU</label>
          </div>
          <div className="admin-drift-total">
            <span>{info.seeded ? info.current : '—'}</span><label>last issued</label>
          </div>
        </div>
      )}
      {info && !info.seeded && (
        <p className="admin-note admin-missing">
          Not seeded yet — the counter is created the first time a product is made, and the
          first SKU it hands out will be {info.floor}.
        </p>
      )}
    </section>
  );
}

// Product drift between Vibe, QuickBooks and Shopify — see
// docs/product-sync-audit.md.
//
// THE DELTA LEADS, not the total. 71 QuickBooks name mismatches is today's
// normal; what warrants attention is the day it becomes 74. A dashboard whose
// headline is a big number that never moves gets ignored within a week, which is
// the same as not having one.
function DriftTab() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);   // the unfolded bucket

  const load = useCallback(async () => {
    try { setData(await getDriftReport()); setError(null); }
    catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { const d = await getDriftReport(); if (alive) { setData(d); setError(null); } }
      catch (e) { if (alive) setError(e.message); }
    })();
    return () => { alive = false; };
  }, []);

  async function runNow() {
    setBusy(true); setError(null);
    try { await runReconcile(); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const last = data?.last;
  const drift = last?.drift ?? null;
  const dd = last?.driftDelta;
  const changed = Object.entries(last?.delta || {});

  return (
    <>
    <SkuCounter />
    <section className="admin-section">
      <h2 className="admin-section-title">Product drift</h2>
      <p className="admin-note">
        Vibe, QuickBooks and Shopify compared on SKU. Runs nightly at 05:00; this reads
        the stored result rather than re-running, because a reconciliation pages all
        three systems and takes up to two minutes.
      </p>
      {error && <p className="admin-error">{error}</p>}

      {!data ? <p>Loading…</p> : !last ? (
        <p className="admin-note admin-missing">
          No run recorded yet. The nightly job will populate this, or run it now.
        </p>
      ) : (
        <>
          <div className="admin-drift-head">
            <div className={`admin-drift-total${drift > 0 ? ' bad' : ''}`}>
              <span>{drift}</span><label>records drifted</label>
            </div>
            {dd !== null && dd !== undefined && (
              <div className={`admin-drift-delta${dd > 0 ? ' worse' : dd < 0 ? ' better' : ''}`}>
                {dd > 0 ? `▲ ${dd} since last run` : dd < 0 ? `▼ ${Math.abs(dd)} since last run` : 'unchanged since last run'}
              </div>
            )}
            <div className="admin-drift-when">
              checked {ago(last.at)}{last.previousAt ? ` · previous ${ago(last.previousAt)}` : ''}
            </div>
          </div>

          {changed.length > 0 && (
            <div className="admin-callout-warn">
              <strong>Changed since the last run</strong>
              <ul>
                {changed.map(([k, v]) => (
                  <li key={k}>{BUCKET_LABEL[k] || k}: <strong>{v > 0 ? `+${v}` : v}</strong></li>
                ))}
              </ul>
            </div>
          )}

          <table className="h5-table admin-drift-table">
            <thead><tr><th>What</th><th className="h5-table__num">Count</th><th /></tr></thead>
            <tbody>
              {[...(data.buckets?.drift || []), ...(data.buckets?.linkable || [])].map(k => {
                const n = last.summary?.[k] ?? 0;
                const rows = last.rows?.[k] || [];
                const isOpen = open === k;
                const link = (data.buckets?.linkable || []).includes(k);
                return (
                  <Fragment key={k}>
                    {/* The whole row opens it. A count with nothing behind it is
                        not worth a click, so a zero row is inert and says so by
                        not offering the affordance. */}
                    <tr className={`admin-drift-row${n ? ' clickable' : ''}${isOpen ? ' open' : ''}`}
                      onClick={() => n && setOpen(isOpen ? null : k)}>
                      <td>
                        {n > 0 && <span className="admin-drift-caret">{isOpen ? '▾' : '▸'}</span>}
                        {BUCKET_LABEL[k] || k}
                        {link && <span className="admin-vocab-count">not drift</span>}
                      </td>
                      <td className="h5-table__num">{n}</td>
                      <td className="h5-table__num admin-drift-hint">
                        {n > 0 ? (isOpen ? 'hide' : 'show') : ''}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="admin-drift-expanded">
                        <td colSpan={3}>
                          <DriftBucket bucket={k} rows={rows} truncated={last.truncated?.[k]}
                            onDone={load} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>

          <p className="admin-note">
            {last.linkable > 0 && (
              <>
                <strong>{last.linkable}</strong> products match a QuickBooks item or Shopify
                variant by SKU but have no id stored. Not drift — a link waiting to be made.{' '}
              </>
            )}
            Products with no SKU cannot be linked to anything: SKU is the join key.
          </p>
        </>
      )}

      <div className="admin-agent-foot">
        <button className="admin-btn" disabled={busy} onClick={runNow}>
          {busy ? 'Reconciling… (up to 2 min)' : 'Run now'}
        </button>
      </div>
    </section>
    </>
  );
}

// Settings for the assistant. See docs/agent-admin-scope.md for why the prompt
// is split into generated facts and editable guidance rather than made wholly
// editable.
function AgentTab() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { const d = await getAgentConfig(); if (alive) { setData(d); setDraft(d.config); setError(null); } }
      catch (e) { if (alive) setError(e.message); }
    })();
    return () => { alive = false; };
  }, []);

  async function save(changes) {
    setBusy(true); setError(null);
    try { const d = await saveAgentConfig(changes); setData(d); setDraft(d.config); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (error && !data) return <section className="admin-section"><p className="admin-error">{error}</p></section>;
  if (!data || !draft) return <section className="admin-section"><p>Loading…</p></section>;

  const { choices, enabledTools, prompt, promptChars, config } = data;
  const isOff = t => draft.disabled.includes(t);
  const toggle = t => setDraft(d => ({
    ...d, disabled: isOff(t) ? d.disabled.filter(x => x !== t) : [...d.disabled, t],
  }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);

  return (
    <section className="admin-section">
      <h2 className="admin-section-title">Assistant</h2>
      <p className="admin-note">
        The ✦ assistant runs <strong>{config.model}</strong> with {enabledTools.length} of{' '}
        {choices.tools.length} tools available. Changes take effect on the next question —
        no deploy.
      </p>
      {error && <p className="admin-error">{error}</p>}

      {/* Safety first, because it is the setting with consequences. */}
      <div className={`admin-agent-block${draft.readOnly ? ' admin-agent-block--on' : ''}`}>
        <label className="admin-agent-switch">
          <input type="checkbox" checked={draft.readOnly} disabled={busy}
            onChange={e => setDraft({ ...draft, readOnly: e.target.checked })} />
          <span><strong>Read-only mode</strong> — disable every tool that writes or acts outside Vibe</span>
        </label>
        <p className="admin-note">
          Turns off {choices.writeTools.join(', ')}. Worth knowing what that covers today:
          the assistant can otherwise <strong>permanently delete</strong> a Gmail message
          (not trash it), delete a Drive file, and share a Drive file with anyone.
          Disabled tools are removed from the request, not merely discouraged.
        </p>
      </div>

      <div className="admin-agent-grid">
        <label className="admin-field">
          <span>Model</span>
          <select value={draft.model} disabled={busy}
            onChange={e => setDraft({ ...draft, model: e.target.value })}>
            {choices.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <label className="admin-field">
          <span>Max tool turns (1–30)</span>
          <input type="number" min={1} max={30} value={draft.maxTurns} disabled={busy}
            onChange={e => setDraft({ ...draft, maxTurns: e.target.value })} />
        </label>
        <label className="admin-field">
          <span>Max output tokens (512–16384)</span>
          <input type="number" min={512} max={16384} step={512} value={draft.maxOutputTokens} disabled={busy}
            onChange={e => setDraft({ ...draft, maxOutputTokens: e.target.value })} />
        </label>
      </div>

      <h3 className="admin-agent-h3">Tools</h3>
      <div className="admin-agent-tools">
        {choices.tools.map(t => {
          const writes = choices.writeTools.includes(t);
          const offByReadOnly = draft.readOnly && writes;
          return (
            <label key={t} className={`admin-agent-tool${isOff(t) || offByReadOnly ? ' off' : ''}`}>
              <input type="checkbox" checked={!isOff(t) && !offByReadOnly}
                disabled={busy || offByReadOnly} onChange={() => toggle(t)} />
              <code>{t}</code>
              {writes && <span className="admin-agent-writes">writes</span>}
            </label>
          );
        })}
      </div>

      <h3 className="admin-agent-h3">House guidance</h3>
      <p className="admin-note">
        Added to the assistant&apos;s standing rules — it does not replace them. The rules
        already in force (prefer Vibe contacts over the legacy table, confirm before a
        write, compute real totals rather than one page) stay whatever you put here; each
        of those exists because it fixed a real mistake.
      </p>
      <textarea className="admin-vocab-edit" rows={8} disabled={busy}
        placeholder="e.g. When asked about a training, always give the course code alongside the name."
        value={draft.guidance} onChange={e => setDraft({ ...draft, guidance: e.target.value })} />

      <div className="admin-agent-foot">
        <button className="admin-btn" disabled={busy || !dirty} onClick={() => save(draft)}>
          {busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>
        <button className="admin-btn admin-btn--ghost" disabled={busy || !dirty}
          onClick={() => setDraft(config)}>Discard</button>
        <button className="admin-btn admin-btn--ghost" onClick={() => setShowPrompt(v => !v)}>
          {showPrompt ? 'Hide' : 'Show'} assembled prompt ({promptChars.toLocaleString()} chars)
        </button>
        {config.updatedAt && (
          <span className="admin-note admin-agent-when">
            Last changed {String(config.updatedAt).split('T')[0]}
            {config.updatedBy ? ` by ${config.updatedBy}` : ''}
          </span>
        )}
      </div>

      {showPrompt && (
        <>
          <p className="admin-note">
            Exactly what the model is told, assembled. Read-only — the tool and schema
            sections are generated from the running code so they cannot drift from it.
          </p>
          <pre className="admin-agent-prompt">{prompt}</pre>
        </>
      )}
    </section>
  );
}

// The tokens a workshop e-mail body may use. Listed in the UI because a
// template is written by staff, not by a developer, and an unknown token is
// left in the message verbatim rather than silently blanked — so knowing the
// list is the difference between a working merge and "{{frist_name}}" reaching
// a customer.
const EMAIL_TOKENS = [
  'first_name', 'full_name', 'organization', 'course_name', 'course_number',
  'start_date', 'end_date', 'start_time', 'location', 'instructor', 'hours',
  'fee_total', 'deposit_due', 'balance_due', 'recipient_email',
];

const kb = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// The files that go out with a template. Uploading here is the whole point of
// managing e-mails in Vibe rather than Tray: the attachments were previously
// only visible to whoever could open the Tray workflow.
function TemplateAttachments({ templateId }) {
  const [files, setFiles] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try { setFiles(await templateAttachments.list(templateId)); setError(null); }
    catch (e) { setError(e.message); }
  }, [templateId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { const f = await templateAttachments.list(templateId); if (alive) { setFiles(f); setError(null); } }
      catch (e) { if (alive) setError(e.message); }
    })();
    return () => { alive = false; };
  }, [templateId]);

  async function onPick(e) {
    const picked = [...(e.target.files || [])];
    e.target.value = '';
    if (!picked.length) return;
    setBusy(true); setError(null);
    try { for (const f of picked) await templateAttachments.upload(templateId, f); await load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function drop(id) {
    setBusy(true); setError(null);
    try { await templateAttachments.remove(id); await load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const total = (files || []).reduce((n, f) => n + (Number(f.size) || 0), 0);

  return (
    <div className="admin-tpl-files">
      <div className="admin-tpl-files-head">
        <span>Attachments{files?.length ? ` (${files.length}, ${kb(total)})` : ''}</span>
        <label className={`admin-btn admin-btn--ghost${busy ? ' admin-btn--busy' : ''}`}>
          {busy ? 'Working…' : '+ Add file'}
          <input type="file" multiple hidden onChange={onPick} disabled={busy} />
        </label>
      </div>
      {error && <p className="admin-error">{error}</p>}
      {files === null ? <p className="admin-note">Loading…</p>
        : files.length === 0 ? <p className="admin-note">No attachments. This template sends the message alone.</p>
        : (
          <ul className="admin-tpl-file-list">
            {files.map(f => (
              <li key={f.id}>
                <a href={f.url} target="_blank" rel="noreferrer">{f.name}</a>
                <span className="admin-vocab-count">{kb(f.size)}</span>
                <button className="admin-btn admin-btn--ghost" disabled={busy} onClick={() => drop(f.id)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      {total > 18 * 1024 * 1024 && (
        <p className="admin-error">
          Over 18 MB — Gmail will reject the message. Remove something before sending.
        </p>
      )}
    </div>
  );
}

// Send a test to any address.
//
// Defaults to nothing so the address is a deliberate act rather than a leftover.
// A test renders the real template against SAMPLE details — never a live
// registration — so checking formatting cannot put a customer's name and fees
// into a message addressed to somebody else.
function TestSend({ templates, from }) {
  const [to, setTo] = useState('');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const usable = TEMPLATE_VERSIONS.filter(v => {
    const t = templates?.[v.id];
    return t && (String(t.subject || '').trim() || String(t.body || '').trim());
  });
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to.trim());

  async function go() {
    setBusy(true); setError(null); setResult(null);
    try { setResult(await sendTestEmail(to.trim(), version || undefined)); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="admin-testsend">
      <div className="admin-testsend-head">Send a test</div>
      <div className="admin-testsend-row">
        <input type="email" placeholder="address to send to" value={to} disabled={busy}
          onChange={e => setTo(e.target.value)} />
        <select value={version} disabled={busy} onChange={e => setVersion(e.target.value)}>
          <option value="">Diagnostic message (no template)</option>
          {usable.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
        <button className="admin-btn" disabled={busy || !valid} onClick={go}>
          {busy ? 'Sending…' : 'Send test'}
        </button>
      </div>
      <p className="admin-note">
        Sends a <strong>real e-mail</strong> from {from || 'the workshops mailbox'} to the address
        above. With a template chosen it renders that template with sample details — Sam Example,
        Adventure Basics, $835 — so a test can never carry a real registrant&apos;s information.
        The subject is prefixed <code>[TEST]</code>.
        {usable.length === 0 && ' No template has been written yet, so only the diagnostic message is available.'}
      </p>
      {error && <p className="admin-error">{error}</p>}
      {result && (
        <p className="admin-testsend-ok">
          ✓ {result.note}
          {result.attachmentsSent?.length ? ` Attachments: ${result.attachmentsSent.join(', ')}.` : ''}
        </p>
      )}
    </div>
  );
}

// PHASE: workshop e-mail. These four templates used to live inside a Tray
// workflow, which meant nobody at High 5 could read or change them without
// going into Tray. They are Vibe's now.
function WorkshopEmailTab() {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);   // { id, subject, body }
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try { setData(await getTemplates()); setError(null); }
    catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { const d = await getTemplates(); if (alive) { setData(d); setError(null); } }
      catch (e) { if (alive) setError(e.message); }
    })();
    return () => { alive = false; };
  }, []);

  async function save() {
    setBusy(editing.id); setError(null);
    try {
      await saveTemplate(editing.id, { subject: editing.subject, body: editing.body, attachments: editing.attachments || [] });
      setEditing(null);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  const templates = data?.templates || {};

  return (
    <section className="admin-section">
      <h2 className="admin-section-title">Workshop e-mails</h2>
      <p className="admin-note">
        The four messages staff can send to a registrant from the OE Trainings page.
        Sent as <strong>{data?.from || 'workshops@high5adventure.org'}</strong>, so replies come
        back to that mailbox and a copy lands in its Sent folder.
      </p>
      <p className="admin-note">
        Bodies are written in <strong>Markdown</strong> and delivered as HTML, with a plain-text
        copy alongside for clients that prefer it — both from the same source, so they cannot
        say different things. Merge tokens insert from the toolbar; anything unrecognised is
        left in the message exactly as written, so check spelling.
      </p>

      {error && <p className="admin-error">{error}</p>}
      <TestSend templates={templates} from={data?.from} />
      {!data ? <p>Loading…</p> : (
        <div className="admin-vocab-lists">
          {TEMPLATE_VERSIONS.map(v => {
            const tpl = templates[v.id];
            const isEditing = editing?.id === v.id;
            return (
              <div key={v.id} className="admin-vocab-list">
                <div className="admin-vocab-head">
                  <code>{v.label}</code>
                  {!tpl ? <span className="admin-vocab-count admin-missing">not written</span>
                    : !(String(tpl.subject || '').trim() || String(tpl.body || '').trim())
                      ? <span className="admin-vocab-count admin-missing">EMPTY — cannot send</span>
                      : <span className="admin-vocab-count">saved</span>}
                  {isEditing ? (
                    <>
                      <button className="admin-btn"
                        disabled={busy === v.id || !(editing.subject.trim() || editing.body.trim())}
                        title={!(editing.subject.trim() || editing.body.trim())
                          ? 'A template needs at least a subject or a body — an empty one looks written but sends a blank message.'
                          : undefined}
                        onClick={save}>
                        {busy === v.id ? 'Saving…' : 'Save'}
                      </button>
                      <button className="admin-btn admin-btn--ghost" onClick={() => setEditing(null)}>Cancel</button>
                    </>
                  ) : (
                    <button className="admin-btn admin-btn--ghost"
                      onClick={() => setEditing({ id: v.id, subject: tpl?.subject || '', body: tpl?.body || '', attachments: tpl?.attachments || [] })}>
                      {tpl ? 'Edit' : 'Write'}
                    </button>
                  )}
                </div>
                {isEditing ? (
                  <>
                    <input className="admin-vocab-edit" placeholder="Subject"
                      value={editing.subject} onChange={e => setEditing({ ...editing, subject: e.target.value })} />
                    <MarkdownEditor
                      value={editing.body}
                      onChange={body => setEditing({ ...editing, body })}
                      disabled={busy === v.id}
                      tokens={EMAIL_TOKENS}
                      placeholder={'Written in Markdown and sent as HTML.\n\n## Welcome\n\nHi {{first_name}}, you are booked on **{{course_name}}**.'} />
                  </>
                ) : tpl ? (
                  <div className="admin-vocab-values">
                    <strong>{tpl.subject || '(no subject)'}</strong>
                    <div className="admin-tpl-body">{tpl.body.slice(0, 240)}{tpl.body.length > 240 ? '…' : ''}</div>
                  </div>
                ) : (
                  <div className="admin-vocab-values admin-missing">
                    Nothing here yet — this template still only exists inside the old Tray workflow.
                  </div>
                )}
                {/* Attachments are managed whether or not the body is written —
                    the files can go up before the wording is settled. */}
                <TemplateAttachments templateId={v.id} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// The layouts whose value lists drive dropdowns in the app. Adding one here is
// all it takes to bring its lists under Vibe — the store is keyed by layout
// name and nothing else needs to know.
const VOCAB_LAYOUTS = [
  { layout: 'RCD_New', label: 'CCS projects' },
  { layout: 'trainings_New', label: 'Trainings' },
  { layout: 'Estimates_New', label: 'Estimates' },
  { layout: 'Inspections_New', label: 'Inspections' },
  { layout: 'RMI_New', label: 'Risk management' },
  { layout: 'Products & Services_New', label: 'Products & services' },
];

// PHASE C3. These vocabularies come from FileMaker today and have to outlive
// it: after cutover there is no FileMaker copy to re-seed from, and no other
// way to add a builder, a trainer or a program type without a code deploy.
function VocabTab() {
  const [layout, setLayout] = useState(VOCAB_LAYOUTS[0].layout);
  const [state, setState] = useState(null);     // { lists, source }
  const [cmp, setCmp] = useState(null);
  const [busy, setBusy] = useState(null);       // 'load' | 'seed' | 'compare' | list name
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // { name, text }

  const load = useCallback(async () => {
    setBusy('load'); setError(null);
    try { setState(await getVibeValueLists(layout)); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }, [layout]);

  // Fetch FIRST, then set state — a setState in the synchronous part of an
  // effect body triggers a cascading render. `load` above is for the buttons,
  // which are event handlers and so have no such constraint.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await getVibeValueLists(layout);
        if (alive) { setState(data); setCmp(null); setError(null); }
      } catch (e) { if (alive) setError(e.message); }
    })();
    return () => { alive = false; };
  }, [layout]);

  async function run(label, fn) {
    setBusy(label); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e.message); setBusy(null); }
  }

  const lists = state?.lists || {};
  const names = Object.keys(lists).sort();
  const source = state?.source;

  return (
    <section className="admin-section">
      <h2 className="admin-section-title">Vocabularies</h2>
      <p className="admin-note">
        The dropdown options across the app. They come from FileMaker&apos;s value lists
        today; seeding copies them into Vibe, after which Vibe is the source and they
        keep working once FileMaker is retired.
      </p>
      <p className="admin-note admin-note--warn">
        <strong>Seeding replaces your edits to any list FileMaker also has.</strong> That is
        deliberate while FileMaker is still the system of record — but it means an edit made
        here to, say, <code>Lead Builder</code> is undone by the next seed. Until cutover,
        change those in FileMaker. Lists that exist only in Vibe are never touched by a seed.
      </p>

      <div className="admin-vocab-bar">
        <select value={layout} onChange={e => setLayout(e.target.value)} disabled={!!busy}>
          {VOCAB_LAYOUTS.map(l => <option key={l.layout} value={l.layout}>{l.label}</option>)}
        </select>
        <button className="admin-btn" disabled={!!busy}
          onClick={() => run('seed', () => seedValueLists(layout))}
          title="FileMaker wins for any list it also has — your edits to those are replaced.">
          {busy === 'seed' ? 'Seeding…' : 'Seed from FileMaker'}
        </button>
        <button className="admin-btn" disabled={!!busy}
          onClick={() => run('compare', async () => setCmp(await compareValueLists(layout)))}>
          {busy === 'compare' ? 'Comparing…' : 'Compare with FileMaker'}
        </button>
        {source && (
          <span className={`admin-vocab-src admin-vocab-src--${source}`}>
            {source === 'vibe' ? 'Held by Vibe'
              : source === 'filemaker' ? 'Still reading FileMaker — not seeded'
              : 'Unavailable'}
          </span>
        )}
      </div>

      {error && <p className="admin-error">{error}</p>}

      {cmp && (
        <div className="admin-vocab-diff">
          <strong>Differences vs FileMaker ({cmp.diff.length})</strong>
          {cmp.diff.length === 0 ? <p>Identical.</p> : (
            <ul>
              {cmp.diff.map(d => (
                <li key={d.name}>
                  <code>{d.name}</code> — Vibe {d.inVibe}, FileMaker {d.inFileMaker}
                  {d.onlyInFileMaker.length > 0 && <div className="admin-vocab-only">only in FileMaker: {d.onlyInFileMaker.join(', ')}</div>}
                  {d.onlyInVibe.length > 0 && <div className="admin-vocab-only">only in Vibe: {d.onlyInVibe.join(', ')}</div>}
                </li>
              ))}
            </ul>
          )}
          {cmp.skipped?.length > 0 && (
            <p className="admin-vocab-only">
              Skipped as too long to be a vocabulary: {cmp.skipped.map(s => `${s.name} (${s.count})`).join(', ')}
            </p>
          )}
        </div>
      )}

      {busy === 'load' && !names.length ? <p>Loading…</p> : !names.length ? (
        <p className="admin-note">Nothing held for this layout yet. Seed it from FileMaker to start.</p>
      ) : (
        <div className="admin-vocab-lists">
          {names.map(name => (
            <div key={name} className="admin-vocab-list">
              <div className="admin-vocab-head">
                <code>{name}</code>
                <span className="admin-vocab-count">{lists[name].length}</span>
                {editing?.name === name ? (
                  <>
                    <button className="admin-btn" disabled={busy === name}
                      onClick={() => run(name, async () => {
                        await setValueList(layout, name, editing.text.split('\n'));
                        setEditing(null);
                      })}>{busy === name ? 'Saving…' : 'Save'}</button>
                    <button className="admin-btn admin-btn--ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </>
                ) : (
                  <button className="admin-btn admin-btn--ghost"
                    onClick={() => setEditing({ name, text: lists[name].join('\n') })}>Edit</button>
                )}
              </div>
              {editing?.name === name ? (
                <textarea className="admin-vocab-edit" rows={Math.min(20, lists[name].length + 2)}
                  value={editing.text} onChange={e => setEditing({ name, text: e.target.value })} />
              ) : (
                <div className="admin-vocab-values">{lists[name].join(' · ')}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

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

        <div className="admin-card">
          <div className="admin-card-head">
            <span className="admin-card-icon">◐</span>
            <div className="admin-card-meta">
              <div className="admin-card-title">QuickBooks</div>
              <div className="admin-card-desc">Connect the company file to sync invoices, estimates, and items.</div>
            </div>
          </div>
          <QboConnect />
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
  // Clamp to 0: right after a fresh capture, `now` (captured once at mount)
  // can be a hair earlier than the server's capturedAt timestamp, which
  // would otherwise floor to -1 rather than "today".
  const daysAgo = capturedDate ? Math.max(0, Math.floor((now - capturedDate.getTime()) / 86400000)) : null;
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

// Sync from FileMaker, on demand. This used to be a cron every five minutes —
// 288 invocations a day, more than half the whole schedule — which made sense
// while FileMaker was the system of record and does not now that Vibe owns its
// records. See api/sync.js.
//
// ONE PRESS IS ONE SLICE, not necessarily a whole sync. The endpoint works to a
// 270-second deadline shared across the eight replicated layouts, so a layout
// still doing its initial backfill can come back mid-way. That is reported
// rather than hidden: any layout whose phase is 'backfill' still has pages to
// fetch, and pressing again resumes exactly where it stopped.
function FmpSyncSection() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function run() {
    setBusy(true); setError(null); setResult(null);
    try {
      const db = getCurrentEnv().db;
      const r = await fetch(`/api/sync?db=${encodeURIComponent(db)}`, {
        method: 'POST', credentials: 'include',
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setResult(body.result || {});
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const rows = result ? Object.entries(result) : [];
  const stillGoing = rows.filter(([, v]) => v.phase === 'backfill');

  return (
    <section className="admin-section">
      <h2 className="admin-section-title">Sync from FileMaker</h2>
      <p className="admin-note">
        Pulls FileMaker&apos;s current records into Vibe&apos;s replica. This no longer runs on a
        schedule — Vibe owns its own records, so the copy is only worth refreshing when
        someone has been working in FileMaker Pro. Nothing here writes TO FileMaker.
      </p>
      <p className="admin-note">
        A run can take up to five minutes. It is safe to press again — the sync resumes
        where it left off rather than starting over.
      </p>
      <button className="h5-btn h5-btn--primary h5-btn--sm" disabled={busy} onClick={run}>
        {busy ? 'Syncing… (up to 5 min)' : 'Sync now'}
      </button>
      {error && <p className="admin-error">{error}</p>}
      {rows.length > 0 && (
        <>
          <table className="admin-drift-table">
            <thead><tr><th>Layout</th><th>State</th><th className="num">Records</th><th>Last sync</th></tr></thead>
            <tbody>
              {rows.map(([layout, v]) => (
                <tr key={layout}>
                  <td>{layout}</td>
                  <td>{v.error ? <span className="admin-error">{v.error}</span>
                     : v.phase === 'backfill' ? 'still backfilling' : 'up to date'}</td>
                  <td className="num">{v.total != null ? `${v.count ?? 0} / ${v.total}` : (v.count ?? '—')}</td>
                  <td>{v.lastSync ? new Date(v.lastSync).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {stillGoing.length > 0 && (
            <p className="admin-note admin-missing">
              {stillGoing.length} layout{stillGoing.length > 1 ? 's are' : ' is'} still backfilling —
              press Sync now again to continue.
            </p>
          )}
        </>
      )}
    </section>
  );
}

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

const fmtBytes = n => {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

// Backup — dry run. Phase 0 of docs/vibe-owns-the-record.md: before Vibe owns
// any record, we need a verified backup and a rehearsed restore, and before
// either of those we need to agree on what's actually in the estate.
//
// This reads /api/backup?mode=inventory, which writes nothing. Export and
// restore are separate work and deliberately not wired up here yet.
function BackupTab() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [exp, setExp] = useState(null); // { phase, done, total, current, result, failures }

  async function run() {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/backup?mode=inventory');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      setData(body);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  // Drives the export one key at a time. The loop lives here rather than on the
  // server so a 137MB estate can't run into the function timeout, and so
  // progress is real rather than a spinner.
  async function runExport() {
    if (!window.confirm("Export every backed-up key to Google Drive? Files go into today's dated folder in the backups folder, replacing that day's previous run if there was one.")) return;
    setBusy(true); setError(null); setExp({ phase: 'starting', done: 0, total: 0, failures: [] });
    const post = async (qs) => {
      const r = await fetch(`/api/backup?${qs}`, { method: 'POST' });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || `Failed (${r.status})`);
      return b;
    };
    try {
      const start = await post('mode=export-start');
      const failures = [];
      for (let i = 0; i < start.keys.length; i++) {
        const key = start.keys[i];
        setExp({ phase: 'exporting', done: i, total: start.keys.length, current: key, failures: [...failures] });
        try {
          const entry = await post(`mode=export-key&run=${encodeURIComponent(start.runId)}&key=${encodeURIComponent(key)}`);
          if (!entry.verified) failures.push(`${key} — checksum not confirmed by Drive`);
        } catch (e) {
          // Keep going: a partial run with a manifest that names the gaps is
          // more useful than stopping at the first bad key.
          failures.push(`${key} — ${e.message}`);
        }
      }
      setExp({ phase: 'finishing', done: start.keys.length, total: start.keys.length, failures: [...failures] });
      const result = await post(`mode=export-finish&run=${encodeURIComponent(start.runId)}`);
      setExp({ phase: 'done', done: start.keys.length, total: start.keys.length, result, failures, folderName: start.folderName, reusedFolder: start.reusedFolder });
    } catch (e) {
      setError(e.message);
      setExp(p => (p ? { ...p, phase: 'failed' } : null));
    } finally { setBusy(false); }
  }

  return (
    <section className="admin-section">
      <h2 className="admin-section-title">Backup — dry run</h2>
      <p className="admin-sub" style={{ marginBottom: 16 }}>
        <strong>Scan</strong> lists what a backup would capture and writes nothing.
        <strong> Export</strong> reads every one of those keys, gzips it, and uploads it into a
        folder named for today's date inside the shared <code>backups</code> Drive folder,
        verifying each file against the checksum Drive computed on receipt. Running twice in one
        day replaces that day's files rather than duplicating them. Restore is not built yet —
        until it has been rehearsed, treat this as untested.
      </p>

      <div className="admin-backup-actions">
        <button className="admin-run-btn" onClick={run} disabled={busy}>
          {busy && !exp ? 'Scanning…' : 'Scan the keyspace'}
        </button>
        <button className="admin-run-btn admin-run-btn--alt" onClick={runExport} disabled={busy}>
          {exp && busy ? 'Exporting…' : 'Export to Drive'}
        </button>
      </div>
      {error && <div className="admin-email-error" style={{ marginTop: 12 }}>{error}</div>}

      {exp && (
        <div className="admin-backup-progress">
          {exp.phase === 'exporting' && (
            <>
              <div className="admin-backup-bar"><span style={{ width: `${Math.round((exp.done / Math.max(1, exp.total)) * 100)}%` }} /></div>
              <div className="admin-backup-progress-txt">{exp.done} / {exp.total} — {exp.current}</div>
            </>
          )}
          {exp.phase === 'starting' && <div className="admin-backup-progress-txt">Creating the Drive folder…</div>}
          {exp.phase === 'finishing' && <div className="admin-backup-progress-txt">Writing the manifest…</div>}
          {exp.phase === 'done' && exp.result && (
            <div className={`admin-backup-result${exp.result.complete ? ' ok' : ' warn'}`}>
              <strong>{exp.result.complete ? '✓ Backup complete and verified' : '⚠ Backup finished with gaps'}</strong>
              <div>
                {exp.result.fileCount} files · {exp.result.totals.entries.toLocaleString()} entries ·{' '}
                {fmtBytes(exp.result.totals.gzBytes)} compressed (from {fmtBytes(exp.result.totals.rawBytes)})
              </div>
              <div className="admin-backup-progress-txt">
                Folder: {exp.folderName}{exp.reusedFolder ? ' (replaced an earlier run today)' : ''}
              </div>
              {exp.result.missing?.length > 0 && <div>Missing: {exp.result.missing.join(', ')}</div>}
              {exp.result.unverified?.length > 0 && <div>Unverified: {exp.result.unverified.join(', ')}</div>}
            </div>
          )}
          {exp.failures?.length > 0 && (
            <ul className="admin-backup-list admin-backup-warn" style={{ marginTop: 8 }}>
              {exp.failures.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          )}
        </div>
      )}

      {data && (
        <div className="admin-backup">
          <div className="admin-backup-totals">
            <span><strong>{data.totals.keys.toLocaleString()}</strong> keys</span>
            <span><strong>{data.totals.entries.toLocaleString()}</strong> entries</span>
            <span>
              <strong>{fmtBytes(data.totals.bytes)}</strong>
              {data.totals.bytesArePartial && <em title="Byte sizes unavailable for some keys on this Redis plan"> (partial)</em>}
            </span>
          </div>

          <table className="admin-backup-table">
            <thead>
              <tr><th>Key family</th><th>Type</th><th>Keys</th><th>Entries</th><th>Size</th></tr>
            </thead>
            <tbody>
              {data.families.map(f => (
                <tr key={f.family}>
                  <td className="admin-backup-fam" title={f.sample}>{f.family}</td>
                  <td>{f.type}</td>
                  <td>{f.keys.toLocaleString()}</td>
                  <td>{f.entries ? f.entries.toLocaleString() : '—'}</td>
                  <td>{f.bytesKnown ? fmtBytes(f.bytes) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.excluded.length > 0 && (
            <>
              <h3 className="admin-backup-sub">Deliberately excluded</h3>
              <ul className="admin-backup-list">
                {data.excluded.map(x => (
                  <li key={x.prefix}>
                    <code>{x.prefix}</code> — {x.keys.toLocaleString()} keys · {x.why}
                  </li>
                ))}
              </ul>
            </>
          )}

          {data.warnings.length > 0 && (
            <>
              <h3 className="admin-backup-sub">Notes for the exporter</h3>
              <ul className="admin-backup-list admin-backup-warn">
                {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}


// Restore — the half of Phase 0 that makes the other half mean something.
// Deliberately read-only by default: "Check" downloads each file, verifies its
// checksum and diffs it against live without writing. The rehearsal button
// writes one key to a scratch prefix so the write path is proven too.
function RestoreSection() {
  const today = new Date().toISOString().slice(0, 10);
  const [day, setDay] = useState(today);
  const [plan, setPlan] = useState(null);
  const [checks, setChecks] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const call = async (qs, method = 'GET') => {
    const r = await fetch(`/api/backup?${qs}`, { method });
    const b = await r.json();
    if (!r.ok) throw new Error(b.error || `Failed (${r.status})`);
    return b;
  };

  async function loadPlan() {
    setBusy(true); setError(null); setPlan(null); setChecks({});
    try { setPlan(await call(`mode=restore-plan&day=${encodeURIComponent(day)}`)); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function checkAll() {
    if (!plan) return;
    setBusy(true); setError(null);
    const next = {};
    for (const f of plan.files) {
      setChecks({ ...next, [f.key]: { pending: true } });
      try { next[f.key] = await call(`mode=restore-check&day=${encodeURIComponent(day)}&key=${encodeURIComponent(f.key)}`); }
      catch (e) { next[f.key] = { error: e.message }; }
    }
    setChecks(next);
    setBusy(false);
  }

  async function rehearse(key) {
    setBusy(true); setError(null);
    try {
      const r = await call(`mode=restore-write&day=${encodeURIComponent(day)}&key=${encodeURIComponent(key)}&target=scratch`, 'POST');
      setChecks(c => ({ ...c, [key]: { ...(c[key] || {}), rehearsal: r } }));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const results = plan ? plan.files.map(f => ({ f, c: checks[f.key] })) : [];
  const checked = results.filter(r => r.c && !r.c.pending && !r.c.error);
  const identical = checked.filter(r => {
    const d = r.c.diff || {};
    return !d.missingFromLive && !d.onlyInLive && !d.valuesDiffer;
  }).length;

  return (
    <section className="admin-section">
      <h2 className="admin-section-title">Restore</h2>
      <p className="admin-sub" style={{ marginBottom: 16, maxWidth: 640 }}>
        <strong>Check</strong> downloads each file, verifies it against the checksum recorded when
        it was written, and compares it to what is live — <em>writing nothing</em>.
        <strong> Rehearse</strong> writes one key into a scratch prefix and reads it back, which
        proves the write path without touching live data. Overwriting a live key is possible only
        via the API, with an explicit confirmation string.
      </p>
      <p className="admin-sub" style={{ marginBottom: 16, maxWidth: 640 }}>
        Differences are not automatically faults: the replica re-syncs from FileMaker every five
        minutes, so <code>repl:</code> keys legitimately drift from a backup taken earlier.
      </p>

      <div className="admin-backup-actions">
        <input className="admin-day-input" value={day} onChange={e => setDay(e.target.value)} placeholder="YYYY-MM-DD" />
        <button className="admin-run-btn" onClick={loadPlan} disabled={busy}>Load that day</button>
        {plan && <button className="admin-run-btn admin-run-btn--alt" onClick={checkAll} disabled={busy}>Check every file</button>}
      </div>
      {error && <div className="admin-email-error" style={{ marginTop: 12 }}>{error}</div>}

      {plan && (
        <div className="admin-backup">
          <div className="admin-backup-totals">
            <span><strong>{plan.files.length}</strong> files</span>
            <span>taken <strong>{new Date(plan.takenAt).toLocaleString()}</strong></span>
            <span>by <strong>{plan.by}</strong></span>
            {!plan.manifestComplete && <span style={{ color: '#f59e0b' }}>manifest reports gaps</span>}
            {checked.length > 0 && <span><strong>{identical}/{checked.length}</strong> identical to live</span>}
          </div>
          {plan.liveKeysNotInBackup?.length > 0 && (
            <div className="admin-backup-list admin-backup-warn" style={{ marginBottom: 10 }}>
              {plan.liveKeysNotInBackup.length} live key(s) are not in this backup — created since it ran.
            </div>
          )}
          <table className="admin-backup-table">
            <thead><tr><th>Key</th><th>Entries</th><th>Checksum</th><th>vs live</th><th /></tr></thead>
            <tbody>
              {results.map(({ f, c }) => {
                const d = c?.diff;
                const same = d && !d.missingFromLive && !d.onlyInLive && !d.valuesDiffer;
                return (
                  <tr key={f.key}>
                    <td className="admin-backup-fam">{f.key}</td>
                    <td>{f.entries?.toLocaleString?.() ?? f.entries}</td>
                    <td>{c?.pending ? '…' : c?.error ? '✗' : c ? (c.checksumOk ? '✓' : '✗') : '—'}</td>
                    <td>
                      {c?.error ? <span style={{ color: '#fca5a5' }}>{c.error}</span>
                        : !d ? '—'
                        : !c.existsLive ? 'not live'
                        : same ? 'identical'
                        : `−${d.missingFromLive ?? 0} +${d.onlyInLive ?? 0} ~${d.valuesDiffer ?? 0}`}
                    </td>
                    <td>
                      {c?.rehearsal
                        ? <span title={`wrote ${c.rehearsal.written} to ${c.rehearsal.dest}`}>rehearsed ✓</span>
                        : <button className="admin-tiny-btn" onClick={() => rehearse(f.key)} disabled={busy}>Rehearse</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}


// Service-account connectivity test. Wiring the backup credential involves
// several things that can each fail quietly — a malformed PEM, the Drive API
// off, the account not added to the Shared Drive — so this walks the whole
// path and names the step that broke rather than leaving it to trial and error.
function SaTestSection() {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true); setResult(null);
    try {
      const r = await fetch('/api/backup?mode=sa-test');
      setResult(await r.json());
    } catch (e) {
      setResult({ ok: false, steps: [{ name: 'Request', ok: false, detail: e.message }] });
    } finally { setBusy(false); }
  }

  return (
    <section className="admin-section">
      <h2 className="admin-section-title">Backup credential</h2>
      <p className="admin-sub" style={{ marginBottom: 16, maxWidth: 640 }}>
        The nightly backup will run as a service account rather than as whoever is signed in,
        because this app's Google client is still in Testing mode and those refresh tokens expire
        every 7 days. This checks that credential end to end — it writes a small probe file into
        the backup folder and removes it again.
      </p>

      <button className="admin-run-btn" onClick={run} disabled={busy}>
        {busy ? 'Testing…' : 'Test the service account'}
      </button>

      {result && (
        <div className="admin-backup" style={{ marginTop: 16 }}>
          <div className={`admin-backup-result${result.ok ? ' ok' : ' warn'}`}>
            <strong>{result.ok ? '✓ The service account can read and write the backup folder' : '✗ Not ready yet'}</strong>
            {result.error && <div>{result.error}</div>}
          </div>
          <ul className="admin-sa-steps">
            {(result.steps || []).map((s, i) => (
              <li key={i} className={s.ok ? 'ok' : 'bad'}>
                <span className="admin-sa-mark">{s.ok ? '✓' : '✗'}</span>
                <span>
                  <strong>{s.name}</strong>
                  {s.detail && <div className="admin-sa-detail">{s.detail}</div>}
                  {!s.ok && s.hint && <div className="admin-sa-hint">{s.hint}</div>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
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
      {tab === 'fmp' && <><FmpSyncSection /><FmpTab /></>}
      {tab === 'backup' && <><SaTestSection /><BackupTab /><RestoreSection /></>}
      {tab === 'vocab' && <VocabTab />}
      {tab === 'wsemail' && <WorkshopEmailTab />}
      {tab === 'agent' && <AgentTab />}
      {tab === 'drift' && <DriftTab />}
    </main>
  );
}
