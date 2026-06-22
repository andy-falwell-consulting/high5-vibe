import { useEffect, useState, useCallback, useRef } from 'react';
import { getRecord, updateRecord, addPortalRow, containerImageUrl, createRecord } from '../api/filemaker';
import { getCurrentEnv } from '../config/fmpEnvironments';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import BomPickerModal from './BomPickerModal';
import NewItemModal from './NewItemModal';
import ImageLightbox from './ImageLightbox';
import { pushToShopify, pushToQBO } from '../api/integrations';
import { useAllRecords } from '../hooks/useAllRecords';
import './ProductsAndServicesV2.css';

const LAYOUT = 'Products & Services_New';

const CATEGORIES = ['Catalog','Hardware','Typical Component','Tool','Labor','Lumber','Low Element','High Element','Repair','Training'];
const TYPES = ['Product','Service'];
const VENDORS = ['AtHeight','Atomik Climbing','Edelrid','High 5','Liberty Mountain','Lavalley Building Supply, Perkins','Peak','Petzl','S&S','Sticker Mule'];
const QBO_INCOME = [
  { label: '4010 - Open Enrollment', value: '151' },
  { label: '4020 - Custom training', value: '177' },
  { label: '4021 - Adult Custom Direct Service', value: '112' },
  { label: '4022 - Corporate Programs', value: '116' },
  { label: '4023 - College Programs', value: '117' },
  { label: '4024 - Youth Programs', value: '118' },
  { label: '4050 - Program Review', value: '137' },
  { label: '4065 - Planning - Custom', value: '329' },
  { label: '4200 - Challenge Course Services', value: '236' },
  { label: '4210 - Low or High Elements (new installations)', value: '244' },
  { label: '4230 - Inspection Services', value: '303' },
  { label: '4240 - Repairs', value: '268' },
  { label: '4410 - Store / Catalog Sales', value: '155' },
  { label: '4430 - Manuals and Miscellaneous Items', value: '156' },
];
const QBO_CAT = [
  { label: 'CAT', value: '1300000000000836523' },
  { label: 'CCS', value: '1300000000000836514' },
  { label: 'DEV', value: '1300000000000836526' },
  { label: 'EOL', value: '1300000000000836525' },
  { label: 'EP',  value: '1300000000000836530' },
  { label: 'OE',  value: '1300000000000836522' },
  { label: 'OV',  value: '1300000000000836516' },
  { label: 'T&TD',value: '1300000000000836520' },
];

const FIELD_LABELS = {
  SKU: 'SKU', vendor_sku: 'Vendor SKU', Vendor: 'Vendor', Type: 'Type',
  Category: 'Category', Cost: 'Cost', Unit_Price: 'Unit Price',
  assembly_product: 'Assembly Product', price_override: 'Price Override',
  Description: 'Description', Notes: 'Notes', shopify_description: 'Shopify Description',
  _kat__Item_ID_QuickBooks: 'QuickBooks ID', _kat__Item_ID_Shopify: 'Shopify ID',
  _kat__Item_Variant_Id: 'Variant ID', QuickBooks_Account_Income: 'Income Account',
  qbo_class: 'QBO Class',
};

const CATEGORY_COLORS = {
  Hardware: '#3b82f6', Labor: '#8b5cf6', Lumber: '#f59e0b',
  Tool: '#10b981', Training: '#ec4899', Catalog: '#6366f1',
  'Low Element': '#14b8a6', 'High Element': '#f97316',
  'Typical Component': '#64748b', Repair: '#ef4444',
};

const URL_RE = /https?:\/\/[^\s\r\n]+/g;

