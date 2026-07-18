import { useState } from 'react';
import { CATEGORIES, TYPES, VENDORS, QBO_INCOME, QBO_CLASS } from '../config/productOptions';
import './NewItemModal.css';

export default function NewItemModal({ onClose, onCreate }) {
  const [fields, setFields] = useState({
    Name: '', Type: 'Product', Category: 'Hardware', Vendor: '', vendor_sku: '',
    QuickBooks_Account_Income: '', qbo_class: '',
    Cost: '', Unit_Price: '', Description: '', shopify_description: '',
  });
  const [pushShopify, setPushShopify] = useState(false);
  const [shopifyStatus, setShopifyStatus] = useState('draft');
  const [pushQBO, setPushQBO] = useState(false);
  const [status, setStatus] = useState(null); // null | 'saving' | 'error'
  const [errorMsg, setErrorMsg] = useState('');

  const set = (k, v) => setFields(f => ({ ...f, [k]: v }));

  const handleSubmit = async () => {
    if (!fields.Name.trim()) { setErrorMsg('Name is required.'); setStatus('error'); return; }
    setStatus('saving'); setErrorMsg('');
    try {
      await onCreate({ fields, pushShopify, shopifyStatus, pushQBO });
      onClose();
    } catch (e) {
      setErrorMsg(e.message || 'Something went wrong.');
      setStatus('error');
    }
  };

  return (
    <div className="nim-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="nim-drawer">
        <div className="nim-header">
          <h2>New Product / Service</h2>
          <button className="nim-close" onClick={onClose}>✕</button>
        </div>

        <div className="nim-body">
          {/* Core fields */}
          <section className="nim-section">
            <h3>FileMaker</h3>
            <div className="nim-grid">
              <label>Name *
                <input value={fields.Name} onChange={e => set('Name', e.target.value)} placeholder="Product name" />
              </label>
              <label>High 5 Sku
                <input value="Assigned automatically on save" readOnly disabled className="nim-readonly" />
              </label>
              <label>Type
                <select value={fields.Type} onChange={e => set('Type', e.target.value)}>
                  {TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </label>
              <label>Category
                <select value={fields.Category} onChange={e => set('Category', e.target.value)}>
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </label>
              <label>Vendor
                <select value={fields.Vendor} onChange={e => set('Vendor', e.target.value)}>
                  <option value="">—</option>
                  {VENDORS.map(v => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label>Vendor SKU
                <input value={fields.vendor_sku} onChange={e => set('vendor_sku', e.target.value)} placeholder="Vendor's part #" />
              </label>
              <label>Cost ($)
                <input type="number" value={fields.Cost} onChange={e => set('Cost', e.target.value)} placeholder="0.00" step="0.01" />
              </label>
              <label>Unit Price ($)
                <input type="number" value={fields.Unit_Price} onChange={e => set('Unit_Price', e.target.value)} placeholder="0.00" step="0.01" />
              </label>
              <label>QBO Income Account
                <select value={fields.QuickBooks_Account_Income} onChange={e => set('QuickBooks_Account_Income', e.target.value)}>
                  <option value="">—</option>
                  {QBO_INCOME.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </label>
              <label>QBO Class
                <select value={fields.qbo_class} onChange={e => set('qbo_class', e.target.value)}>
                  <option value="">—</option>
                  {QBO_CLASS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </label>
            </div>
            <label className="nim-wide">Description
              <textarea value={fields.Description} onChange={e => set('Description', e.target.value)} rows={3} placeholder="Product description…" />
            </label>
            <label className="nim-wide">Shopify Description
              <textarea value={fields.shopify_description} onChange={e => set('shopify_description', e.target.value)} rows={3} placeholder="Storefront description (Shopify)…" />
            </label>
          </section>

          {/* Shopify */}
          <section className="nim-section">
            <label className="nim-toggle">
              <input type="checkbox" checked={pushShopify} onChange={e => setPushShopify(e.target.checked)} />
              <span>Also create in <strong>Shopify</strong></span>
            </label>
            {pushShopify && (
              <div className="nim-grid nim-sub">
                <label>Status
                  <select value={shopifyStatus} onChange={e => setShopifyStatus(e.target.value)}>
                    <option value="draft">Draft</option>
                    <option value="active">Active</option>
                  </select>
                </label>
              </div>
            )}
          </section>

          {/* QBO */}
          <section className="nim-section">
            <label className="nim-toggle">
              <input type="checkbox" checked={pushQBO} onChange={e => setPushQBO(e.target.checked)} />
              <span>Also create in <strong>QuickBooks</strong></span>
            </label>
            {pushQBO && (
              <p className="nim-hint">Uses the <strong>QBO Income Account</strong> selected above (defaults to Store / Catalog Sales if blank).</p>
            )}
          </section>
        </div>

        <div className="nim-footer">
          {status === 'error' && <span className="nim-error">{errorMsg}</span>}
          <button className="nim-btn cancel" onClick={onClose}>Cancel</button>
          <button className="nim-btn save" onClick={handleSubmit} disabled={status === 'saving'}>
            {status === 'saving' ? 'Creating…' : 'Create Item'}
          </button>
        </div>
      </div>
    </div>
  );
}
