import { useState, useEffect, useCallback, useRef } from 'react';
import { DndContext, closestCenter, DragOverlay } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { getRecord, prefetchRecord, updateRecord } from '../api/filemaker';
import { useAllRecords } from '../hooks/useAllRecords';
import ColorLegend from './ColorLegend';
import { useSortableLayout, SortableSection, SortableFieldGrid, SortableField, SectionDragGhost, LayoutHint } from './SortableLayout';
import './Contacts.css';

const LAYOUT = 'Contacts_New';

const STATUS_COLOR = {
  Active: '#22c55e',
  Inactive: '#64748b',
  Prospect: '#e87722',
  default: '#64748b',
};

const TYPE_OPTIONS    = ['Individual', 'Organization', 'Vendor', 'Staff'];
const STATUS_OPTIONS  = ['Active', 'Inactive', 'Prospect'];

const DEFAULT_SECTIONS = [
  { id: 'identity',        title: 'Identity',         icon: '◈', fields: ['Name_Organization','Type','Status','Industry','Department','Source','Spouse','Birthdate'] },
  { id: 'phone',           title: 'Phone',            icon: '✆', type: 'portal' },
  { id: 'email',           title: 'Email',            icon: '✉', type: 'portal' },
  { id: 'address',         title: 'Address',          icon: '◎', type: 'portal' },
  { id: 'related',         title: 'Related Contacts', icon: '◉', type: 'portal' },
  { id: 'inspections',     title: 'Inspections',      icon: '⚑', type: 'portal' },
  { id: 'custom_training', title: 'Custom Training',  icon: '◑', type: 'portal' },
  { id: 'oe_training',     title: 'OE Training',      icon: '⊙', type: 'portal' },
  { id: 'ccs',             title: 'CCS',              icon: '◈', type: 'portal' },
  { id: 'certifications',  title: 'Certifications',   icon: '✦', type: 'portal' },
  { id: 'estimates',       title: 'Estimates',        icon: '≡', type: 'portal' },
  { id: 'invoices',        title: 'Invoices',         icon: '$', type: 'portal' },
  { id: 'rmi',             title: 'RMI',              icon: '⚠', type: 'portal' },
  { id: 'notes',           title: 'Notes',            icon: '✎', fields: ['Client_Alert','Keywords','Notes'] },
];

const FIELD_LABELS = {
  Name_Organization: 'Name / Organization', Type: 'Type', Status: 'Status',
  Industry: 'Industry', Department: 'Department', Source: 'Source',
  Spouse: 'Spouse', Birthdate: 'Birthdate',
  Client_Alert: 'Client Alert', Keywords: 'Keywords', Notes: 'Notes',
};

function portalHasData(id, p) {
  if (!p) return false;
  const map = {
    phone:           p.cntct_PHONE?.length > 0,
    email:           p.cntct_INADR?.length > 0,
    address:         p.cntct_ADDR?.length > 0,
    related:         p.Portal__Contacts?.length > 0,
    inspections:     p.Portal__Opportunities?.length > 0,
    custom_training: p.Portal__Estimates?.length > 0,
    oe_training:     p['Portal__Orders']?.length > 0,
    ccs:             p['Portal__Orders 2']?.length > 0,
    certifications:  p.Portal__Projects?.length > 0,
    estimates:       p['Portal__Estimates 2']?.length > 0,
    invoices:        p.Portal__Invoices?.length > 0,
    rmi:             p['Portal__Estimates 3']?.length > 0,
  };
  return map[id] ?? false;
}