function FormattedText({ text }) {
  const paragraphs = text.split(/\r\r|\n\n/);
  return (
    <div className="v2-text-block">
      {paragraphs.map((para, pi) => {
        const lines = para.split(/\r|\n/);
        const bullets = lines.filter(l => /^[\t\s]*[•\-]\t?/.test(l));
        const isBulletBlock = bullets.length > 0 && bullets.length >= lines.filter(l => l.trim()).length / 2;
        if (isBulletBlock) {
          const items = [];
          let prose = [];
          for (const line of lines) {
            if (/^[\t\s]*[•\-]\t?/.test(line)) {
              if (prose.length) { items.push({ type: 'prose', text: prose.join(' ').trim() }); prose = []; }
              items.push({ type: 'bullet', text: line.replace(/^[\t\s]*[•\-]\t?/, '').trim() });
            } else if (line.trim()) { prose.push(line.trim()); }
          }
          if (prose.length) items.push({ type: 'prose', text: prose.join(' ').trim() });
          return (
            <div key={pi} className="v2-para">
              {items.map((item, ii) =>
                item.type === 'bullet'
                  ? <div key={ii} className="v2-bullet"><span className="v2-bullet-dot">•</span><span><InlineText text={item.text} /></span></div>
                  : <p key={ii}><InlineText text={item.text} /></p>
              )}
            </div>
          );
        }
        const labelMatch = para.match(/^(Supplier|Manufacturer)\s*:\s*(.+?)(\r|\n)(https?:\/\/.+)/s);
        if (labelMatch) {
          return (
            <div key={pi} className="v2-source-block">
              <span className="v2-source-label">{labelMatch[1]}</span>
              <span className="v2-source-name">{labelMatch[2].trim()}</span>
              <a href={labelMatch[4].trim()} target="_blank" rel="noopener noreferrer" className="v2-source-url">{labelMatch[4].trim()}</a>
            </div>
          );
        }
        return <p key={pi} className="v2-para"><InlineText text={para.trim()} /></p>;
      })}
    </div>
  );
}

function InlineText({ text }) {
  const parts = text.split(URL_RE);
  const urls = text.match(URL_RE) || [];
  return parts.map((part, i) => (
    <span key={i}>{part}{urls[i] && <a href={urls[i]} target="_blank" rel="noopener noreferrer" className="v2-link">{urls[i]}</a>}</span>
  ));
}

function FieldValue({ fieldKey, value, onChange, dataEditing }) {
  const ch = (v) => onChange(fieldKey, v);
  const ro = !dataEditing;

  if (fieldKey === 'assembly_product' || fieldKey === 'price_override')
    return <div className="sl-toggle-wrap"><input type="checkbox" className="sl-toggle" checked={!!value} onChange={e => !ro && ch(e.target.checked ? 1 : '')} readOnly={ro} /></div>;

  if (fieldKey === 'Cost' || fieldKey === 'Unit_Price') {
    if (ro) return <span className="sl-value mono">{value != null ? `$${Number(value).toFixed(2)}` : '—'}</span>;
    return <input type="number" step="0.01" value={value ?? ''} onChange={e => ch(e.target.value)} className="sl-input mono" />;
  }

  if (fieldKey === 'Description' || fieldKey === 'Notes' || fieldKey === 'shopify_description') {
    if (ro) return value ? <FormattedText text={value} /> : <p className="v2-text-block">—</p>;
    return <textarea value={value || ''} onChange={e => ch(e.target.value)} className="sl-textarea" rows={5} />;
  }

  const selectOpts = (opts, hasNone) => (
    <select value={value || ''} onChange={e => !ro && ch(e.target.value)} disabled={ro} className="sl-select">
      {hasNone && <option value="">(none)</option>}
      {opts}
    </select>
  );

  if (fieldKey === 'Vendor') return selectOpts(VENDORS.map(x => <option key={x} value={x}>{x}</option>), true);
  if (fieldKey === 'Type') return selectOpts(TYPES.map(x => <option key={x} value={x}>{x}</option>), false);
  if (fieldKey === 'Category') return selectOpts(CATEGORIES.map(x => <option key={x} value={x}>{x}</option>), true);
  if (fieldKey === 'QuickBooks_Account_Income') return selectOpts(QBO_INCOME.map(x => <option key={x.value} value={x.value}>{x.label}</option>), true);
  if (fieldKey === 'qbo_class') return selectOpts(QBO_CAT.map(x => <option key={x.value} value={x.value}>{x.label}</option>), true);

  if (ro) return <span className="sl-value">{value || '—'}</span>;
  return <input type="text" value={value || ''} onChange={e => ch(e.target.value)} className="sl-input" />;
}

