import { useEffect, useState, useCallback, useRef } from 'react';
import { DndContext, closestCenter, DragOverlay } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { getRecord, updateRecord, addPortalRow, containerImageUrl, createRecord } from '../api/filemaker';
import { getCurrentEnv } from '../config/fmpEnvironments';
import ColorLegend from './ColorLegend';
import BomPickerModal from './BomPickerModal';
import NewItemModal from './NewItemModal';
import ImageLightbox from './ImageLightbox';
import { pushToShopify, pushToQBO } from '../api/integrations';
import { useAllRecords } from '../hooks/useAllRecords';
import { useSortableLayout, SortableSection, SortableFieldGrid, SortableField, SectionDragGhost, LayoutHint } from './SortableLayout';
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

const DEFAULT_SECTIONS = [
  { id: 'details',      title: 'Details',            icon: '◈', fields: ['SKU','vendor_sku','Vendor','Type','Category','Cost','Unit_Price','assembly_product','price_override'] },
  { id: 'description',  title: 'Description',        icon: '≡', fields: ['Description'] },
  { id: 'notes',        title: 'Notes',              icon: '✎', fields: ['Notes'] },
  { id: 'shopify_desc', title: 'Shopify Description',icon: '◉', fields: ['shopify_description'] },
  { id: 'integrations', title: 'Integrations',       icon: '⇄', fields: ['_kat__Item_ID_QuickBooks','_kat__Item_ID_Shopify','_kat__Item_Variant_Id','QuickBooks_Account_Income','qbo_class'] },
  { id: 'bom',          title: 'Bill of Materials',  icon: '⊞', fields: ['__portal__'] },
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

function SectionContent({ section, fieldData, portalData, editMode, onFieldReorder, edits, onChange, dataEditing, onOpenBomPicker }) {
  if (section.id === 'bom') {
    const bom = portalData?.['Portal__Bill_of_Materials 4'] || [];
    return (
      <div>
        <div className="v2-table-wrap">
          {bom.length === 0
            ? <p className="sl-empty">No components yet</p>
            : <table className="v2-table">
                <thead><tr><th>Name</th><th>Description</th><th>Qty</th><th>Cost</th><th>Price</th><th>Total</th></tr></thead>
                <tbody>
                  {bom.map((row, i) => (
                    <tr key={i}>
                      <td>{row['item_itmli_ITEM__billOfMaterials::Name']}</td>
                      <td>{row['item_itmli_ITEM__billOfMaterials::Description']}</td>
                      <td className="num">{row['item_ITMLI__billOfMaterials::Quantity']}</td>
                      <td className="num">${Number(row['item_itmli_ITEM__billOfMaterials::Cost']||0).toFixed(2)}</td>
                      <td className="num">${Number(row['item_itmli_ITEM__billOfMaterials::Unit_Price']||0).toFixed(2)}</td>
                      <td className="num">${Number(row['item_ITMLI__billOfMaterials::Total']||0).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
          }
        </div>
        <div className="v2-bom-footer">
          <button className="v2-bom-add-btn" onClick={onOpenBomPicker}>+ Add Component</button>
        </div>
      </div>
    );
  }

  const isSingle = section.fields.length === 1 && ['Description','Notes','shopify_description'].includes(section.fields[0]);

  return (
    <SortableFieldGrid sectionId={section.id} fields={section.fields} editMode={editMode}
      onReorder={onFieldReorder} single={isSingle}>
      {section.fields.map(fk => {
        const saved = fieldData?.[fk];
        const value = fk in edits ? edits[fk] : saved;
        const dirty = fk in edits && edits[fk] !== saved;
        return (
          <SortableField key={fk} id={fk} editMode={editMode} dirty={dirty}
            wide={['Description','Notes','shopify_description'].includes(fk)}>
            <label>{FIELD_LABELS[fk] || fk}</label>
            <FieldValue fieldKey={fk} value={value} onChange={onChange} dataEditing={dataEditing} />
          </SortableField>
        );
      })}
    </SortableFieldGrid>
  );
}

const AUTO_SYNC_FIELDS = new Set(['Name', 'Unit_Price', 'Description', 'SKU', 'QuickBooks_Account_Income']);

export default function ProductsAndServicesV2({ navTarget, onClearNav } = {}) {
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
  const [search, setSearch] = useState('');
  const [sortField, setSortFieldRaw] = useState(() => localStorage.getItem('ps_sort_field') || 'created');
  const [sortOrder, setSortOrderRaw] = useState(() => localStorage.getItem('ps_sort_order') || 'asc');
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

  const { sections, editMode, setEditMode, activeId, setActiveId, sensors, handleSectionDragEnd, handleFieldReorder, resetLayout } =
    useSortableLayout('ps_layout_v2', DEFAULT_SECTIONS);

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

  const setSortField = v => { setSortFieldRaw(v); localStorage.setItem('ps_sort_field', v); };
  const setSortOrder = v => { setSortOrderRaw(v); localStorage.setItem('ps_sort_order', v); };

  const parseFmDate = v => {
    if (!v) return 0;
    const [date, time = '00:00:00'] = v.split(' ');
    const [m, d, y] = date.split('/');
    return new Date(`${y}-${m}-${d}T${time}`).getTime();
  };

  const filtered = records.filter(r => {
    const q = search.toLowerCase();
    const f = r.fieldData;
    if (q && !f.Name?.toLowerCase().includes(q) && !f.SKU?.toLowerCase().includes(q)) return false;
    if (filterVendor && f.Vendor !== filterVendor) return false;
    if (filterType && f.Type !== filterType) return false;
    if (filterCategory && f.Category !== filterCategory) return false;
    return true;
  });

  const activeFilterCount = [filterVendor, filterType, filterCategory].filter(Boolean).length;

  const sortedFiltered = [...filtered].sort((a, b) => {
    let va, vb;
    if (sortField === 'alpha') {
      va = (a.fieldData.Name || '').toLowerCase();
      vb = (b.fieldData.Name || '').toLowerCase();
    } else if (sortField === 'created') {
      va = parseFmDate(a.fieldData.zz__Created_On);
      vb = parseFmDate(b.fieldData.zz__Created_On);
    } else {
      va = parseFmDate(a.fieldData.zz__Modified_On);
      vb = parseFmDate(b.fieldData.zz__Modified_On);
    }
    if (va < vb) return sortOrder === 'asc' ? -1 : 1;
    if (va > vb) return sortOrder === 'asc' ? 1 : -1;
    return 0;
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
          <div className="v2-search-wrap" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <span className="v2-search-icon">⌕</span>
              <input className="v2-search" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <ColorLegend items={Object.entries(CATEGORY_COLORS).map(([label, color]) => ({ label, color }))} />
          </div>
          <div className="sort-bar">
            <select className="sort-field" value={sortField} onChange={e => setSortField(e.target.value)}>
              <option value="alpha">A–Z</option>
              <option value="created">Created</option>
              <option value="modified">Modified</option>
            </select>
            <button className="sort-order-btn" onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}>
              {sortOrder === 'asc' ? '↑' : '↓'}
            </button>
          </div>
          <button className="v2-filter-toggle" onClick={() => setShowFilters(s => !s)}>
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
          <div style={{ padding: '16px', color: '#f87171', fontSize: 12 }}><strong>Failed to connect</strong><br />{error}</div>
        ) : loading ? (
          <div className="v2-loading">{[...Array(8)].map((_, i) => <div key={i} className="v2-skeleton" />)}</div>
        ) : (
          <ul className="v2-list">
            {sortedFiltered.map(r => {
              const color = CATEGORY_COLORS[r.fieldData.Category] || '#64748b';
              return (
                <li key={r.recordId}
                  className={`v2-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                  onClick={() => handleSelect(r)}
                >
                  <div className="v2-item-dot" style={{ background: color }} />
                  <div className="v2-item-text">
                    <div className="v2-item-name">{r.fieldData.Name || '(no name)'}</div>
                    <div className="v2-item-sub">{r.fieldData.SKU}</div>
                  </div>
                </li>
              );
            })}
          </ul>
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
            <div className="v2-topbar">
              <div className="v2-topbar-left">
                <div className="v2-hero-wrap">
                  {imgSrc && <img className="v2-hero-img" src={imgSrc} alt={f.Name} onClick={() => !dataEditing && setShowLightbox(true)} style={{ cursor: dataEditing ? 'default' : 'zoom-in' }} />}
                  {dataEditing && (
                    <button className="v2-img-replace-btn" onClick={() => imgInputRef.current?.click()} disabled={uploadingImage}>
                      {uploadingImage ? '…' : imgSrc ? '⟳ Replace' : '+ Add Image'}
                    </button>
                  )}
                  <input ref={imgInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageUpload} />
                </div>
                <div>
                  <h1 className="v2-title">{f.Name}</h1>
                  <div className="v2-meta-row">
                    <span className="v2-cat-chip" style={{ background: catColor+'22', color: catColor, borderColor: catColor+'44' }}>{f.Category}</span>
                    <span className="v2-type-chip">{f.Type}</span>
                    {f.SKU && <span className="v2-sku">SKU: {f.SKU}</span>}
                    <span className="v2-price-badge">${Number(f.Unit_Price || 0).toFixed(2)}</span>
                  </div>
                </div>
              </div>
              <div className="v2-topbar-actions">
                <button className={`v2-btn ghost sm ${syncStatus.shopify === 'ok' ? 'active' : ''}`}
                  onClick={() => handleSyncPush('shopify')} disabled={syncStatus.shopify === 'pushing'}
                  title={f._kat__Item_ID_Shopify ? `Shopify ID: ${f._kat__Item_ID_Shopify}` : 'Push to Shopify'}
                  style={{ color: syncStatus.shopify === 'error' ? '#f87171' : syncStatus.shopify === 'ok' ? '#4ade80' : undefined }}>
                  {syncStatus.shopify === 'pushing' ? '…' : syncStatus.shopify === 'ok' ? '✓ Shopify' : syncStatus.shopify === 'error' ? '✗ Shopify' : '⇪ Shopify'}
                </button>
                <button className={`v2-btn ghost sm ${syncStatus.qbo === 'ok' ? 'active' : ''}`}
                  onClick={() => handleSyncPush('qbo')} disabled={syncStatus.qbo === 'pushing'}
                  title={f._kat__Item_ID_QuickBooks ? `QBO ID: ${f._kat__Item_ID_QuickBooks}` : 'Push to QuickBooks'}
                  style={{ color: syncStatus.qbo === 'error' ? '#f87171' : syncStatus.qbo === 'ok' ? '#4ade80' : undefined }}>
                  {syncStatus.qbo === 'pushing' ? '…' : syncStatus.qbo === 'ok' ? '✓ QBO' : syncStatus.qbo === 'error' ? '✗ QBO' : '⇪ QBO'}
                </button>
                {saveStatus === 'saved' && <span className="v2-status saved">✓ Saved</span>}
                {saveStatus === 'error' && <span className="v2-status error">✗ Failed</span>}
                {!dataEditing ? (
                  <>
                    <button className="v2-btn ghost" onClick={() => { setDataEditing(true); setEditMode(false); }}>✎ Edit</button>
                    <button className={`v2-btn ghost ${editMode ? 'active' : ''}`} onClick={() => setEditMode(m => !m)}>⠿ Layout</button>
                    {editMode && <button className="v2-btn ghost sm" onClick={resetLayout}>Reset</button>}
                  </>
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

            <LayoutHint editMode={editMode} />

            <div className="v2-content">
              <DndContext sensors={sensors} collisionDetection={closestCenter}
                onDragStart={({ active }) => setActiveId(active.id)}
                onDragEnd={handleSectionDragEnd}
                onDragCancel={() => setActiveId(null)}
              >
                <SortableContext items={sections.map(s => s.id)} strategy={verticalListSortingStrategy}>
                  {sections.map(section => (
                    <SortableSection key={section.id} id={section.id} title={section.title} icon={section.icon} editMode={editMode}>
                      <SectionContent section={section} fieldData={f} portalData={portalData}
                        editMode={editMode} onFieldReorder={handleFieldReorder}
                        edits={edits} onChange={handleFieldChange} dataEditing={dataEditing}
                        onOpenBomPicker={() => setShowBomPicker(true)} />
                    </SortableSection>
                  ))}
                </SortableContext>
                <DragOverlay>
                  {activeId && <SectionDragGhost title={sections.find(s => s.id === activeId)?.title} icon={sections.find(s => s.id === activeId)?.icon} />}
                </DragOverlay>
              </DndContext>
            </div>

            <div className="v2-record-footer">ID {f._kpt__Item_ID} · Record {selected.recordId}</div>
          </>
        )}
      </main>

      {showBomPicker && <BomPickerModal allRecords={records} onAdd={handleAddBomItem} onClose={() => setShowBomPicker(false)} />}
      {showNewItem && <NewItemModal onClose={() => setShowNewItem(false)} onCreate={handleCreate} />}
      {showLightbox && imgSrc && <ImageLightbox src={imgSrc} name={f.Name} onClose={() => setShowLightbox(false)} />}
    </div>
  );
}