function FieldValue({ fieldKey, value, onChange, dataEditing }) {
  const ch = v => onChange(fieldKey, v);
  const ro = !dataEditing;

  if (fieldKey === 'Type') {
    if (ro) return <span className="sl-value">{value || '—'}</span>;
    return <select className="sl-select" value={value||''} onChange={e => ch(e.target.value)}>
      <option value="">—</option>
      {TYPE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
    </select>;
  }
  if (fieldKey === 'Status') {
    if (ro) return <span className="sl-value">{value || '—'}</span>;
    return <select className="sl-select" value={value||''} onChange={e => ch(e.target.value)}>
      <option value="">—</option>
      {STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
    </select>;
  }
  if (fieldKey === 'Notes') {
    if (ro) return <div className="sl-textarea-display">{value || '—'}</div>;
    return <textarea className="sl-textarea" value={value||''} onChange={e => ch(e.target.value)} rows={4} />;
  }
  if (ro) return <span className="sl-value">{value || '—'}</span>;
  return <input className="sl-input" value={value||''} onChange={e => ch(e.target.value)} />;
}

function SectionContent({ section, fieldData, portalData, editMode, onFieldReorder, edits, onChange, dataEditing }) {
  const f = fieldData;
  const p = portalData;

  if (section.type === 'portal') {
    if (!portalHasData(section.id, p)) return <p className="sl-empty">No records</p>;

    if (section.id === 'phone') return (
      <div className="ct-table-wrap"><table className="ct-table"><thead><tr><th>Number</th><th>Type</th></tr></thead>
        <tbody>{p.cntct_PHONE.map((r, i) => <tr key={i}><td className="mono">{r['cntct_PHONE::Number']}</td><td>{r['cntct_PHONE::Type']}</td></tr>)}</tbody>
      </table></div>
    );
    if (section.id === 'email') return (
      <div className="ct-table-wrap"><table className="ct-table"><thead><tr><th>Address</th><th>Type</th></tr></thead>
        <tbody>{p.cntct_INADR.map((r, i) => <tr key={i}><td>{r['cntct_INADR::Address']}</td><td>{r['cntct_INADR::Type']}</td></tr>)}</tbody>
      </table></div>
    );
    if (section.id === 'address') return (
      <div className="ct-table-wrap"><table className="ct-table"><thead><tr><th>Street</th><th>City</th><th>State</th><th>Zip</th><th>Type</th></tr></thead>
        <tbody>{p.cntct_ADDR.map((r, i) => <tr key={i}><td>{r['cntct_ADDR::Street']}</td><td>{r['cntct_ADDR::City']}</td><td>{r['cntct_ADDR::State']}</td><td className="mono">{r['cntct_ADDR::Zip']}</td><td>{r['cntct_ADDR::Type']}</td></tr>)}</tbody>
      </table></div>
    );
    if (section.id === 'related') return (
      <div className="ct-table-wrap"><table className="ct-table"><thead><tr><th>Name</th><th>Phone</th><th>Email</th></tr></thead>
        <tbody>{p.Portal__Contacts.map((r, i) => <tr key={i}><td>{r['cntct_RLTN::zz__Display__ct']}</td><td className="mono">{r['cntct_rltn_cntct_PHONE::Number']}</td><td>{r['cntct_rltn_cntct_INADR__email::Address']}</td></tr>)}</tbody>
      </table></div>
    );
    if (section.id === 'inspections') return (
      <div className="ct-table-wrap"><table className="ct-table"><thead><tr><th>Date</th><th>Organization</th><th>Contact</th><th>Inspector</th></tr></thead>
        <tbody>{p.Portal__Opportunities.map((r, i) => <tr key={i}><td>{r['cntct_INSPT::Date']}</td><td>{r['cntct_INSPT::zz__Display_Organization__ct']}</td><td>{r['cntct_INSPT::zz__Display_Contact__ct']}</td><td>{r['cntct_INSPT::Inspectors Name']}</td></tr>)}</tbody>
      </table></div>
    );
    if (section.id === 'custom_training') return (
      <div className="ct-table-wrap"><table className="ct-table"><thead><tr><th>Organization</th><th>Contact</th><th>Type</th><th>Start Date</th><th>Status</th></tr></thead>
        <tbody>{p.Portal__Estimates.map((r, i) => <tr key={i}><td>{r['cntct_TRNPP::zz__Display_Organization__ct']}</td><td>{r['cntct_TRNPP::zz__Display_Contact__ct']}</td><td>{r['cntct_TRNPP::Type of Program']}</td><td>{r['cntct_TRNPP::Start Date']}</td><td>{r['cntct_TRNPP::Status']}</td></tr>)}</tbody>
      </table></div>
    );
    if (section.id === 'oe_training') return (
      <div className="ct-table-wrap"><table className="ct-table"><thead><tr><th>Course #</th><th>Course Name</th><th>Organization</th><th>Start</th><th>End</th></tr></thead>
        <tbody>{p['Portal__Orders'].map((r, i) => <tr key={i}><td className="mono">{r['cntct_WKSRG::Course Number']}</td><td>{r['cntct_WKSRG::Course Name']}</td><td>{r['cntct_WKSRG::zz__Display_Organization__ct']}</td><td>{r['cntct_WKSRG::Start Date']}</td><td>{r['cntct_WKSRG::End Date']}</td></tr>)}</tbody>
      </table></div>
    );
    if (section.id === 'ccs') return (
      <div className="ct-table-wrap"><table className="ct-table"><thead><tr><th>ID</th><th>Status</th><th>Organization</th><th>Type</th><th>Start</th></tr></thead>
        <tbody>{p['Portal__Orders 2'].map((r, i) => <tr key={i}><td className="mono">{r['cntct_RCD::_kpt__RCD_ID']}</td><td>{r['cntct_RCD::Status']}</td><td>{r['cntct_RCD::zz__Display_Organization__ct']}</td><td>{r['cntct_RCD::zz__TypeOfProjectList__ct']}</td><td>{r['cntct_RCD::rcd start date']}</td></tr>)}</tbody>
      </table></div>
    );
    if (section.id === 'certifications') return (
      <div className="ct-table-wrap"><table className="ct-table"><thead><tr><th>Certificate Dates</th></tr></thead>
        <tbody>{p.Portal__Projects.map((r, i) => <tr key={i}><td>{r['cntct_CTFC::CertificateDates']}</td></tr>)}</tbody>
      </table></div>
    );
    if (section.id === 'rmi') return (
      <div className="ct-table-wrap"><table className="ct-table"><thead><tr><th>Entry Date</th><th>Risk Level</th><th>Concern</th><th>Assigned To</th><th>Status</th></tr></thead>
        <tbody>{p['Portal__Estimates 3'].map((r, i) => <tr key={i}><td>{r['cntct_RMI::Entry_Date']}</td><td>{r['cntct_RMI::Level_of_Risk']}</td><td>{r['cntct_RMI::Level_of_Concern']}</td><td>{r['cntct_RMI::Assigned_To']}</td><td>{r['cntct_RMI::Status']}</td></tr>)}</tbody>
      </table></div>
    );
    if (section.id === 'estimates') return (
      <div className="ct-table-wrap"><table className="ct-table"><thead><tr><th>ID</th><th>Date</th><th>Title</th><th className="num">Total</th><th>Status</th></tr></thead>
        <tbody>{p['Portal__Estimates 2'].map((r, i) => <tr key={i}><td className="mono">{r['cntct_ESTMT::_kpt__Estimate_ID']}</td><td>{r['cntct_ESTMT::Date']}</td><td>{r['cntct_ESTMT::Title']}</td><td className="num">${Number(r['cntct_ESTMT::zz__Total__xn']||0).toLocaleString('en-US',{minimumFractionDigits:2})}</td><td>{r['cntct_ESTMT::Status']}</td></tr>)}</tbody>
      </table></div>
    );
    if (section.id === 'invoices') return (
      <div className="ct-table-wrap"><table className="ct-table"><thead><tr><th>QB Ref</th><th>Date</th><th className="num">Total</th><th className="num">Balance</th><th>Memo</th></tr></thead>
        <tbody>{p.Portal__Invoices.map((r, i) => <tr key={i}><td className="mono">{r['cntct_INVO::QuickBooks_Reference_Number']}</td><td>{r['cntct_INVO::Date']}</td><td className="num">${Number(r['cntct_INVO::zz__Total__xn']||0).toLocaleString('en-US',{minimumFractionDigits:2})}</td><td className="num" style={{color:Number(r['cntct_INVO::zz__Balance_Due__xs'])>0?'#e8322a':'inherit'}}>${Number(r['cntct_INVO::zz__Balance_Due__xs']||0).toLocaleString('en-US',{minimumFractionDigits:2})}</td><td>{r['cntct_INVO::Memo']}</td></tr>)}</tbody>
      </table></div>
    );
    return null;
  }

  return (
    <SortableFieldGrid sectionId={section.id} fields={section.fields} editMode={editMode} onReorder={onFieldReorder}>
      {section.fields.map(fk => {
        const saved = f?.[fk];
        const value = fk in edits ? edits[fk] : saved;
        const dirty = fk in edits && edits[fk] !== saved;
        return (
          <SortableField key={fk} id={fk} editMode={editMode} dirty={dirty} wide={fk === 'Notes'}>
            <label>{FIELD_LABELS[fk] || fk}</label>
            <FieldValue fieldKey={fk} value={value} onChange={onChange} dataEditing={dataEditing} />
          </SortableField>
        );
      })}
      {section.id === 'identity' && f?.['_kaf__qbo_id'] && (
        <div className="sl-field">
          <label>QuickBooks ID</label>
          <span className="sl-value mono">{f['_kaf__qbo_id']}</span>
        </div>
      )}
    </SortableFieldGrid>
  );
}

export default function Contacts({ navTarget, onClearNav } = {}) {
  const { records, total } = useAllRecords(LAYOUT, { cacheVersion: 2 });
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');
  const [sortField, setSortFieldRaw] = useState(() => localStorage.getItem('ct_sort_field') || 'created');
  const [sortOrder, setSortOrderRaw] = useState(() => localStorage.getItem('ct_sort_order') || 'desc');
  const [navWidth, setNavWidth] = useState(280);
  const [tooltip, setTooltip] = useState(null);
  const [dataEditing, setDataEditing] = useState(false);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const isResizing = useRef(false);

  const { sections, editMode, setEditMode, activeId, setActiveId, sensors, handleSectionDragEnd, handleFieldReorder, resetLayout } =
    useSortableLayout('ct_layout_v1', DEFAULT_SECTIONS);


  const setSortField = v => { setSortFieldRaw(v); localStorage.setItem('ct_sort_field', v); };
  const setSortOrder = v => { setSortOrderRaw(v); localStorage.setItem('ct_sort_order', v); };

  const parseFmDate = v => {
    if (!v) return 0;
    const [date, time = '00:00:00'] = v.split(' ');
    const [m, d, y] = date.split('/');
    return new Date(`${y}-${m}-${d}T${time}`).getTime();
  };

  const filtered = records.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    const f = r.fieldData;
    return (
      f.zz__Display__ct?.toLowerCase().includes(q) ||
      f['cntct_ADDR::zz__Display_Single_Line__ct']?.toLowerCase().includes(q) ||
      f.Type?.toLowerCase().includes(q) ||
      f.Status?.toLowerCase().includes(q)
    );
  });

  const sortedFiltered = [...filtered].sort((a, b) => {
    let va, vb;
    if (sortField === 'alpha') {
      va = (a.fieldData.zz__Display__ct || '').toLowerCase();
      vb = (b.fieldData.zz__Display__ct || '').toLowerCase();
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
    setEdits({}); setDataEditing(false); setSaveStatus(null); setEditMode(false);
    setSelected(r);
    getRecord(LAYOUT, r.recordId).then(detail => {
      setSelected(prev => prev?.recordId === r.recordId ? detail.response.data[0] : prev);
    }).catch(() => {});
  }

  // Deep-link from the command palette: select a record by id
  useEffect(() => {
    if (navTarget?.moduleId !== 'contacts' || !navTarget.recordId) return;
    const rec = records.find(r => String(r.recordId) === String(navTarget.recordId));
    if (rec) { handleSelect(rec); onClearNav?.(); }
  }, [navTarget, records]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFieldChange = useCallback((fk, v) => setEdits(p => ({ ...p, [fk]: v })), []);
  const handleDiscard = () => { setEdits({}); setDataEditing(false); setSaveStatus(null); };

  async function handleSave() {
    const dirtyCount = Object.keys(edits).length;
    if (!dirtyCount) { setDataEditing(false); return; }
    setSaving(true); setSaveStatus(null);
    try {
      await updateRecord(LAYOUT, selected.recordId, edits);
      const detail = await getRecord(LAYOUT, selected.recordId);
      setSelected(detail.response.data[0]);
      setEdits({}); setDataEditing(false); setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch { setSaveStatus('error'); }
    finally { setSaving(false); }
  }

  const startResize = useCallback((e) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const startX = e.clientX;
    const startW = navWidth;
    const onMove = (e) => {
      if (!isResizing.current) return;
      setNavWidth(Math.min(500, Math.max(180, startW + (e.clientX - startX))));
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

  const f = selected?.fieldData;
  const p = selected?.portalData;
  const dirtyCount = Object.keys(edits).length;

  return (
    <div className="ct-container">
      <aside className="ct-sidebar" style={{ width: navWidth }}>
        <div className="ct-sidebar-header">
          <div className="ct-sidebar-title">
            <div>
              <div className="ct-sidebar-module">Contacts</div>
              <div className="ct-sidebar-count">{total ? `${total.toLocaleString()} contacts` : 'Loading…'}</div>
            </div>
          </div>
          <div className="ct-search-wrap" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <span className="ct-search-icon">⌕</span>
              <input className="ct-search" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <ColorLegend items={Object.entries(STATUS_COLOR).filter(([k]) => k !== 'default').map(([label, color]) => ({ label, color }))} />
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
        </div>

        {records.length === 0 ? (
          <div className="ct-loading">{[...Array(8)].map((_, i) => <div key={i} className="ct-skeleton" />)}</div>
        ) : (
          <ul className="ct-list">
            {sortedFiltered.map(r => {
              const status = r.fieldData.Status;
              const color = STATUS_COLOR[status] || STATUS_COLOR.default;
              return (
                <li key={r.recordId}
                  className={`ct-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                  onClick={() => handleSelect(r)}
                  onMouseEnter={e => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTooltip({ r, x: rect.right + 8, y: rect.top });
                    prefetchRecord(LAYOUT, r.recordId);
                  }}
                  onMouseLeave={() => setTooltip(null)}
                >
                  <span className="ct-item-dot" style={{ background: color }} />
                  <div className="ct-item-text">
                    <div className="ct-item-name">{r.fieldData.zz__Display__ct || '—'}</div>
                    <div className="ct-item-sub">{r.fieldData['cntct_ADDR::zz__Display_Single_Line_No_Zip__ct'] || r.fieldData.Type || ''}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <div className="ct-resize-handle" onMouseDown={startResize} />

      {tooltip && (
        <div className="ct-hover-tooltip" style={{ top: tooltip.y, left: tooltip.x }}>
          {tooltip.r.fieldData['Name_Organization'] && (
            <div className="ct-ht-row"><span className="ct-ht-label">Org</span><span className="ct-ht-value">{tooltip.r.fieldData['Name_Organization']}</span></div>
          )}
          {tooltip.r.fieldData['cntct_ADDR::Type'] && (
            <div className="ct-ht-row"><span className="ct-ht-label">Addr Type</span><span className="ct-ht-value">{tooltip.r.fieldData['cntct_ADDR::Type']}</span></div>
          )}
        </div>
      )}

      <main className="ct-main">
        {!selected && (
          <div className="ct-empty-state">
            <div className="ct-empty-icon">◈</div>
            <p>Select a contact</p>
          </div>
        )}

        {selected && f && (
          <>
            <div className="ct-topbar">
              <div className="ct-topbar-left">
                <div>
                  <h1 className="ct-title">{f.zz__Display__ct || '—'}</h1>
                  <div className="ct-meta-row">
                    {f.Type && <span className="ct-chip type">{f.Type}</span>}
                    {f.Status && (
                      <span className="ct-chip status" style={{ background: (STATUS_COLOR[f.Status]||'#64748b')+'22', color: STATUS_COLOR[f.Status]||'#64748b', borderColor: (STATUS_COLOR[f.Status]||'#64748b')+'44' }}>{f.Status}</span>
                    )}
                    {f.Industry && <span className="ct-chip muted">{f.Industry}</span>}
                  </div>
                </div>
              </div>
              <div className="ct-topbar-actions">
                {saveStatus === 'saved' && <span className="ct-status saved">✓ Saved</span>}
                {saveStatus === 'error' && <span className="ct-status error">✗ Failed</span>}
                {!dataEditing ? (
                  <>
                    <button className="ct-btn-edit" onClick={() => { setDataEditing(true); setEditMode(false); }}>✎ Edit</button>
                    <button className={`ct-btn-edit${editMode ? ' active' : ''}`} onClick={() => setEditMode(m => !m)}>⠿ Layout</button>
                    {editMode && <button className="ct-btn-edit sm" onClick={resetLayout}>Reset</button>}
                  </>
                ) : (
                  <>
                    <button className="ct-btn-discard" onClick={handleDiscard} disabled={saving}>Discard</button>
                    <button className="ct-btn-save" onClick={handleSave} disabled={saving || dirtyCount === 0}>
                      {saving ? 'Saving…' : dirtyCount ? `Save ${dirtyCount} change${dirtyCount > 1 ? 's' : ''}` : 'Save'}
                    </button>
                  </>
                )}
              </div>
            </div>

            <LayoutHint editMode={editMode} />

            <div className="ct-content">
              <DndContext sensors={sensors} collisionDetection={closestCenter}
                onDragStart={({ active }) => setActiveId(active.id)}
                onDragEnd={handleSectionDragEnd}
                onDragCancel={() => setActiveId(null)}
              >
                <SortableContext items={sections.map(s => s.id)} strategy={verticalListSortingStrategy}>
                  {sections.map(section => {
                    const isPortal = section.type === 'portal';
                    if (!editMode && isPortal && !portalHasData(section.id, p)) return null;
                    return (
                      <SortableSection key={section.id} id={section.id} title={section.title} icon={section.icon} editMode={editMode}>
                        <SectionContent section={section} fieldData={f} portalData={p}
                          editMode={editMode} onFieldReorder={handleFieldReorder}
                          edits={edits} onChange={handleFieldChange} dataEditing={dataEditing} />
                      </SortableSection>
                    );
                  })}
                </SortableContext>
                <DragOverlay>
                  {activeId && <SectionDragGhost title={sections.find(s => s.id === activeId)?.title} icon={sections.find(s => s.id === activeId)?.icon} />}
                </DragOverlay>
              </DndContext>

              <div className="ct-record-footer">
                ID {f._kpt__Contact_ID} · Created {f.zz__Created_On?.split(' ')[0]} by {f.zz__Created_By} · Modified {f.zz__Modified_On?.split(' ')[0]} by {f.zz__Modified_By}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
