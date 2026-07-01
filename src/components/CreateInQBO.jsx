import { useState, useCallback, useMemo, useEffect } from 'react';
import { updateRecord } from '../api/filemaker';
import './CreateInQBO.css';

// Shared "Create in QBO" panel. Any module builds a `draft` and drops this in.
//   draft = { customerName, txnDate, memo, docNumber,
//             lines: [{ productName, description, qty, unitPrice, amount }] }
//   type: 'estimate' (invoice later) · env: 'production' | 'sandbox'
//   onCreated(qboId, result) — host writes the id back to its own field.
// Picking a QBO item for an unlinked line writes _kat__Item_ID_QuickBooks onto
// that product (Products & Services_New), so the mapping is remembered.
const money = v => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
const PROD_LAYOUT = 'Products & Services_New';

// Read a JSON response, turning empty bodies / timeouts into a clear message.
async function jsonOrThrow(res, label) {
  const txt = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label} failed (${res.status})${txt ? ': ' + txt.slice(0, 140) : res.status === 504 ? ' — timed out' : ''}`);
  if (!txt) throw new Error(`${label} returned no data (likely timed out)`);
  try { return JSON.parse(txt); } catch { throw new Error(`${label} returned invalid data`); }
}

function CustomerPicker({ env, value, initial, onChange }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState(initial || []);
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) { setResults(initial || []); return; }
    const h = setTimeout(async () => {
      try { const j = await fetch(`/api/qbo-customer-search?env=${env}&q=${encodeURIComponent(term)}`, { credentials: 'include' }).then(r => r.json()); setResults(j.customers || []); } catch { setResults([]); }
    }, 300);
    return () => clearTimeout(h);
  }, [q, open, env, initial]);
  return (
    <div className="ciq-picker" style={{ flex: 1 }}>
      <button type="button" className={`ciq-picker-btn${value ? '' : ' empty'}`} onClick={() => setOpen(o => !o)}>
        {value ? value.name : '— search & pick QBO customer —'}
      </button>
      {open && (
        <div className="ciq-picker-pop">
          <input autoFocus className="ciq-picker-search" placeholder="Search QBO customers…" value={q} onChange={e => setQ(e.target.value)} />
          <div className="ciq-picker-list">
            {results.map(c => (
              <div key={c.id} className={`ciq-picker-opt${value?.id === c.id ? ' on' : ''}`} onClick={() => { onChange(c); setOpen(false); setQ(''); }}>{c.name}</div>
            ))}
            {results.length === 0 && <div className="ciq-picker-empty">{q.trim().length < 2 ? 'Type to search…' : 'No match'}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function ItemPicker({ catalog, value, onChange }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const sel = value ? catalog.find(i => i.id === value) : null;
  const filtered = useMemo(() => {
    if (!q.trim()) return catalog.slice(0, 50);
    const n = q.toLowerCase();
    return catalog.filter(i => i.name.toLowerCase().includes(n)).slice(0, 50);
  }, [q, catalog]);
  return (
    <div className="ciq-picker">
      <button type="button" className={`ciq-picker-btn${sel ? '' : ' empty'}`} onClick={() => setOpen(o => !o)}>
        {sel ? sel.name : '— pick QBO item —'}
      </button>
      {open && (
        <div className="ciq-picker-pop">
          <input autoFocus className="ciq-picker-search" placeholder="Search QBO items…" value={q} onChange={e => setQ(e.target.value)} />
          <div className="ciq-picker-list">
            {filtered.map(i => (
              <div key={i.id} className={`ciq-picker-opt${i.id === value ? ' on' : ''}`}
                onClick={() => { onChange(i.id, i.name); setOpen(false); setQ(''); }}>{i.name}</div>
            ))}
            {filtered.length === 0 && <div className="ciq-picker-empty">No match</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function CreateInQBO({ type = 'estimate', env = 'production', draft, existingId, onCreated, label }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [customerInitial, setCustomerInitial] = useState([]);
  const [lines, setLines] = useState([]);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState(null);

  const openPanel = useCallback(async () => {
    setOpen(true); setLoading(true); setError(null); setResult(null);
    try {
      const [catRes, resRes] = await Promise.all([
        fetch(`/api/qbo-items?env=${env}`, { credentials: 'include' }).then(r => jsonOrThrow(r, 'Catalog')),
        fetch('/api/qbo-resolve', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ env, customerName: draft.customerName, itemNames: draft.lines.map(l => l.productName) }),
        }).then(r => jsonOrThrow(r, 'Resolve')),
      ]);
      if (resRes.error) throw new Error(resRes.error);
      setCatalog((catRes.items || []).filter(i => i.active !== false));
      setCustomer(resRes.customer?.matched || null);
      setCustomerInitial(resRes.customer?.matches || []);
      setLines(draft.lines.map((l, i) => {
        const r = resRes.items[i] || {};
        return {
          ...l, productRecordId: r.productRecordId || null,
          itemId: r.matched?.id || null, itemName: r.matched?.name || null,
          linked: !!r.matched?.linked, picked: false,
        };
      }));
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [draft, env]);

  const pickItem = (idx, id, name) => setLines(ls => ls.map((l, i) => i === idx ? { ...l, itemId: id, itemName: name, picked: !l.linked } : l));
  const ready = customer && lines.length > 0 && lines.every(l => l.itemId);
  const total = lines.reduce((a, l) => a + Number(l.amount || (Number(l.qty || 1) * Number(l.unitPrice || 0))), 0);

  const doCreate = async () => {
    setCreating(true); setError(null);
    try {
      await Promise.all(lines.filter(l => l.picked && l.productRecordId && l.itemId)
        .map(l => updateRecord(PROD_LAYOUT, l.productRecordId, { _kat__Item_ID_QuickBooks: String(l.itemId) }).catch(() => {})));
      const body = {
        env, type, customerId: customer.id, txnDate: draft.txnDate, memo: draft.memo, docNumber: draft.docNumber,
        lines: lines.map(l => ({ itemId: l.itemId, qty: l.qty, unitPrice: l.unitPrice, amount: l.amount, description: l.description || l.productName })),
      };
      const data = await fetch('/api/qbo-estimate-create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body),
      }).then(r => jsonOrThrow(r, 'Create'));
      if (!data.ok) throw new Error(data.error || 'Create failed');
      setResult(data);
      onCreated?.(data.id, data);
    } catch (e) { setError(e.message); }
    finally { setCreating(false); }
  };

  const typeLabel = type === 'invoice' ? 'invoice' : 'estimate';

  return (
    <>
      <button className="ciq-trigger" onClick={openPanel} disabled={!!existingId}>
        {existingId ? `✓ In QBO #${existingId}` : (label || `Create QBO ${typeLabel}`)}
      </button>
      {open && (
        <div className="ciq-backdrop" onClick={e => e.target === e.currentTarget && setOpen(false)}>
          <div className="ciq-modal">
            <div className="ciq-head"><h2>Create QBO {typeLabel} {env === 'sandbox' && <span className="ciq-sandbox">SANDBOX</span>}</h2><button className="ciq-x" onClick={() => setOpen(false)}>✕</button></div>

            {loading ? <div className="ciq-body ciq-center">Resolving against QuickBooks…</div>
              : result ? (
                <div className="ciq-body ciq-center">
                  <div className="ciq-done">✓ Created QBO {typeLabel} <b>#{result.docNumber}</b> (id {result.id}) — {money(result.total)}</div>
                  <button className="ciq-btn" onClick={() => setOpen(false)}>Done</button>
                </div>
              ) : (
                <>
                  <div className="ciq-body">
                    <div className="ciq-cust">
                      <label>Customer</label>
                      <CustomerPicker env={env} value={customer} initial={customerInitial} onChange={setCustomer} />
                    </div>
                    <table className="ciq-lines">
                      <thead><tr><th>Line (from High5)</th><th>QBO item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Amount</th></tr></thead>
                      <tbody>
                        {lines.map((l, i) => (
                          <tr key={i} className={l.itemId ? '' : 'ciq-unresolved'}>
                            <td>{l.productName || l.description || '—'}</td>
                            <td>{l.linked ? <span className="ciq-linked" title="Linked product">{l.itemName}</span>
                              : <ItemPicker catalog={catalog} value={l.itemId} onChange={(id, name) => pickItem(i, id, name)} />}</td>
                            <td className="num">{l.qty}</td><td className="num">{money(l.unitPrice)}</td><td className="num">{money(l.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {error && <div className="ciq-error">{error}</div>}
                  </div>
                  <div className="ciq-foot">
                    <span className="ciq-total">Total {money(total)}</span>
                    <span className="ciq-spacer" />
                    <button className="ciq-btn ghost" onClick={() => setOpen(false)}>Cancel</button>
                    <button className="ciq-btn" onClick={doCreate} disabled={!ready || creating}>
                      {creating ? 'Creating…' : `Create in QuickBooks${env === 'sandbox' ? ' (sandbox)' : ''}`}
                    </button>
                  </div>
                </>
              )}
          </div>
        </div>
      )}
    </>
  );
}
