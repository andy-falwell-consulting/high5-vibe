import { qboLink } from '../config/qboLinks';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { BRAND, UI } from '../config/brandColors'
import ListToolbar, { useListControls } from './ListControls';

const ROW_H = 54; // fixed row height (px) — must match .txn-row in CSS for virtualization
import './Transactions.css';
import { useRecordPanel } from '../hooks/useRecordPanel';
import { LINE_META, ORIGIN_META, lineLabel, lineShort, lineTone, originLabel, originShort, LINE_ORDER, ORIGIN_ORDER } from '../config/txnSource';

// Read-only ledger of QBO sales transactions (mirror served by /api/transactions).
// Shopify orders appear here as Sales Receipts.
const TYPE_META = {
  Invoice:      { label: 'Invoice',      short: 'INV', color: '#3b82f6' },
  Estimate:     { label: 'Estimate',     short: 'EST', color: '#8b5cf6' },
  SalesReceipt: { label: 'Sales Receipt', short: 'SR',  color: '#22c55e' },
  CreditMemo:   { label: 'Credit Memo',  short: 'CM',  color: '#f59e0b' },
};
const TYPE_ORDER = ['Invoice', 'Estimate', 'SalesReceipt', 'CreditMemo'];

// QBO web-app deep-link path per transaction type (…/app/<path>?txnId=<id>).

const money = v => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Why the source says what it says, in words rather than a rule name.
//
// A label nobody can interrogate is a label nobody should trust — around half
// the ledger has no recorded source at all, so the ones that DO claim something
// have to be able to show their working.
const WHY = {
  stamp: 'Vibe stamped its own reference on this record when it created it.',
  link: "QuickBooks' own link between this transaction and the estimate.",
  docNumber: 'The document number follows the online store\u2019s own numbering.',
  customer: 'The customer QuickBooks files these under.',
  note: 'An estimate number typed into the internal memo \u2014 free text, so this one is inferred rather than certain.',
  type: 'An estimate is not from anywhere; it is where a piece of work starts.',
  none: 'Nothing on this record names a source. Most of the ledger before 2018 is like this.',
};
const parseDate = v => { if (!v) return 0; const [y, m, d] = String(v).split('-'); return new Date(`${y}-${m}-${d}T00:00:00`).getTime() || 0; };
const fmtDate = v => { const t = parseDate(v); return t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; };

function statusColor(s) {
  const t = String(s || '').toLowerCase();
  if (t === 'paid') return UI.success;
  if (t === 'overdue' || t === 'unapplied') return UI.danger;
  if (t === 'open' || t === 'pending') return BRAND.gold;
  if (t === 'accepted' || t === 'closed' || t === 'applied') return BRAND.blue;
  return UI.muted;
}

async function loadAll() {
  let cursor = '0', all = [], guard = 0;
  do {
    const r = await fetch(`/api/transactions?cursor=${cursor}`, { credentials: 'include' });
    if (!r.ok) throw new Error(`load failed (${r.status})`);
    const j = await r.json();
    all.push(...(j.records || []));
    cursor = j.cursor;
  } while (cursor !== '0' && ++guard < 200);
  return all;
}