const AUTO_SYNC_FIELDS = new Set(['Name', 'Unit_Price', 'Description', 'SKU', 'QuickBooks_Account_Income']);

export default function ProductsAndServicesV2({ navTarget, onClearNav, onRecordSelect } = {}) {
  const { records, total, loading, error } = useAllRecords(LAYOUT, {
    cacheVersion: 4,
    slimForStorage: r => ({
      recordId: r.recordId,
      fieldData: {
        Name: r.fieldData.Name,
        SKU: r.fieldData.SKU,
        Unit_Price: r.fieldData.Unit_Price,
        Picture: r.fieldData.Picture,
        Vendor: r.fieldData.Vendor,
        Type: r.fieldData.Type,
        Category: r.fieldData.Category,
        zz__Created_On: r.fieldData.zz__Created_On,
        zz__Modified_On: r.fieldData.zz__Modified_On,
      },
    }),
  });
  const [selected, setSelected] = useState(null);
  const [filterVendor, setFilterVendor] = useState('');
  const [filterType, setFilterType]     = useState('');
  const [filterCategory, setFilterCat]  = useState('');
  const [showFilters, setShowFilters]   = useState(false);
  const [dataEditing, setDataEditing] = useState(false);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [showBomPicker, setShowBomPicker] = useState(false);
  const [navWidth, setNavWidth] = useState(300);
  const [showNewItem, setShowNewItem] = useState(false);
  const [syncStatus, setSyncStatus] = useState({});
  const [showLightbox, setShowLightbox] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imgBust, setImgBust] = useState(null);
  const imgInputRef = useRef(null);
  const isResizing = useRef(false);

  const startResize = useCallback((e) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const startX = e.clientX;
    const startW = navWidth;
    const onMove = (e) => {
      if (!isResizing.current) return;
      setNavWidth(Math.min(600, Math.max(180, startW + (e.clientX - startX))));
    };
    const onUp = () => {
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [navWidth]);

  const parseFmDate = v => {
    if (!v) return 0;
    const [date, time = '00:00:00'] = v.split(' ');
    const [m, d, y] = date.split('/');
    return new Date(`${y}-${m}-${d}T${time}`).getTime();
  };

  const activeFilterCount = [filterVendor, filterType, filterCategory].filter(Boolean).length;

  const list = useListControls({
    records,
    storageKey: 'ps_sort',
    name: f => f.Name || '',
    searchKeys: ['Name', 'SKU', 'Vendor', 'Category'],
    extraFilter: f => (!filterVendor || f.Vendor === filterVendor) && (!filterType || f.Type === filterType) && (!filterCategory || f.Category === filterCategory),
    sorts: [
      { id: 'alpha', label: 'Name', alpha: true, value: f => (f.Name || '').trim().toLowerCase() || '￿' },
      { id: 'created', label: 'Created', value: f => parseFmDate(f.zz__Created_On) },
      { id: 'modified', label: 'Modified', value: f => parseFmDate(f.zz__Modified_On) },
    ],
    defaultSort: 'created', defaultOrder: 'asc',
  });

  async function handleSelect(r) {
    setEdits({}); setDataEditing(false); setSaveStatus(null); setImgBust(null);
    setSelected(r);
    getRecord(LAYOUT, r.recordId).then(detail => {
      setSelected(prev => prev?.recordId === r.recordId ? detail.response.data[0] : prev);
    }).catch(() => {});
  }

  // Deep-link from the command palette: select a record by id
  useEffect(() => {
    if (navTarget?.moduleId !== 'products' || !navTarget.recordId) return;
    const rec = records.find(r => String(r.recordId) === String(navTarget.recordId));
    if (rec) { handleSelect(rec); onClearNav?.(); }
  }, [navTarget, records]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFieldChange = useCallback((fk, v) => setEdits(p => ({ ...p, [fk]: v })), []);
  const handleDiscard = () => { setEdits({}); setDataEditing(false); setSaveStatus(null); };

  const handleSave = async () => {
    if (!selected) return;
    if (!Object.keys(edits).length) { setDataEditing(false); setSaveStatus('saved'); setTimeout(() => setSaveStatus(null), 3000); return; }
    setSaving(true); setSaveStatus(null);
    try {
      const res = await updateRecord(LAYOUT, selected.recordId, edits);
      if (res.messages?.[0]?.code === '0') {
        const merged = { ...selected.fieldData, ...edits };
        setSelected(p => ({ ...p, fieldData: merged }));
        setEdits({}); setDataEditing(false); setSaveStatus('saved');
        setTimeout(() => setSaveStatus(null), 3000);
        const syncFields = Object.keys(edits).filter(k => AUTO_SYNC_FIELDS.has(k));
        if (syncFields.length) {
          if (merged._kat__Item_ID_Shopify) handleSyncPush('shopify');
          if (merged._kat__Item_ID_QuickBooks) handleSyncPush('qbo');
        }
      } else { setSaveStatus('error'); }
    } catch { setSaveStatus('error'); }
    finally { setSaving(false); }
  };

  const handleSyncPush = async (target) => {
    if (!selected) return;
    const f = { ...selected.fieldData, ...edits };
    setSyncStatus(s => ({ ...s, [target]: 'pushing' }));
    try {
      if (target === 'shopify') {
        const existing = f._kat__Item_ID_Shopify || null;
        const { shopifyId, variantId } = await pushToShopify(f, selected.recordId, existing);
        const fmpUpdates = {};
        if (!existing) fmpUpdates._kat__Item_ID_Shopify = shopifyId;
        if (variantId && variantId !== f._kat__Item_Variant_Id) fmpUpdates._kat__Item_Variant_Id = variantId;
        if (Object.keys(fmpUpdates).length) {
          await updateRecord(LAYOUT, selected.recordId, fmpUpdates);
          setSelected(p => ({ ...p, fieldData: { ...p.fieldData, ...fmpUpdates } }));
        }
      } else if (target === 'qbo') {
        const existing = f._kat__Item_ID_QuickBooks || null;
        const incomeAccount = f.QuickBooks_Account_Income || '155';
        const { qboId } = await pushToQBO(f, existing, incomeAccount);
        if (!existing && qboId) {
          await updateRecord(LAYOUT, selected.recordId, { _kat__Item_ID_QuickBooks: qboId });
          setSelected(p => ({ ...p, fieldData: { ...p.fieldData, _kat__Item_ID_QuickBooks: qboId } }));
        }
      }
      setSyncStatus(s => ({ ...s, [target]: 'ok' }));
      setTimeout(() => setSyncStatus(s => ({ ...s, [target]: null })), 3000);
    } catch (e) {
      console.error(`${target} sync error:`, e);
      setSyncStatus(s => ({ ...s, [target]: 'error' }));
      setTimeout(() => setSyncStatus(s => ({ ...s, [target]: null })), 5000);
    }
  };

  const handleCreate = async ({ fields, pushShopify, shopifyStatus, pushQBO, qboIncome }) => {
    const res = await createRecord(LAYOUT, fields);
    if (res.messages?.[0]?.code !== '0') throw new Error(res.messages?.[0]?.message || 'FMP create failed');
    const newRecordId = res.response?.recordId;
    const updates = {};
    if (pushShopify) {
      const { shopifyId, variantId } = await pushToShopify({ ...fields, status: shopifyStatus }, newRecordId);
      updates._kat__Item_ID_Shopify = shopifyId;
      updates._kat__Item_Variant_Id = variantId;
    }
    if (pushQBO) {
      const { qboId } = await pushToQBO(fields, null, qboIncome);
      if (qboId) updates._kat__Item_ID_QuickBooks = qboId;
    }
    if (Object.keys(updates).length) await updateRecord(LAYOUT, newRecordId, updates);
    const detail = await getRecord(LAYOUT, newRecordId);
    const newRecord = detail.response?.data?.[0];
    if (newRecord) setSelected(newRecord);
  };

  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !selected) return;
    e.target.value = '';
    setUploadingImage(true);
    try {
      const env = getCurrentEnv();
      const res = await fetch(
        `/api/upload-image?recordId=${selected.recordId}&layout=${encodeURIComponent(LAYOUT)}&db=${encodeURIComponent(env.db)}`,
        { method: 'POST', headers: { 'Content-Type': file.type, 'X-Filename': file.name }, body: file }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setImgBust(Date.now());
      const fresh = await getRecord(LAYOUT, selected.recordId);
      const updated = fresh.response?.data?.[0];
      if (updated) setSelected(updated);
    } catch (err) {
      alert(`Image upload failed: ${err.message}`);
    } finally { setUploadingImage(false); }
  };

  const handleAddBomItem = useCallback(async ({ item, quantity }) => {
    const result = await addPortalRow(LAYOUT, selected.recordId, 'Portal__Bill_of_Materials 4', {
      'item_itmli_ITEM__billOfMaterials::Name': item.fieldData.Name,
      'item_ITMLI__billOfMaterials::Quantity': quantity,
    });
    if (result.messages?.[0]?.code === '0') {
      const fresh = await getRecord(LAYOUT, selected.recordId);
      setSelected(fresh.response.data[0]);
      setShowBomPicker(false);
    }
  }, [selected]);

  const f = selected?.fieldData || {};
  const portalData = selected?.portalData;
  const catColor = CATEGORY_COLORS[f.Category] || '#64748b';
  const dirtyCount = Object.keys(edits).length;
  const imgSrcBase = f.Picture ? containerImageUrl(f.Picture, { db: getCurrentEnv().db, layout: LAYOUT, recordId: selected?.recordId }) : null;
  const imgSrc = imgSrcBase ? (imgBust ? `${imgSrcBase}&t=${imgBust}` : imgSrcBase) : null;

  // Live (edit-aware) field accessors + an inline-editable field helper
  const fval = fk => (fk in edits ? edits[fk] : f[fk]);
  const fld = (fk, label) => (
    <div className={`v2-f${fk in edits && edits[fk] !== f[fk] ? ' dirty' : ''}`} key={fk}>
      <span className="v2-f-label">{label || FIELD_LABELS[fk] || fk}</span>
      <FieldValue fieldKey={fk} value={fval(fk)} onChange={handleFieldChange} dataEditing={dataEditing} />
    </div>
  );

  // Pricing roll-up (reflects pending edits)
  const cost = Number(fval('Cost')) || 0;
  const price = Number(fval('Unit_Price')) || 0;
  const profit = price - cost;
  const marginPct = price > 0 && cost > 0 ? (profit / price) * 100 : null;
  const marginColor = marginPct == null ? '#64748b' : marginPct < 0 ? '#ef4444' : marginPct < 15 ? '#f59e0b' : '#22c55e';
  const bom = portalData?.['Portal__Bill_of_Materials 4'] || [];
  const bomTotal = bom.reduce((a, r) => a + Number(r['item_ITMLI__billOfMaterials::Total'] || 0), 0);
  const channels = [
    { key: 'shopify', label: 'Shopify', id: f._kat__Item_ID_Shopify },
    { key: 'qbo', label: 'QuickBooks', id: f._kat__Item_ID_QuickBooks },
  ];

  return (
    <div className="v2-container">
      <aside className="v2-sidebar" style={{ width: navWidth, minWidth: navWidth }}>
        <div className="v2-sidebar-header">
          <div className="v2-sidebar-title">
            <div>
              <div className="v2-sidebar-module">Products &amp; Services</div>
              <div className="v2-sidebar-count">
                {loading ? 'Loading…' : error ? '⚠ Error' : `${total.toLocaleString()} items`}
              </div>
            </div>
          </div>
          <button className="v2-btn ghost sm" onClick={() => setShowNewItem(true)} style={{ marginBottom: 8 }}>+ New</button>
          <ListToolbar c={list} unit="items" />
          <button className="v2-filter-toggle" onClick={() => setShowFilters(s => !s)} style={{ marginTop: 8 }}>
            <span>Filters</span>
            {activeFilterCount > 0 && <span className="v2-filter-badge">{activeFilterCount}</span>}
            <span className="v2-filter-chevron">{showFilters ? '▴' : '▾'}</span>
          </button>
          {showFilters && (
            <div className="v2-filter-panel">
              <div className="v2-filter-row">
                <label className="v2-filter-label">Vendor</label>
                <select className="v2-filter-select" value={filterVendor} onChange={e => setFilterVendor(e.target.value)}>
                  <option value="">All</option>
                  {VENDORS.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div className="v2-filter-row">
                <label className="v2-filter-label">Type</label>
                <select className="v2-filter-select" value={filterType} onChange={e => setFilterType(e.target.value)}>
                  <option value="">All</option>
                  {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="v2-filter-row">
                <label className="v2-filter-label">Category</label>
                <select className="v2-filter-select" value={filterCategory} onChange={e => setFilterCat(e.target.value)}>
                  <option value="">All</option>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              {activeFilterCount > 0 && (
                <button className="v2-filter-clear" onClick={() => { setFilterVendor(''); setFilterType(''); setFilterCat(''); }}>
                  Clear filters
                </button>
              )}
            </div>
          )}
        </div>

        {error ? (
          <div style={{ padding: '16px', color: '#f87171', fontSize: 14 }}><strong>Failed to connect</strong><br />{error}</div>
        ) : loading ? (
          <div className="v2-loading">{[...Array(8)].map((_, i) => <div key={i} className="v2-skeleton" />)}</div>
        ) : (
          <div className="v2-list">
            <ListBody c={list} renderItem={r => {
              const color = CATEGORY_COLORS[r.fieldData.Category] || '#64748b';
              return (
                <div key={r.recordId}
                  className={`v2-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                  onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId); }}
                >
                  <div className="v2-item-dot" style={{ background: color }} />
                  <div className="v2-item-text">
                    <div className="v2-item-name">{r.fieldData.Name || '(no name)'}</div>
                    <div className="v2-item-sub">{r.fieldData.SKU}</div>
                  </div>
                </div>
              );
            }} />
          </div>
        )}
      </aside>

      <div className="v2-resize-handle" onMouseDown={startResize} />

      <main className="v2-main">
        {!selected && (
          <div className="v2-empty-state">
            <div className="v2-empty-icon">◈</div>
            <p>Select a product or service</p>
          </div>
        )}

        {selected && (
          <>
            <div className="v2-topbar2">
              <div className="v2-crumb">
                <span className="dim">Products</span><span className="sep">›</span><span className="cur">{f.Name || '—'}</span>
              </div>
              <div className="v2-topbar-actions">
                {saveStatus === 'saved' && <span className="v2-status saved">✓ Saved</span>}
                {saveStatus === 'error' && <span className="v2-status error">✗ Failed</span>}
                {!dataEditing ? (
                  <button className="v2-btn ghost" onClick={() => setDataEditing(true)}>✎ Edit</button>
                ) : (
                  <>
                    <button className="v2-btn save" onClick={handleSave} disabled={saving || (!dirtyCount && !imgBust)}>
                      {saving ? '…' : dirtyCount ? `Save ${dirtyCount} change${dirtyCount > 1 ? 's' : ''}` : 'Save'}
                    </button>
                    <button className="v2-btn ghost" onClick={handleDiscard}>Discard</button>
                  </>
                )}
              </div>
            </div>

            <div className="v2-content">
              {/* ── Hero: media + pricing ── */}
              <div className="v2-spec-hero">
                <div className="v2-hero-media">
                  {imgSrc ? (
                    <img className="v2-hero-img2" src={imgSrc} alt={f.Name} onClick={() => !dataEditing && setShowLightbox(true)} style={{ cursor: dataEditing ? 'default' : 'zoom-in' }} />
                  ) : (
                    <div className="v2-hero-ph"><span style={{ color: catColor }}>◫</span></div>
                  )}
                  {dataEditing && (
                    <button className="v2-img-replace-btn" onClick={() => imgInputRef.current?.click()} disabled={uploadingImage}>
                      {uploadingImage ? '…' : imgSrc ? '⟳ Replace' : '+ Add image'}
                    </button>
                  )}
                  <input ref={imgInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageUpload} />
                </div>
                <div className="v2-hero-info">
                  <h1 className="v2-title">{f.Name || '—'}</h1>
                  <div className="v2-meta-row">
                    {f.Category && <span className="v2-cat-chip" style={{ background: catColor+'22', color: catColor, borderColor: catColor+'44' }}>{f.Category}</span>}
                    {f.Type && <span className="v2-type-chip">{f.Type}</span>}
                    {f.SKU && <span className="v2-sku"><span className="dim">SKU</span> {f.SKU}</span>}
                    {f.Vendor && <span className="v2-sku"><span className="dim">Vendor</span> {f.Vendor}</span>}
                  </div>
                  <div className="v2-kpis">
                    <div className="v2-kpi"><div className="v2-kpi-label">Price</div><div className="v2-kpi-num">${price.toFixed(2)}</div></div>
                    <div className="v2-kpi"><div className="v2-kpi-label">Cost</div><div className="v2-kpi-num">{cost ? `$${cost.toFixed(2)}` : '—'}</div></div>
                    <div className="v2-kpi"><div className="v2-kpi-label">Margin</div><div className="v2-kpi-num" style={{ color: marginColor }}>{marginPct == null ? '—' : `${marginPct.toFixed(1)}%`}</div></div>
                    <div className="v2-kpi"><div className="v2-kpi-label">Profit / unit</div><div className="v2-kpi-num" style={{ color: marginPct != null && profit < 0 ? '#ef4444' : undefined }}>{cost ? `$${profit.toFixed(2)}` : '—'}</div></div>
                  </div>
                </div>
              </div>

              {/* ── Channels ── */}
              <div className="v2-channels">
                {channels.map(({ key, label, id }) => {
                  const st = syncStatus[key];
                  return (
                    <button key={key} className={`v2-channel${st === 'error' ? ' err' : id || st === 'ok' ? ' linked' : ''}`}
                      onClick={() => handleSyncPush(key)} disabled={st === 'pushing'}>
                      <span className="v2-channel-name">{label}</span>
                      <span className="v2-channel-id">{id ? `#${String(id).slice(-8)}` : 'Not linked'}</span>
                      <span className="v2-channel-badge">
                        {st === 'pushing' ? 'Syncing…' : st === 'error' ? '✗ Failed' : st === 'ok' ? '✓ Synced' : id ? '↻ Re-sync' : 'Sync now →'}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* ── Two-column body ── */}
              <div className="v2-spec-cols">
                <div className="v2-spec-main">
                  <div className="v2-spec-card">
                    <div className="v2-spec-head">Description</div>
                    <FieldValue fieldKey="Description" value={fval('Description')} onChange={handleFieldChange} dataEditing={dataEditing} />
                  </div>
                  {(fval('Notes') || dataEditing) && (
                    <div className="v2-spec-card">
                      <div className="v2-spec-head">Notes</div>
                      <FieldValue fieldKey="Notes" value={fval('Notes')} onChange={handleFieldChange} dataEditing={dataEditing} />
                    </div>
                  )}
                  {(fval('shopify_description') || dataEditing) && (
                    <div className="v2-spec-card">
                      <div className="v2-spec-head">Shopify description</div>
                      <FieldValue fieldKey="shopify_description" value={fval('shopify_description')} onChange={handleFieldChange} dataEditing={dataEditing} />
                    </div>
                  )}
                  <div className="v2-spec-card">
                    <div className="v2-spec-head v2-spec-head-row">
                      <span>Bill of materials{bom.length > 0 && ` · ${bom.length}`}</span>
                      {bomTotal > 0 && <span className="v2-bom-total">Components ${bomTotal.toFixed(2)}</span>}
                      <button className="v2-bom-add-btn" onClick={() => setShowBomPicker(true)}>+ Add</button>
                    </div>
                    {bom.length === 0 ? (
                      <p className="v2-spec-empty">{f.assembly_product ? 'No components yet — add parts to roll up cost.' : 'Not an assembly.'}</p>
                    ) : (
                      <div className="v2-table-wrap">
                        <table className="v2-table">
                          <thead><tr><th>Name</th><th className="num">Qty</th><th className="num">Cost</th><th className="num">Total</th></tr></thead>
                          <tbody>
                            {bom.map((row, i) => (
                              <tr key={i}>
                                <td>{row['item_itmli_ITEM__billOfMaterials::Name']}</td>
                                <td className="num">{row['item_ITMLI__billOfMaterials::Quantity']}</td>
                                <td className="num">${Number(row['item_itmli_ITEM__billOfMaterials::Cost']||0).toFixed(2)}</td>
                                <td className="num">${Number(row['item_ITMLI__billOfMaterials::Total']||0).toFixed(2)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>

                <div className="v2-spec-rail">
                  <div className="v2-spec-card">
                    <div className="v2-spec-head">Pricing</div>
                    <div className="v2-f-list">
                      {fld('Cost', 'Cost')}
                      {fld('Unit_Price', 'Unit price')}
                      {fld('price_override', 'Price override')}
                    </div>
                  </div>
                  <div className="v2-spec-card">
                    <div className="v2-spec-head">Organization</div>
                    <div className="v2-f-list">
                      {fld('SKU')}
                      {fld('vendor_sku')}
                      {fld('Vendor')}
                      {fld('Category')}
                      {fld('Type')}
                      {fld('assembly_product', 'Assembly product')}
                    </div>
                  </div>
                  <div className="v2-spec-card">
                    <div className="v2-spec-head">Accounting & sync</div>
                    <div className="v2-f-list">
                      {fld('QuickBooks_Account_Income', 'Income account')}
                      {fld('qbo_class', 'QBO class')}
                      {fld('_kat__Item_ID_QuickBooks', 'QuickBooks ID')}
                      {fld('_kat__Item_ID_Shopify', 'Shopify ID')}
                      {fld('_kat__Item_Variant_Id', 'Variant ID')}
                    </div>
                  </div>
                </div>
              </div>

              <div className="v2-record-footer">ID {f._kpt__Item_ID} · Record {selected.recordId}</div>
            </div>
          </>
        )}
      </main>

      {showBomPicker && <BomPickerModal allRecords={records} onAdd={handleAddBomItem} onClose={() => setShowBomPicker(false)} />}
      {showNewItem && <NewItemModal onClose={() => setShowNewItem(false)} onCreate={handleCreate} />}
      {showLightbox && imgSrc && <ImageLightbox src={imgSrc} name={f.Name} onClose={() => setShowLightbox(false)} />}
    </div>
  );
}
