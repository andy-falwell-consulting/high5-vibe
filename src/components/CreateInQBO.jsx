import { useState, useCallback, useMemo } from 'react';
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
  const [customer, setCustomer] = useState(null);       // {id, name}
  const [customerAlts, setCustomerAlts] = useState([]);
  const [lines, setLines] = useState([]);               // {productName, productRecordId, description, qty, unitPrice, amount, itemId, itemName, linked, picked}
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState(null);

  const openPanel = useCallback(async () => {
    setOpen(true); setLoading(true); setError(null); setResult(null);
    try {
      const [catRes, resRes] = await Promise.all([
        fetch(`/api/qbo-items?env=${env}`, { credentials: 'include' }).then(r => r.json()),
        fetch('/api/qbo-resolve', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ env, customerName: draft.customerName, itemNames: draft.lines.map(l => l.productName) }),
        }).then(r => r.json()),
      ]);
      if (resRes.error) throw new Error(resRes.error);
      setCatalog((catRes.items || []).filter(i => i.active !== false));
      setCustomer(resRes.customer?.matched || null);
      setCustomerAlts(resRes.customer?.matches || []);
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
      // Remember picks: write the chosen QBO item id onto the product.
      await Promise.all(lines.filter(l => l.picked && l.productRecordId && l.itemId)
        .map(l => updateRecord(PROD_LAYOUT, l.productRecordId, { _kat__Item_ID_QuickBooks: String(l.itemId) }).catch(() => {})));

      const body = {
        env, type, customerId: customer.id, txnDate: draft.txnDate, memo: draft.memo, docNumber: draft.docNumber,
        lines: lines.map(l => ({ itemId: l.itemId, qty: l.qty, unitPrice: l.unitPrice, amount: l.amount, description: l.description || l.productName })),
      };
      const res = await fetch('/api/qbo-estimate-create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Create failed');
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
                      {customerAlts.length > 0 ? (
                        <select value={customer?.id || ''} onChange={e => setCustomer(customerAlts.find(c => c.id === e.target.value))}>
                          {customerAlts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      ) : <span className="ciq-nomatch">No QBO customer matched “{draft.customerName}” — cannot create.</span>}
                    </div>
                    <table className="ciq-lines">
                      <thead><tr><th>Line (from High5)</th><th>QBO item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Amount</th></tr></thead>
                      <tbody>
                        {lines.map((l, i) => (
                          <tr key={i} className={l.itemId ? '' : 'ciq-unresolved'}>
                            <td>{l.productName || l.description || '—'}</td>
                            <td>
                              {l.linked ? <span className="ciq-linked" title="Linked product">{l.itemName}</span>
                                : <ItemPicker catalog={catalog} value={l.itemId} onChange={(id, name) => pickItem(i, id, name)} />}
                            </td>
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