export default function Transactions({ onRecordSelect } = {}) {
  // Widest default of any module: a row carries a type chip, a document
  // number, an amount, a customer and a date, and 340px could not hold them.
  const { width, onPointerDown: startPanelResize } = useRecordPanel('transactions', 400);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [originFilter, setOriginFilter] = useState('all');
  const [lineFilter, setLineFilter] = useState('all');
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    loadAll().then(rs => { if (alive) { setRecords(rs); setLoading(false); } })
      .catch(e => { if (alive) { setError(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  // Status options derived from the loaded set (memoized — don't rescan 34k every render).
  const statuses = useMemo(() => Array.from(new Set(records.map(r => r.status).filter(Boolean))).sort(), [records]);

  const controls = useListControls({
    records,
    storageKey: 'transactions',
    fields: r => r,
    name: r => r.customerName || '',
    searchKeys: ['docNumber', 'customerName', 'type'],
    chips: [
      { id: 'all', label: 'All' },
      ...TYPE_ORDER.map(t => ({ id: t, label: TYPE_META[t].label + 's', color: TYPE_META[t].color, match: f => f.type === t })),
    ],
    // One predicate for all three dropdowns — useListControls takes a single
    // extraFilter, and combining them here keeps the count in the toolbar honest.
    extraFilter: (statusFilter === 'all' && originFilter === 'all' && lineFilter === 'all')
      ? undefined
      : (f => (statusFilter === 'all' || f.status === statusFilter)
           && (originFilter === 'all' || (f.src?.o || 'unknown') === originFilter)
           && (lineFilter === 'all' || (f.src?.l || '') === lineFilter)),
    sorts: [
      { id: 'date', label: 'Date', value: f => parseDate(f.date) },
      { id: 'amount', label: 'Amount', value: f => Number(f.total || 0) },
      { id: 'number', label: 'Number', value: f => Number(f.docNumber) || 0 },
      { id: 'customer', label: 'Customer', value: f => (f.customerName || '').toLowerCase() },
    ],
    defaultSort: 'date',
    defaultOrder: 'desc',
  });

  // Virtualized list — render only the rows in view (the ledger can be 30k+ rows;
  // rendering them all bloats the DOM and slows the whole app).
  const scrollRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(800);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || 800));
    ro.observe(el);
    setViewH(el.clientHeight || 800);
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); };
  }, [loading, error]);
  const rows = controls.processed;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
  const endIdx = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 6);
  const visibleRows = rows.slice(startIdx, endIdx);

  const handleSelect = useCallback((r) => {
    setSelected(r); setDetail(null);
    fetch(`/api/transactions?id=${encodeURIComponent(r.type + ':' + r.id)}`, { credentials: 'include' })
      .then(res => res.ok ? res.json() : null)
      .then(d => { if (d) setDetail(d); })
      .catch(() => {});
    onRecordSelect?.(r.type + ':' + r.id, r.docNumber);
  }, [onRecordSelect]);

  const viewPdf = async (r) => {
    if (!r) return;
    setPdfBusy(true);
    const win = window.open('', '_blank');
    try {
      const resp = await fetch('/api/txn-pdf', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ type: r.type, id: r.id }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.base64) { win?.close(); window.alert('Could not load the PDF.'); return; }
      const bytes = Uint8Array.from(atob(data.base64), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      if (win) win.location = url; else window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { win?.close(); window.alert('Could not load the PDF.'); }
    finally { setPdfBusy(false); }
  };

  const d = detail || selected;

  return (
    <div className="txn-container">
      <aside className="txn-sidebar" style={{ width }}>
        <ListToolbar c={controls} />
        <div className="txn-statusbar">
          <label>Status</label>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="all">All</option>
            {statuses.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <label>Source</label>
          <select value={originFilter} onChange={e => setOriginFilter(e.target.value)}>
            <option value="all">All</option>
            {ORIGIN_ORDER.filter(k => ORIGIN_META[k]).map(k => <option key={k} value={k}>{originLabel(k)}</option>)}
          </select>
          <label>Work</label>
          <select value={lineFilter} onChange={e => setLineFilter(e.target.value)}>
            <option value="all">All</option>
            {LINE_ORDER.filter(k => LINE_META[k]).map(k => <option key={k} value={k}>{lineLabel(k)}</option>)}
          </select>
        </div>
        {loading && records.length === 0 ? (
          <div className="txn-loading">{Array.from({ length: 12 }, (_, i) => <div key={i} className="txn-skeleton" />)}</div>
        ) : error ? (
          <div className="txn-empty"><p>Failed to load transactions.</p><p className="dim">{error}</p></div>
        ) : rows.length === 0 ? (
          <div className="txn-empty"><p>No transactions match.</p></div>
        ) : (
          <div className="txn-scroll" ref={scrollRef}>
            <div className="txn-virtual" style={{ height: rows.length * ROW_H }}>
              {visibleRows.map((r, i) => {
                const idx = startIdx + i;
                const tm = TYPE_META[r.type] || {};
                return (
                  <div key={r.type + r.id}
                    className={`txn-row ${selected && selected.id === r.id && selected.type === r.type ? 'active' : ''}`}
                    style={{ top: idx * ROW_H }}
                    onClick={() => handleSelect(r)}>
                    <span className="txn-type" style={{ background: tm.color + '22', color: tm.color }}>{tm.short}</span>
                    <div className="txn-row-main">
                      {/* The chips sit on the TOP line, beside the document
                          number, because that line has slack and the one below
                          does not: a customer name is the longest thing on the
                          row and squeezing it to "Prosper Valle…" to make room
                          costs more than it gives. */}
                      <div className="txn-row-top">
                        <span className="txn-num">#{r.docNumber || '—'}</span>
                        {/* An estimate's origin is itself, which is not worth a
                            chip on every one of 8,970 rows — the type chip
                            already says it. */}
                        {r.src?.o && r.src.o !== 'self' && (
                          <span className={`txn-src-chip o-${r.src.o}`} title={originLabel(r.src.o)}>{originShort(r.src.o)}</span>
                        )}
                        {r.src?.l && (
                          <span className={`txn-src-chip tone-${lineTone(r.src.l)}`} title={lineLabel(r.src.l)}>{lineShort(r.src.l)}</span>
                        )}
                        <span className="txn-amt">{money(r.total)}</span>
                      </div>
                      <div className="txn-row-sub">
                        <span className="txn-cust">{r.customerName || '—'}</span>
                        <span className="txn-date">{fmtDate(r.date)}</span>
                      </div>
                    </div>
                    <span className="txn-status-dot" style={{ background: statusColor(r.status) }} title={r.status} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </aside>

      {/* This page had NO resize handle and was pinned at 340px in CSS —
          the reason its rows felt cramped. Every other module has had one
          for months. */}
      <div className="txn-resize" onPointerDown={startPanelResize} />

      <main className="txn-main">
        {!d ? (
          <div className="txn-placeholder">Select a transaction</div>
        ) : (
          <div className="txn-detail">
            <div className="txn-detail-head">
              <div>
                <span className="txn-type-lg" style={{ background: (TYPE_META[d.type]?.color || '#888') + '22', color: TYPE_META[d.type]?.color }}>
                  {TYPE_META[d.type]?.label || d.type}
                </span>
                <h1>#{d.docNumber || '—'}</h1>
                <div className="txn-detail-sub">
                  <span className="txn-detail-cust">{d.customerName || '—'}</span>
                  <span className="txn-detail-qbo">QBO ID {d.id}</span>
                </div>
              </div>
              <div className="txn-detail-actions">
                <a className="txn-pdf-btn" href={qboLink(d.type, d.id)}
                  target="_blank" rel="noreferrer" title="Open this transaction in QuickBooks Online">Open in QBO ↗</a>
                <button className="txn-pdf-btn" onClick={() => viewPdf(d)} disabled={pdfBusy}>{pdfBusy ? 'Loading…' : '↧ PDF'}</button>
              </div>
            </div>

            <div className="txn-kpis">
              <div className="txn-kpi"><div className="txn-kpi-l">Date</div><div className="txn-kpi-v">{fmtDate(d.date)}</div></div>
              <div className="txn-kpi"><div className="txn-kpi-l">Total</div><div className="txn-kpi-v">{money(d.total)}</div></div>
              {d.type === 'Invoice' || d.type === 'CreditMemo' ? (
                <div className="txn-kpi"><div className="txn-kpi-l">Balance</div><div className="txn-kpi-v" style={{ color: d.balance > 0 ? '#ED1C24' : 'inherit' }}>{money(d.balance)}</div></div>
              ) : null}
              <div className="txn-kpi"><div className="txn-kpi-l">Status</div><div className="txn-kpi-v" style={{ color: statusColor(d.status) }}>{d.status}</div></div>
            </div>

            {d.source && (
              <div className="txn-lines-card">
                <div className="txn-lines-head">Source</div>
                <div className="txn-source-body">
                  <div className="txn-source-row">
                    <span className="txn-source-l">Came from</span>
                    <span className="txn-source-v">
                      <span className={`txn-src-chip o-${d.source.origin.kind}`}>{originShort(d.source.origin.kind) || 'Estimate'}</span>
                      {d.source.origin.label}
                      {d.source.origin.ref && <span className="txn-source-ref">{d.source.origin.ref}</span>}
                      {/* Said out loud rather than shown as a colour: an
                          inference and a fact should not look alike. */}
                      {d.source.origin.confidence === 'likely' && <span className="txn-source-maybe">inferred</span>}
                    </span>
                  </div>
                  <div className="txn-source-row">
                    <span className="txn-source-l">Kind of work</span>
                    <span className="txn-source-v">
                      {d.source.line
                        ? <><span className={`txn-src-chip tone-${lineTone(d.source.line)}`}>{lineShort(d.source.line)}</span>{lineLabel(d.source.line)}</>
                        : <span className="dim">Not classified \u2014 the line items name no account.</span>}
                    </span>
                  </div>
                  <p className="txn-source-why">{WHY[d.source.origin.why] || ''}</p>
                  {d.note && <p className="txn-source-note">Internal memo: {d.note}</p>}
                  {d.po && <p className="txn-source-note">P.O. {d.po}</p>}
                </div>
              </div>
            )}

            <div className="txn-lines-card">
              <div className="txn-lines-head">Line items</div>
              {detail ? (
                (detail.lines || []).length === 0
                  ? <p className="dim" style={{ padding: '10px 14px' }}>No line items.</p>
                  : <table className="txn-lines">
                      <thead><tr><th>Item / description</th><th className="num">Qty</th><th className="num">Amount</th></tr></thead>
                      <tbody>{detail.lines.map((l, i) => (
                        <tr key={i}><td>{l.item ? <strong>{l.item}</strong> : null}{l.item && l.desc ? ' — ' : ''}{l.desc}</td><td className="num">{l.qty ?? ''}</td><td className="num">{money(l.amount)}</td></tr>
                      ))}</tbody>
                    </table>
              ) : <p className="dim" style={{ padding: '10px 14px' }}>Loading…</p>}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
