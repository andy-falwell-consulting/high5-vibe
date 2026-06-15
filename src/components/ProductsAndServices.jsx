import { useEffect, useState, useCallback, useRef } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getRecord, updateRecord, proxyImageUrl } from '../api/filemaker';
import { useAllRecords } from '../hooks/useAllRecords';
import './ProductsAndServices.css';

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

// Default section/field layout
const DEFAULT_SECTIONS = [
  {
    id: 'details',
    title: 'Details',
    fields: ['SKU','vendor_sku','Vendor','Type','Category','Cost','Unit_Price','assembly_product','price_override'],
  },
  {
    id: 'description',
    title: 'Description',
    fields: ['Description'],
  },
  {
    id: 'notes',
    title: 'Notes',
    fields: ['Notes'],
  },
  {
    id: 'shopify_desc',
    title: 'Shopify Description',
    fields: ['shopify_description'],
  },
  {
    id: 'integrations',
    title: 'Integrations',
    fields: ['_kat__Item_ID_QuickBooks','_kat__Item_ID_Shopify','_kat__Item_Variant_Id','QuickBooks_Account_Income','qbo_class'],
  },
  {
    id: 'bom',
    title: 'Bill of Materials',
    fields: ['__portal__'],
  },
];

const FIELD_LABELS = {
  SKU: 'SKU',
  vendor_sku: 'Vendor SKU',
  Vendor: 'Vendor',
  Type: 'Type',
  Category: 'Category',
  Cost: 'Cost',
  Unit_Price: 'Unit Price',
  assembly_product: 'Assembly Product',
  price_override: 'Price Override',
  Description: 'Description',
  Notes: 'Notes',
  shopify_description: 'Shopify Description',
  _kat__Item_ID_QuickBooks: 'QuickBooks ID',
  _kat__Item_ID_Shopify: 'Shopify ID',
  _kat__Item_Variant_Id: 'Shopify Variant ID',
  QuickBooks_Account_Income: 'QBO Income Account',
  qbo_class: 'QBO Class',
  __portal__: 'Bill of Materials Table',
};

function loadLayout() {
  try {
    const saved = localStorage.getItem('ps_layout');
    return saved ? JSON.parse(saved) : DEFAULT_SECTIONS;
  } catch { return DEFAULT_SECTIONS; }
}

function saveLayout(sections) {
  localStorage.setItem('ps_layout', JSON.stringify(sections));
}

// ── Sortable Section ──────────────────────────────────────────────
function SortableSection({ section, fieldData, portalData, editMode, onFieldReorder, edits, onChange, dataEditing }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: section.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="ps-section">
      <div className="ps-section-header">
        {editMode && (
          <span className="ps-drag-handle section-handle" {...attributes} {...listeners} title="Drag to reorder section">
            ⠿
          </span>
        )}
        <h3>{section.title}</h3>
      </div>
      <SectionContent
        section={section}
        fieldData={fieldData}
        portalData={portalData}
        editMode={editMode}
        onFieldReorder={onFieldReorder}
        edits={edits}
        onChange={onChange}
        dataEditing={dataEditing}
      />
    </div>
  );
}

