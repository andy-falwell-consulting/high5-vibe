import { useState, useEffect, useRef, useCallback } from 'react';
import './BomPickerModal.css';

export default function BomPickerModal({ allRecords, onAdd, onClose }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [adding, setAdding] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = search.trim().length === 0 ? [] : allRecords.filter(r => {
    const q = search.toLowerCase();
    const f = r.fieldData;
    return (
      f.Name?.toLowerCase().includes(q) ||
      f.SKU?.toLowerCase().includes(q) ||
      f.Category?.toLowerCase().includes(q) ||
      f.Description?.toLowerCase().includes(q)
    );
  }).slice(0, 50);

  const handleAdd = useCallback(async () => {
    if (!selected || quantity < 1) return;
    setAdding(true);
    await onAdd({ item: selected, quantity: Number(quantity) });
    setAdding(false);
  }, [selected, quantity, onAdd]);

  return (
    <div className="bom-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bom-modal">
        {/* Header */}
        <div className="bom-header">
          <h2>Add to Bill of Materials</h2>
          <button className="bom-close" onClick={onClose}>✕</button>
        </div>

        {/* Search */}
        <div className="bom-search-wrap">
          <span className="bom-search-icon">⌕</span>
          <input
            ref={searchRef}
            className="bom-search"
            placeholder="Search by name, SKU, category, description…"
            value={search}
            onChange={e => { setSearch(e.target.value); setSelected(null); }}
          />
          {search && <button className="bom-clear" onClick={() => { setSearch(''); setSelected(null); searchRef.current?.focus(); }}>✕</button>}
        </div>

        <div className="bom-body">
          {/* Results list */}
          <div className="bom-results">
            {search.trim().length === 0 && (
              <div className="bom-hint">Start typing to search all {allRecords.length.toLocaleString()} products &amp; services</div>
            )}
            {search.trim().length > 0 && filtered.length === 0 && (
              <div className="bom-hint">No results for "{search}"</div>
            )}
            {filtered.map(r => {
              const f = r.fieldData;
              const isSelected = selected?.recordId === r.recordId;
              return (
                <div
                  key={r.recordId}
                  className={`bom-result-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => setSelected(r)}
                >
                  <div className="bom-result-main">
                    <span className="bom-result-name">{f.Name}</span>
                    {f.SKU && <span className="bom-result-sku">{f.SKU}</span>}
                  </div>
                  <div className="bom-result-meta">
                    {f.Category && <span className="bom-result-cat">{f.Category}</span>}
                    {f.Type && <span className="bom-result-type">{f.Type}</span>}
                    {f.Unit_Price != null && (
                      <span className="bom-result-price">${Number(f.Unit_Price).toFixed(2)}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected item + quantity */}
          <div className="bom-sidebar">
            {!selected ? (
              <div className="bom-sidebar-empty">
                <div className="bom-sidebar-empty-icon">⊞</div>
                <p>Select an item from the list</p>
              </div>
            ) : (
              <div className="bom-selected-detail">
                <div className="bom-selected-header">Selected Item</div>
                <div className="bom-selected-name">{selected.fieldData.Name}</div>
                {selected.fieldData.SKU && (
                  <div className="bom-selected-sku">{selected.fieldData.SKU}</div>
                )}
                {selected.fieldData.Description && (
                  <div className="bom-selected-desc">{selected.fieldData.Description}</div>
                )}
                <div className="bom-selected-prices">
                  {selected.fieldData.Cost != null && (
                    <div className="bom-price-row">
                      <span>Cost</span>
                      <strong>${Number(selected.fieldData.Cost).toFixed(2)}</strong>
                    </div>
                  )}
                  {selected.fieldData.Unit_Price != null && (
                    <div className="bom-price-row">
                      <span>Unit Price</span>
                      <strong>${Number(selected.fieldData.Unit_Price).toFixed(2)}</strong>
                    </div>
                  )}
                </div>

                <div className="bom-qty-wrap">
                  <label>Quantity</label>
                  <div className="bom-qty-control">
                    <button onClick={() => setQuantity(q => Math.max(1, Number(q) - 1))}>−</button>
                    <input
                      type="number"
                      min="1"
                      value={quantity}
                      onChange={e => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                    />
                    <button onClick={() => setQuantity(q => Number(q) + 1)}>+</button>
                  </div>
                  {selected.fieldData.Unit_Price != null && (
                    <div className="bom-qty-total">
                      Total: ${(Number(selected.fieldData.Unit_Price) * quantity).toFixed(2)}
                    </div>
                  )}
                </div>

                <button
                  className="bom-add-btn"
                  onClick={handleAdd}
                  disabled={adding}
                >
                  {adding ? 'Adding…' : `Add ${quantity} × ${selected.fieldData.Name}`}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
