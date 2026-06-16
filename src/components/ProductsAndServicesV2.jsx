import { useEffect, useState, useCallback, useRef } from 'react';
import {
  DndContext, closestCenter, PointerSensor,
  useSensor, useSensors, DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable,
  verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getRecord, updateRecord, addPortalRow, containerImageUrl } from '../api/filemaker';
import { getCurrentEnv, getCurrentEnvId } from '../config/fmpEnvironments';
import ColorLegend from './ColorLegend';
import BomPickerModal from './BomPickerModal';
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

const DEFAULT_SECTIONS = [
  { id: 'details', title: 'Details', icon: '◈', fields: ['SKU','vendor_sku','Vendor','Type','Category','Cost','Unit_Price','assembly_product','price_override'] },
  { id: 'description', title: 'Description', icon: '≡', fields: ['Description'] },
  { id: 'notes', title: 'Notes', icon: '✎', fields: ['Notes'] },
  { id: 'shopify_desc', title: 'Shopify Description', icon: '◉', fields: ['shopify_description'] },
  { id: 'integrations', title: 'Integrations', icon: '⇄', fields: ['_kat__Item_ID_QuickBooks','_kat__Item_ID_Shopify','_kat__Item_Variant_Id','QuickBooks_Account_Income','qbo_class'] },
  { id: 'bom', title: 'Bill of Materials', icon: '⊞', fields: ['__portal__'] },
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

function loadLayout() {
  try { const s = localStorage.getItem('ps_layout_v2'); return s ? JSON.parse(s) : DEFAULT_SECTIONS; }
  catch { return DEFAULT_SECTIONS; }
}
function saveLayout(s) { localStorage.setItem('ps_layout_v2', JSON.stringify(s)); }

// ── Sortable Section ─────────────────────────────────────────────
function SortableSection({ section, fieldData, portalData, editMode, onFieldReorder, edits, onChange, dataEditing, onOpenBomPicker }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: section.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1 };
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div ref={setNodeRef} style={style} className="v2-section">
      <div className="v2-section-header" style={{ cursor: 'pointer' }} onClick={() => setCollapsed(c => !c)}>
        {editMode && <span className="v2-drag-handle" {...attributes} {...listeners} onClick={e => e.stopPropagation()}>⠿</span>}
        <span className="v2-section-icon">{section.icon}</span>
        <h3 style={{ flex: 1 }}>{section.title}</h3>
        <span style={{ fontSize: 10, color: '#475569', transition: 'transform 0.2s', display: 'inline-block', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
      </div>
      {!collapsed && <SectionContent section={section} fieldData={fieldData} portalData={portalData}
        editMode={editMode} onFieldReorder={onFieldReorder}
        edits={edits} onChange={onChange} dataEditing={dataEditing}
        onOpenBomPicker={onOpenBomPicker} />}
    </div>
  );
}

function SectionContent({ section, fieldData, portalData, editMode, onFieldReorder, edits, onChange, dataEditing, onOpenBomPicker }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  if (section.id === 'bom') {
    const bom = portalData?.['Portal__Bill_of_Materials 4'] || [];
    return (
      <div>
        <div className="v2-table-wrap">
          {bom.length === 0
            ? <p className="v2-empty-section">No components yet</p>
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

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (active.id !== over?.id) {
      const oi = section.fields.indexOf(active.id);
      const ni = section.fields.indexOf(over.id);
      onFieldReorder(section.id, arrayMove(section.fields, oi, ni));
    }
  };

  const isSingle = section.fields.length === 1 && ['Description','Notes','shopify_description'].includes(section.fields[0]);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={section.fields} strategy={verticalListSortingStrategy}>
        <div className={isSingle ? 'v2-field-single' : 'v2-field-grid'}>
          {section.fields.map(fk => (
            <SortableField key={fk} fieldKey={fk} fieldData={fieldData}
              editMode={editMode} edits={edits} onChange={onChange} dataEditing={dataEditing} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableField({ fieldKey, fieldData, editMode, edits, onChange, dataEditing }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: fieldKey });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1 };
  const saved = fieldData?.[fieldKey];
  const value = fieldKey in edits ? edits[fieldKey] : saved;
  const dirty = fieldKey in edits && edits[fieldKey] !== saved;

  return (
    <div ref={setNodeRef} style={style} className={`v2-field ${editMode ? 'layout-edit' : ''} ${dirty ? 'dirty' : ''}`}>
      {editMode && <span className="v2-field-handle" {...attributes} {...listeners}>⠿</span>}
      <label>{FIELD_LABELS[fieldKey] || fieldKey}</label>
      <FieldValue fieldKey={fieldKey} value={value} onChange={onChange} dataEditing={dataEditing} />
      {dirty && <span className="v2-dirty-dot" title="Unsaved change" />}
    </div>
  );
}

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
            } else if (line.trim()) {
              prose.push(line.trim());
            }
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

        // Check for "Label : Value\nURL" supplier/manufacturer pattern
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
    return <div className="v2-toggle-wrap"><input type="checkbox" className="v2-toggle" checked={!!value} onChange={e => !ro && ch(e.target.checked ? 1 : '')} readOnly={ro} /></div>;

  if (fieldKey === 'Cost' || fieldKey === 'Unit_Price') {
    if (ro) return <span className="v2-value mono">{value != null ? `$${Number(value).toFixed(2)}` : '—'}</span>;
    return <input type="number" step="0.01" value={value ?? ''} onChange={e => ch(e.target.value)} className="v2-input mono" />;
  }

  if (fieldKey === 'Description' || fieldKey === 'Notes' || fieldKey === 'shopify_description') {
    if (ro) return value ? <FormattedText text={value} /> : <p className="v2-text-block">—</p>;
    return <textarea value={value || ''} onChange={e => ch(e.target.value)} className="v2-textarea" rows={5} />;
  }

  const selectOpts = (opts, hasNone) => (
    <select value={value || ''} onChange={e => !ro && ch(e.target.value)} disabled={ro} className="v2-select">
      {hasNone && <option value="">(none)</option>}
      {opts}
    </select>
  );

  if (fieldKey === 'Vendor') return selectOpts(VENDORS.map(x => <option key={x} value={x}>{x}</option>), true);
  if (fieldKey === 'Type') return selectOpts(TYPES.map(x => <option key={x} value={x}>{x}</option>), false);
  if (fieldKey === 'Category') return selectOpts(CATEGORIES.map(x => <option key={x} value={x}>{x}</option>), true);
  if (fieldKey === 'QuickBooks_Account_Income') return selectOpts(QBO_INCOME.map(x => <option key={x.value} value={x.value}>{x.label}</option>), true);
  if (fieldKey === 'qbo_class') return selectOpts(QBO_CAT.map(x => <option key={x.value} value={x.value}>{x.label}</option>), true);

  if (ro) return <span className="v2-value">{value || '—'}</span>;
  return <input type="text" value={value || ''} onChange={e => ch(e.target.value)} className="v2-input" />;
}

// ── Main ────────────────────────────────────────────────────────────
export default function ProductsAndServicesV2() {
  const { records, total, loading, error } = useAllRecords(LAYOUT, {
    slimForStorage: r => ({
      recordId: r.recordId,
      fieldData: {
        Name: r.fieldData.Name,
        SKU: r.fieldData.SKU,
        Category: r.fieldData.Category,
        Vendor: r.fieldData.Vendor,
      },
    }),
  });
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [sections, setSections] = useState(loadLayout);
  const [activeId, setActiveId] = useState(null);
  const [dataEditing, setDataEditing] = useState(false);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [showBomPicker, setShowBomPicker] = useState(false);
  const [navWidth, setNavWidth] = useState(300);
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
      const next = Math.min(600, Math.max(180, startW + (e.clientX - startX)));
      setNavWidth(next);
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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));


  const filtered = records.filter(r => {
    const q = search.toLowerCase();
    const f = r.fieldData;
    return !q || f.Name?.toLowerCase().includes(q) || f.SKU?.toLowerCase().includes(q) ||
      f.Category?.toLowerCase().includes(q) || f.Vendor?.toLowerCase().includes(q);
  });

  async function handleSelect(r) {
    setEdits({}); setDataEditing(false); setSaveStatus(null);
    setSelected(r); // show immediately — all field data is already in the list record
    // Fetch full record in background to get portal data (BOM), no spinner
    getRecord(LAYOUT, r.recordId).then(detail => {
      setSelected(prev => prev?.recordId === r.recordId ? detail.response.data[0] : prev);
    }).catch(() => {});
  }

  const handleFieldChange = useCallback((fk, v) => setEdits(p => ({ ...p, [fk]: v })), []);

  const handleDiscard = () => { setEdits({}); setDataEditing(false); setSaveStatus(null); };

  const handleSave = async () => {
    if (!selected || !Object.keys(edits).length) return;
    setSaving(true); setSaveStatus(null);
    try {
      const res = await updateRecord(LAYOUT, selected.recordId, edits);
      if (res.messages?.[0]?.code === '0') {
        setSelected(p => ({ ...p, fieldData: { ...p.fieldData, ...edits } }));
        setEdits({}); setDataEditing(false); setSaveStatus('saved');
        setTimeout(() => setSaveStatus(null), 3000);
      } else { setSaveStatus('error'); }
    } catch { setSaveStatus('error'); }
    finally { setSaving(false); }
  };

  const handleAddBomItem = useCallback(async ({ item, quantity }) => {
    const result = await addPortalRow(LAYOUT, selected.recordId, 'Portal__Bill_of_Materials 4', {
      'item_itmli_ITEM__billOfMaterials::Name': item.fieldData.Name,
      'item_ITMLI__billOfMaterials::Quantity': quantity,
    });
    if (result.messages?.[0]?.code === '0') {
      // Re-fetch the record to get updated BOM
      const fresh = await getRecord(LAYOUT, selected.recordId);
      setSelected(fresh.response.data[0]);
      setShowBomPicker(false);
    }
  }, [selected]);

  const handleSectionDragEnd = useCallback(({ active, over }) => {
    setActiveId(null);
    if (active.id !== over?.id) {
      setSections(prev => {
        const next = arrayMove(prev, prev.findIndex(s => s.id === active.id), prev.findIndex(s => s.id === over.id));
        saveLayout(next); return next;
      });
    }
  }, []);

  const handleFieldReorder = useCallback((sectionId, newFields) => {
    setSections(prev => { const next = prev.map(s => s.id === sectionId ? { ...s, fields: newFields } : s); saveLayout(next); return next; });
  }, []);

  const f = selected?.fieldData || {};
  const portalData = selected?.portalData;
  const catColor = CATEGORY_COLORS[f.Category] || '#64748b';
  const dirtyCount = Object.keys(edits).length;

  return (
    <div className="v2-container">
      {/* Sidebar */}
      <aside className="v2-sidebar" style={{ width: navWidth, minWidth: navWidth }}>
        <div className="v2-sidebar-header">
          <div className="v2-sidebar-title">
            <span className="v2-sidebar-logo">H5</span>
            <div>
              <div className="v2-sidebar-module">Products &amp; Services</div>
              <div className="v2-sidebar-count">
                {loading ? 'Loading…' : error ? '⚠ Error' : `${total.toLocaleString()} items`}
              </div>
            </div>
          </div>
          <div className="v2-search-wrap" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <span className="v2-search-icon">⌕</span>
              <input
                className="v2-search"
                placeholder="Search…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <ColorLegend items={Object.entries(CATEGORY_COLORS).map(([label, color]) => ({ label, color }))} />
          </div>
        </div>

        {error ? (
          <div style={{ padding: '16px', color: '#f87171', fontSize: 12, lineHeight: 1.5 }}>
            <strong>Failed to connect</strong><br />{error}
          </div>
        ) : loading ? (
          <div className="v2-loading">
            {[...Array(8)].map((_, i) => <div key={i} className="v2-skeleton" />)}
          </div>
        ) : (
          <ul className="v2-list">
            {filtered.map(r => {
              const color = CATEGORY_COLORS[r.fieldData.Category] || '#64748b';
              return (
                <li
                  key={r.recordId}
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

      {/* Resize handle */}
      <div className="v2-resize-handle" onMouseDown={startResize} />

      {/* Main */}
      <main className="v2-main">
        {!selected && (
          <div className="v2-empty-state">
            <div className="v2-empty-icon">◈</div>
            <p>Select a product or service</p>
          </div>
        )}

        {selected && (
          <>
            {/* Top bar */}
            <div className="v2-topbar">
              <div className="v2-topbar-left">
                {f.Picture && <img className="v2-hero-img" src={containerImageUrl(f.Picture, { db: getCurrentEnv().db, layout: LAYOUT, recordId: selected.recordId })} alt={f.Name} />}
                <div>
                  <h1 className="v2-title">{f.Name}</h1>
                  <div className="v2-meta-row">
                    <span className="v2-cat-chip" style={{ background: catColor + '22', color: catColor, borderColor: catColor + '44' }}>{f.Category}</span>
                    <span className="v2-type-chip">{f.Type}</span>
                    {f.SKU && <span className="v2-sku">SKU: {f.SKU}</span>}
                    <span className="v2-price-badge">${Number(f.Unit_Price || 0).toFixed(2)}</span>
                  </div>
                </div>
              </div>
              <div className="v2-topbar-actions">
                {saveStatus === 'saved' && <span className="v2-status saved">✓ Saved</span>}
                {saveStatus === 'error' && <span className="v2-status error">✗ Failed</span>}
                {!dataEditing ? (
                  <>
                    {getCurrentEnvId() === 'development' && (
                      <button className="v2-btn ghost" onClick={() => { setDataEditing(true); setEditMode(false); }}>✎ Edit</button>
                    )}
                    <button className={`v2-btn ghost ${editMode ? 'active' : ''}`} onClick={() => setEditMode(e => !e)}>⠿ Layout</button>
                    {editMode && <button className="v2-btn ghost sm" onClick={() => { setSections(DEFAULT_SECTIONS); saveLayout(DEFAULT_SECTIONS); }}>Reset</button>}
                  </>
                ) : (
                  <>
                    <button className="v2-btn save" onClick={handleSave} disabled={saving || !dirtyCount}>
                      {saving ? '…' : dirtyCount ? `Save ${dirtyCount} change${dirtyCount > 1 ? 's' : ''}` : 'Save'}
                    </button>
                    <button className="v2-btn ghost" onClick={handleDiscard}>Discard</button>
                  </>
                )}
              </div>
            </div>

            {editMode && (
              <div className="v2-layout-hint">⠿ Drag handles to reorder sections and fields</div>
            )}

            {/* Sections */}
            <div className="v2-content">
              <DndContext sensors={sensors} collisionDetection={closestCenter}
                onDragStart={({ active }) => setActiveId(active.id)}
                onDragEnd={handleSectionDragEnd}
                onDragCancel={() => setActiveId(null)}
              >
                <SortableContext items={sections.map(s => s.id)} strategy={verticalListSortingStrategy}>
                  {sections.map(section => (
                    <SortableSection key={section.id} section={section}
                      fieldData={f} portalData={portalData}
                      editMode={editMode} onFieldReorder={handleFieldReorder}
                      edits={edits} onChange={handleFieldChange} dataEditing={dataEditing}
                      onOpenBomPicker={() => setShowBomPicker(true)}
                    />
                  ))}
                </SortableContext>
                <DragOverlay>
                  {activeId && (
                    <div className="v2-section drag-ghost">
                      <div className="v2-section-header">
                        <span className="v2-drag-handle">⠿</span>
                        <h3>{sections.find(s => s.id === activeId)?.title}</h3>
                      </div>
                    </div>
                  )}
                </DragOverlay>
              </DndContext>
            </div>

            <div className="v2-record-footer">ID {f._kpt__Item_ID} · Record {selected.recordId}</div>
          </>
        )}
      </main>

      {showBomPicker && (
        <BomPickerModal
          allRecords={records}
          onAdd={handleAddBomItem}
          onClose={() => setShowBomPicker(false)}
        />
      )}
    </div>
  );
}