// ── Section Content (field-level DnD) ────────────────────────────
function SectionContent({ section, fieldData, portalData, editMode, onFieldReorder, edits, onChange, dataEditing }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  if (section.id === 'bom') {
    const bom = portalData?.['Portal__Bill_of_Materials 4'] || [];
    if (!bom.length) return <div className="ps-empty-section">No bill of materials</div>;
    return (
      <table className="ps-table">
        <thead>
          <tr>
            <th>Name</th><th>Description</th><th>Qty</th>
            <th>Cost</th><th>Unit Price</th><th>Total</th>
          </tr>
        </thead>
        <tbody>
          {bom.map((row, i) => (
            <tr key={i}>
              <td>{row['item_itmli_ITEM__billOfMaterials::Name']}</td>
              <td>{row['item_itmli_ITEM__billOfMaterials::Description']}</td>
              <td>{row['item_ITMLI__billOfMaterials::Quantity']}</td>
              <td>${Number(row['item_itmli_ITEM__billOfMaterials::Cost'] || 0).toFixed(2)}</td>
              <td>${Number(row['item_itmli_ITEM__billOfMaterials::Unit_Price'] || 0).toFixed(2)}</td>
              <td>${Number(row['item_ITMLI__billOfMaterials::Total'] || 0).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (active.id !== over?.id) {
      const oldIdx = section.fields.indexOf(active.id);
      const newIdx = section.fields.indexOf(over.id);
      onFieldReorder(section.id, arrayMove(section.fields, oldIdx, newIdx));
    }
  };

  const isSingleLarge = section.fields.length === 1 &&
    ['Description','Notes','shopify_description'].includes(section.fields[0]);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={section.fields} strategy={verticalListSortingStrategy}>
        <div className={isSingleLarge ? 'ps-field-list-single' : 'ps-grid'}>
          {section.fields.map((fieldKey) => (
            <SortableField
              key={fieldKey}
              fieldKey={fieldKey}
              fieldData={fieldData}
              editMode={editMode}
              edits={edits}
              onChange={onChange}
              dataEditing={dataEditing}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

// ── Sortable Field ────────────────────────────────────────────────
function SortableField({ fieldKey, fieldData, editMode, edits, onChange, dataEditing }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: fieldKey });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className={`ps-field ${editMode ? 'edit-mode' : ''}`}>
      {editMode && (
        <span className="ps-drag-handle field-handle" {...attributes} {...listeners} title="Drag to reorder field">
          ⠿
        </span>
      )}
      <label>{FIELD_LABELS[fieldKey] || fieldKey}</label>
      <FieldValue fieldKey={fieldKey} fieldData={fieldData} edits={edits} onChange={onChange} dataEditing={dataEditing} />
    </div>
  );
}

// ── Field Value Renderer ──────────────────────────────────────────
function FieldValue({ fieldKey, fieldData, edits, onChange, dataEditing }) {
  const saved = fieldData?.[fieldKey];
  const v = fieldKey in edits ? edits[fieldKey] : saved;
  const dirty = fieldKey in edits && edits[fieldKey] !== saved;

  const wrap = (el) => (
    <div className={`ps-field-value-wrap ${dirty ? 'dirty' : ''}`}>{el}</div>
  );

  if (!dataEditing) {
    // Read-only display
    if (fieldKey === 'Vendor')
      return wrap(<select value={v || ''} disabled><option value="">(none)</option>{VENDORS.map(x => <option key={x} value={x}>{x}</option>)}</select>);
    if (fieldKey === 'Type')
      return wrap(<select value={v || ''} disabled>{TYPES.map(x => <option key={x} value={x}>{x}</option>)}</select>);
    if (fieldKey === 'Category')
      return wrap(<select value={v || ''} disabled><option value="">(none)</option>{CATEGORIES.map(x => <option key={x} value={x}>{x}</option>)}</select>);
    if (fieldKey === 'QuickBooks_Account_Income')
      return wrap(<select value={v || ''} disabled><option value="">(none)</option>{QBO_INCOME.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}</select>);
    if (fieldKey === 'qbo_class')
      return wrap(<select value={v || ''} disabled><option value="">(none)</option>{QBO_CAT.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}</select>);
    if (fieldKey === 'assembly_product' || fieldKey === 'price_override')
      return wrap(<input type="checkbox" checked={!!v} readOnly />);
    if (fieldKey === 'Cost' || fieldKey === 'Unit_Price')
      return wrap(<span>{v != null ? `$${Number(v).toFixed(2)}` : '—'}</span>);
    if (fieldKey === 'Description' || fieldKey === 'Notes' || fieldKey === 'shopify_description')
      return wrap(<div className="ps-textarea">{v || '—'}</div>);
    return wrap(<span>{v || '—'}</span>);
  }

  // Editable
  const change = (val) => onChange(fieldKey, val);

  if (fieldKey === 'Vendor')
    return wrap(<select value={v || ''} onChange={e => change(e.target.value)}><option value="">(none)</option>{VENDORS.map(x => <option key={x} value={x}>{x}</option>)}</select>);
  if (fieldKey === 'Type')
    return wrap(<select value={v || ''} onChange={e => change(e.target.value)}>{TYPES.map(x => <option key={x} value={x}>{x}</option>)}</select>);
  if (fieldKey === 'Category')
    return wrap(<select value={v || ''} onChange={e => change(e.target.value)}><option value="">(none)</option>{CATEGORIES.map(x => <option key={x} value={x}>{x}</option>)}</select>);
  if (fieldKey === 'QuickBooks_Account_Income')
    return wrap(<select value={v || ''} onChange={e => change(e.target.value)}><option value="">(none)</option>{QBO_INCOME.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}</select>);
  if (fieldKey === 'qbo_class')
    return wrap(<select value={v || ''} onChange={e => change(e.target.value)}><option value="">(none)</option>{QBO_CAT.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}</select>);
  if (fieldKey === 'assembly_product' || fieldKey === 'price_override')
    return wrap(<input type="checkbox" checked={!!v} onChange={e => change(e.target.checked ? 1 : '')} />);
  if (fieldKey === 'Cost' || fieldKey === 'Unit_Price')
    return wrap(<input type="number" step="0.01" value={v ?? ''} onChange={e => change(e.target.value)} className="ps-input-number" />);
  if (fieldKey === 'Description' || fieldKey === 'Notes' || fieldKey === 'shopify_description')
    return wrap(<textarea value={v || ''} onChange={e => change(e.target.value)} className="ps-textarea-edit" rows={4} />);

  return wrap(<input type="text" value={v || ''} onChange={e => change(e.target.value)} className="ps-input-text" />);
}

// ── Main Component ────────────────────────────────────────────────
export default function ProductsAndServices() {
  const { records, total, loading } = useAllRecords(LAYOUT);
  const [selected, setSelected] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [sections, setSections] = useState(loadLayout);
  const [activeId, setActiveId] = useState(null);
  const [navWidth, setNavWidth] = useState(280);
  const isResizing = useRef(false);

  const startResize = useCallback((e) => {
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e) => {
      if (!isResizing.current) return;
      const x = e.clientX ?? e.touches?.[0]?.clientX;
      setNavWidth(Math.min(600, Math.max(180, x)));
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
  }, []);

  const [dataEditing, setDataEditing] = useState(false);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null); // 'saved' | 'error'

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));


  const filtered = records.filter((r) => {
    const q = search.toLowerCase();
    const f = r.fieldData;
    return !q || f.Name?.toLowerCase().includes(q) || f.SKU?.toLowerCase().includes(q) ||
      f.Category?.toLowerCase().includes(q) || f.Vendor?.toLowerCase().includes(q);
  });

  async function handleSelect(r) {
    setDetailLoading(true);
    setEdits({});
    setDataEditing(false);
    setSaveStatus(null);
    const detail = await getRecord(LAYOUT, r.recordId);
    setSelected(detail.response.data[0]);
    setDetailLoading(false);
  }

  const handleFieldChange = useCallback((fieldKey, value) => {
    setEdits(prev => ({ ...prev, [fieldKey]: value }));
  }, []);

  const handleDiscard = () => {
    setEdits({});
    setDataEditing(false);
    setSaveStatus(null);
  };

  const handleSave = async () => {
    if (!selected || !Object.keys(edits).length) return;
    setSaving(true);
    setSaveStatus(null);
    try {
      const result = await updateRecord(LAYOUT, selected.recordId, edits);
      if (result.messages?.[0]?.code === '0') {
        // Merge edits into selected record
        setSelected(prev => ({
          ...prev,
          fieldData: { ...prev.fieldData, ...edits },
        }));
        setEdits({});
        setDataEditing(false);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus(null), 3000);
      } else {
        setSaveStatus('error');
      }
    } catch {
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  };

  // Section drag end
  const handleSectionDragEnd = useCallback((event) => {
    const { active, over } = event;
    setActiveId(null);
    if (active.id !== over?.id) {
      setSections((prev) => {
        const oldIdx = prev.findIndex(s => s.id === active.id);
        const newIdx = prev.findIndex(s => s.id === over.id);
        const next = arrayMove(prev, oldIdx, newIdx);
        saveLayout(next);
        return next;
      });
    }
  }, []);

  // Field reorder within a section
  const handleFieldReorder = useCallback((sectionId, newFields) => {
    setSections((prev) => {
      const next = prev.map(s => s.id === sectionId ? { ...s, fields: newFields } : s);
      saveLayout(next);
      return next;
    });
  }, []);

  const resetLayout = () => {
    setSections(DEFAULT_SECTIONS);
    saveLayout(DEFAULT_SECTIONS);
  };

  const f = selected?.fieldData || {};
  const portalData = selected?.portalData;
  const activeSectionTitle = activeId ? sections.find(s => s.id === activeId)?.title : null;

  return (
    <div className="ps-container">
      {/* Left: list */}
      <div className="ps-list-panel" style={{ width: navWidth, minWidth: navWidth }}>
        <div className="ps-list-header">
          <h2>Products &amp; Services</h2>
          <span className="ps-count">{loading ? 'Loading…' : `${total.toLocaleString()} items`}</span>
        </div>
        <input
          className="ps-search"
          placeholder="Search name, SKU, category, vendor…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {loading ? (
          <div className="ps-spinner">Loading…</div>
        ) : (
          <ul className="ps-list">
            {filtered.map((r) => (
              <li
                key={r.recordId}
                className={`ps-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                onClick={() => handleSelect(r)}
              >
                <div className="ps-list-name">{r.fieldData.Name || '(no name)'}</div>
                <div className="ps-list-meta">
                  <span>{r.fieldData.SKU}</span>
                  <span className="ps-badge">{r.fieldData.Type}</span>
                  <span className="ps-badge cat">{r.fieldData.Category}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Resize handle */}
      <div className="ps-resize-handle" onMouseDown={startResize} title="Drag to resize" />

      {/* Right: detail */}
      <div className="ps-detail-panel">
        {detailLoading && <div className="ps-spinner center">Loading…</div>}
        {!selected && !detailLoading && (
          <div className="ps-empty">Select an item to view details</div>
        )}
        {selected && !detailLoading && (
          <div className="ps-detail">
            {/* Header */}
            <div className="ps-detail-header">
              {f.Picture && <img className="ps-picture" src={proxyImageUrl(f.Picture)} alt={f.Name} />}
              <div className="ps-detail-title">
                <h1>{f.Name}</h1>
                <div className="ps-detail-badges">
                  <span className="ps-badge">{f.Type}</span>
                  <span className="ps-badge cat">{f.Category}</span>
                </div>
              </div>
              <div className="ps-edit-controls">
                {/* Data editing controls */}
                {!dataEditing ? (
                  <button className="ps-data-edit-btn" onClick={() => { setDataEditing(true); setEditMode(false); }}>
                    ✎ Edit Record
                  </button>
                ) : (
                  <>
                    <button
                      className="ps-save-btn"
                      onClick={handleSave}
                      disabled={saving || !Object.keys(edits).length}
                    >
                      {saving ? 'Saving…' : `Save${Object.keys(edits).length ? ` (${Object.keys(edits).length})` : ''}`}
                    </button>
                    <button className="ps-discard-btn" onClick={handleDiscard} disabled={saving}>
                      Discard
                    </button>
                  </>
                )}
                {/* Layout editing controls */}
                {!dataEditing && (
                  <>
                    <button
                      className={`ps-edit-btn ${editMode ? 'active' : ''}`}
                      onClick={() => setEditMode(e => !e)}
                    >
                      {editMode ? '✓ Done' : '⠿ Layout'}
                    </button>
                    {editMode && (
                      <button className="ps-reset-btn" onClick={resetLayout}>Reset</button>
                    )}
                  </>
                )}
              </div>
              {saveStatus === 'saved' && <div className="ps-save-status success">✓ Saved to FileMaker</div>}
              {saveStatus === 'error' && <div className="ps-save-status error">✗ Save failed</div>}
            </div>

            {editMode && (
              <div className="ps-edit-hint">
                Drag <strong>⠿</strong> handles to reorder sections or fields within sections
              </div>
            )}

            {/* Sortable sections */}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={({ active }) => setActiveId(active.id)}
              onDragEnd={handleSectionDragEnd}
              onDragCancel={() => setActiveId(null)}
            >
              <SortableContext items={sections.map(s => s.id)} strategy={verticalListSortingStrategy}>
                {sections.map((section) => (
                  <SortableSection
                    key={section.id}
                    section={section}
                    fieldData={f}
                    portalData={portalData}
                    editMode={editMode}
                    onFieldReorder={handleFieldReorder}
                    edits={edits}
                    onChange={handleFieldChange}
                    dataEditing={dataEditing}
                  />
                ))}
              </SortableContext>

              <DragOverlay>
                {activeSectionTitle && (
                  <div className="ps-section drag-overlay">
                    <div className="ps-section-header">
                      <span className="ps-drag-handle section-handle">⠿</span>
                      <h3>{activeSectionTitle}</h3>
                    </div>
                  </div>
                )}
              </DragOverlay>
            </DndContext>

            <div className="ps-record-id">Record ID: {f._kpt__Item_ID} · Internal: {selected.recordId}</div>
          </div>
        )}
      </div>
    </div>
  );
}
