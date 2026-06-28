import { useState, useCallback, useRef, useEffect } from 'react';
import { DndContext, closestCenter, DragOverlay } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useAllRecords } from '../hooks/useAllRecords';
import { RCD_LAYOUT, RCD_CACHE_VERSION, RCD_FIND_QUERY, RCD_SORT } from '../config/ccsCache';
import { getRecord, prefetchRecord, updateRecord, patchCachedRecord, invalidateRecord } from '../api/filemaker';
import { useSortableLayout, SortableSection, SortableFieldGrid, SortableField, SectionDragGhost, LayoutHint } from './SortableLayout';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import './CCS.css';

const LAYOUT = RCD_LAYOUT;

const STATUS_OPTIONS  = ['Proposed','Confirmed','In Progress','Complete','Cancelled','On Hold'];
const KANBAN_STATUSES = [
  'New Project Inquiry','Working Proposals','Proposals Out','Sent Contract and DI',
  'Job Prep by Date','Done/Ready for Building','Commissioning Report Needed',"No Go's (litter box)",
];
const PROJECT_TYPES   = ['Inspection','New Construction','Renovation','Repair','Training','Other'];
const BUILDER_OPTIONS = ['','Lucas Germano','Ian Doak','Mike Hicks','Sam Bates','Dan Smith','Chris Young'];

const STATUS_COLOR = {
  'Proposed':    '#e87722', 'Confirmed':   '#3b82f6', 'In Progress': '#a855f7',
  'Complete':    '#22c55e', 'Cancelled':   '#64748b', 'On Hold':     '#f59e0b',
};
const statusColor = s => STATUS_COLOR[s] || '#64748b';

const fmtDate = val => {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d) ? val : d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
};
const fmtMoney = v => v ? `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—';
const fmt = v => v || '—';

// ── Section definitions ───────────────────────────────────────────

const DEFAULT_PRIMARY_SECTIONS = [
  { id: 'contact',    title: 'Contact',        icon: '◉', type: 'contact' },
  { id: 'financial',  title: 'Financial',      icon: '$', type: 'financial' },
  { id: 'project',    title: 'Project',        icon: '◈', fields: ['kanban_status','Type of Project(1)','Status','rcd start date','rcd end date','Report Date Sent','Confirmed'] },
  { id: 'team',       title: 'Team',           icon: '⊞', fields: ['Lead Builder','Builder1','Builder2','Builder3'] },
  { id: 'work_notes', title: 'Work & Notes',   icon: '✎', fields: ['Work Order','Notes'] },
];

const DEFAULT_CHECKLIST_SECTIONS = [
  { id: 'pre_project', title: 'Pre-Project',        icon: '●', type: 'checklist' },
  { id: 'contract',    title: 'Contract & Deposit',  icon: '●', type: 'checklist' },
  { id: 'install',     title: 'Install Prep',        icon: '●', type: 'checklist' },
  { id: 'event',       title: 'Event Prep',          icon: '●', type: 'checklist' },
];

const FIELD_LABELS = {
  'Type of Project(1)': 'Project Type', Status: 'Status',
  'rcd start date': 'Start Date', 'rcd end date': 'End Date',
  'Report Date Sent': 'Inspection Report Sent', Confirmed: 'Confirmed',
  'Lead Builder': 'Lead Builder', Builder1: 'Builder 1', Builder2: 'Builder 2', Builder3: 'Builder 3',
  'Work Order': 'Work Order', Notes: 'Notes',
  kanban_status: 'Kanban Status',
  add_to_kanban: 'Add to Kanban',
};

const FIELD_CONFIG = {
  'Type of Project(1)':      { options: PROJECT_TYPES },
  Status:                 { options: STATUS_OPTIONS, special: 'status' },
  'rcd start date':       { type: 'date' },
  'rcd end date':         { type: 'date' },
  'Report Date Sent':     { type: 'date' },
  Confirmed:              { type: 'date' },
  'Lead Builder':         { options: BUILDER_OPTIONS },
  Builder1:               { options: BUILDER_OPTIONS },
  Builder2:               { options: BUILDER_OPTIONS },
  Builder3:               { options: BUILDER_OPTIONS },
  'Work Order':           { textarea: true, wide: true },
  Notes:                  { textarea: true, wide: true },
  kanban_status:          { options: KANBAN_STATUSES },
  add_to_kanban:          { type: 'checkbox' },
};

const CHECKLIST_ITEMS = {
  pre_project: [
    ['pp_New_cust_exist_course_survey','Site Survey'],['pp_Created Client Folder','Client Folder Created'],
    ['pp_Create CCS for Site Eval','CCS for Site Eval'],['p_CCS Estimate','CCS Estimate'],
    ['p_Training Plan','Training Plan'],['p_Drawings','Drawings'],
    ['p_Mark as Proposed','Mark as Proposed'],['pp_Sent PD Form','Sent PD Form'],
  ],
  contract: [
    ['cd_Sent Contract','Sent Contract'],['cd_Add to Cal','Add to Calendar'],
    ['cd_Received Contract','Received Contract'],['cd_Received Deposit','Received Deposit'],
    ['cd_Received PO','Received PO'],['Final_Invoice_Received','Final Invoice Received'],
  ],
  install: [
    ['iprep_Prefab List','Prefab List'],['iprep_Construction Layout','Construction Layout'],
    ['iprep_Training','Training'],['iprep_Equipment','Equipment'],['iprep_Need Inspection','Need Inspection'],
  ],
  event: [
    ['eprep_Setting Scheduled','Setting Scheduled'],['eprep_Setting Complete','Setting Complete'],
    ['eprep_Dig Safe','Dig Safe'],['eprep_Equipment Requested','Equipment Requested'],
    ['eprep_Equipment Reserved','Equipment Reserved'],['eprep_Poles Ordered','Poles Ordered'],
    ['eprep_Poles Delivered','Poles Delivered'],['eprep_Climbing Holds Ordered','Holds Ordered'],
    ['eprep_Climbing Holds Delivered','Holds Delivered'],['eprep_Tarps Mats Ordered','Tarps/Mats Ordered'],
    ['eprep_Tarps Mats Delivered','Tarps/Mats Delivered'],['eprep_Specialty Hardware','Specialty Hardware'],
    ['eprep_Lumber_ordered','Lumber Ordered'],['eprep_Lumber_ordered_delivered','Lumber Delivered'],
    ['eprep_Permits','Permits'],
  ],
};

// ── Field value renderer ──────────────────────────────────────────

function FieldValue({ fieldKey, value, onChange, dataEditing, f }) {
  const cfg = FIELD_CONFIG[fieldKey] || {};
  const ch = v => onChange(fieldKey, v);
  const ro = !dataEditing;

  if (fieldKey === 'Status') {
    if (ro) return f?.Status
      ? <span className="sl-status-pill" style={{ color: statusColor(f.Status), borderColor: statusColor(f.Status)+'44', background: statusColor(f.Status)+'18' }}>{f.Status}</span>
      : <span className="sl-value">—</span>;
    return <select className="sl-select" value={value||''} onChange={e => ch(e.target.value)}>
      <option value="">—</option>
      {STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
    </select>;
  }

  if (cfg.type === 'checkbox') {
    const on = Number(value) === 1;
    return (
      <span
        className={`ccs-chk-box${on ? ' on' : ''}${!ro ? ' clickable' : ''}`}
        onClick={() => !ro && onChange(fieldKey, on ? 0 : 1)}
        title={on ? 'On Kanban' : 'Not on Kanban'}
      >
        {on ? '✓' : ''}
      </span>
    );
  }

  if (cfg.type === 'date') {
    if (ro) return <span className="sl-value">{fmtDate(value) || '—'}</span>;
    const iso = value ? (() => { const p = value.split('/'); return p.length === 3 ? `${p[2]}-${p[0].padStart(2,'0')}-${p[1].padStart(2,'0')}` : ''; })() : '';
    return <input type="date" className="sl-input" value={iso}
      onChange={e => { const [y,m,d] = e.target.value.split('-'); ch(e.target.value ? `${m}/${d}/${y}` : ''); }} />;
  }

  if (cfg.options) {
    if (ro) return <span className="sl-value">{value || '—'}</span>;
    return <select className="sl-select" value={value||''} onChange={e => ch(e.target.value)}>
      <option value="">—</option>
      {cfg.options.filter(Boolean).map(o => <option key={o} value={o}>{o}</option>)}
    </select>;
  }

  if (cfg.textarea) {
    if (ro) return <div className="sl-textarea-display">{value || '—'}</div>;
    return <textarea className="sl-textarea" value={value||''} onChange={e => ch(e.target.value)} rows={5} />;
  }

  if (ro) return <span className="sl-value">{value || '—'}</span>;
  return <input className="sl-input" value={value||''} onChange={e => ch(e.target.value)} />;
}

// ── Section content renderer ──────────────────────────────────────

function SectionContent({ section, f, editMode, onFieldReorder, edits, onChange, dataEditing, handleCheckToggle }) {
  if (section.type === 'contact') {
    return (
      <div className="ccs-contact-body">
        {[
          ['Site', f.zz__Display_Organization__ct],
          ['Individual', f.zz__Display_Contact__ct],
          ['Address', f.Address_Block_Billing],
          ['Email', f['rcd_cntct_INADR__email::zz__Address__ct']],
          ['Phone', f['rcd_cntct_PHONE__work::Number']],
          ['Mobile', f['rcd_cntct_PHONE__mobile::Number']],
        ].filter(([, v]) => v).map(([label, val]) => (
          <div key={label} className="ccs-info-row">
            <span className="ccs-info-label">{label}</span>
            {label === 'Email'
              ? <a className="ccs-info-value link" href={`mailto:${val}`}>{val}</a>
              : <span className="ccs-info-value">{val}</span>
            }
          </div>
        ))}
        <div className="sl-field-grid" style={{ marginTop: 8 }}>
          {[['Distance to High5','Distance'],['Drive Time','Drive Time']].map(([fk, label]) => {
            const saved = f?.[fk];
            const value = fk in edits ? edits[fk] : saved;
            const dirty = fk in edits && edits[fk] !== saved;
            return (
              <div key={fk} className={`sl-field${dirty ? ' dirty' : ''}`}>
                {dirty && <span className="sl-dirty-dot" />}
                <label>{label}</label>
                {!dataEditing
                  ? <span className="sl-value">{value || '—'}</span>
                  : <input className="sl-input" value={value||''} onChange={e => onChange(fk, e.target.value)} />
                }
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (section.type === 'financial') {
    const finField = (fk, label, type) => {
      const saved = f?.[fk]; const val = fk in edits ? edits[fk] : saved;
      const dirty = fk in edits && saved !== edits[fk];
      if (type === 'date') {
        const iso = val ? (() => { const p = String(val).split('/'); return p.length === 3 ? `${p[2]}-${p[0].padStart(2,'0')}-${p[1].padStart(2,'0')}` : ''; })() : '';
        return dataEditing
          ? <input key={fk} type="date" className="sl-input sm" value={iso} onChange={e => { const [y,m,d] = e.target.value.split('-'); onChange(fk, e.target.value ? `${m}/${d}/${y}` : ''); }} />
          : <span key={fk} className="sl-value sm">{fmtDate(val) || ''}</span>;
      }
      if (type === 'checkbox') {
        const on = Number(val) === 1;
        return <span key={fk} className={`ccs-chk-box${on ? ' on' : ''}${dataEditing ? ' clickable' : ''}`}
          onClick={() => dataEditing && onChange(fk, on ? 0 : 1)}>{on ? '✓' : ''}</span>;
      }
      return dataEditing
        ? <input key={fk} className="sl-input sm" value={val||''} onChange={e => onChange(fk, e.target.value)} />
        : <span key={fk} className="sl-value sm">{val || ''}</span>;
    };

    return (
      <div className="ccs-fin-table">
        <div className="ccs-fin-row"><span className="ccs-fin-label">Estimate #</span><span className="ccs-fin-val">{finField('_kat__QuickBooks_Estimate_ID')}</span></div>
        <div className="ccs-fin-row"><span className="ccs-fin-label">Contract</span><span className="ccs-fin-val">{finField('Contract_Date_Sent','Sent','date')}</span><span className="ccs-fin-recv">Received</span>{finField('cd_Received Contract','','checkbox')}</div>
        <div className="ccs-fin-row"><span className="ccs-fin-label">Deposit Inv.</span><span className="ccs-fin-val" /><span className="ccs-fin-recv">Received</span>{finField('cd_Received Deposit','','checkbox')}</div>
        <div className="ccs-fin-row"><span className="ccs-fin-label">PO #</span><span className="ccs-fin-val">{finField('po_number')}</span><span className="ccs-fin-recv">Received</span>{finField('cd_Received PO','','checkbox')}</div>
        <div className="ccs-fin-row"><span className="ccs-fin-label">Final Inv.</span><span className="ccs-fin-val">{finField('Final Sent','Sent','date')}</span><span className="ccs-fin-recv">Received</span>{finField('Final_Invoice_Received','','checkbox')}</div>
        <div className="ccs-fin-row"><span className="ccs-fin-label">Invoice #</span><span className="ccs-fin-val">{finField('_kat__QuickBooks_Invoice_ID(1)')}</span></div>
      </div>
    );
  }

  if (section.type === 'checklist') {
    const items = CHECKLIST_ITEMS[section.id] || [];
    return (
      <div className="ccs-checks">
        {items.map(([key, label]) => {
          const val = key in edits ? edits[key] : f[key];
          const on = Number(val) === 1;
          return (
            <div key={key} className={`ccs-check-item${on ? ' on' : ''}`}
              onClick={() => dataEditing && handleCheckToggle(key, on)}
              style={{ cursor: dataEditing ? 'pointer' : 'default' }}>
              <span className={`ccs-chk-box${on ? ' on' : ''}`}>{on ? '✓' : ''}</span>
              <span>{label}</span>
            </div>
          );
        })}
      </div>
    );
  }

  // Data-driven field grid (project, team, work_notes)
  return (
    <SortableFieldGrid sectionId={section.id} fields={section.fields} editMode={editMode} onReorder={onFieldReorder}>
      {section.fields.map(fk => {
        const saved = f?.[fk];
        const value = fk in edits ? edits[fk] : saved;
        const dirty = fk in edits && edits[fk] !== saved;
        const cfg = FIELD_CONFIG[fk] || {};
        return (
          <SortableField key={fk} id={fk} editMode={editMode} dirty={dirty} wide={!!cfg.textarea}>
            <label>{FIELD_LABELS[fk] || fk}</label>
            <FieldValue fieldKey={fk} value={value} onChange={onChange} dataEditing={dataEditing} f={f} />
          </SortableField>
        );
      })}
    </SortableFieldGrid>
  );
}

function PortalTable({ columns, rows }) {
  if (!rows?.length) return <p className="sl-empty">No records</p>;
  return (
    <table className="ccs-portal-table">
      <thead><tr>{columns.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>{columns.map(c => <td key={c.key}>{c.fmt ? c.fmt(row[c.key]) : fmt(row[c.key])}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

export default function CCS({ navTarget, onNavigateTo, onClearNav }) {
  const { records, total } = useAllRecords(LAYOUT, {
    cacheVersion: RCD_CACHE_VERSION,
    findQuery: RCD_FIND_QUERY,
    sort: RCD_SORT,
  });

  const [selected, setSelected]         = useState(null);
  const [navWidth, setNavWidth]         = useState(300);
  const [activeTab, setActiveTab]       = useState('primary');
  const [activePortal, setActivePortal] = useState('estimates');
  const [dataEditing, setDataEditing]   = useState(false);
  const [edits, setEdits]               = useState({});
  const [saving, setSaving]             = useState(false);
  const [saveStatus, setSaveStatus]     = useState(null);
  const isResizing = useRef(false);

  const primary = useSortableLayout('ccs_layout_primary_v4', DEFAULT_PRIMARY_SECTIONS);
  const checklists = useSortableLayout('ccs_layout_checklists_v2', DEFAULT_CHECKLIST_SECTIONS);

  // Use the active tab's layout
  const activeLayout = activeTab === 'primary' ? primary : activeTab === 'checklists' ? checklists : null;

  const startResize = useCallback((e) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const startX = e.clientX;
    const startW = navWidth;
    const onMove = (e) => {
      if (!isResizing.current) return;
      setNavWidth(Math.min(500, Math.max(200, startW + (e.clientX - startX))));
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

  const projStatus = t => { t = (t || '').toLowerCase(); if (t.includes('complet')) return 'done'; if (t.includes('no go') || t.includes('cancel')) return 'nogo'; return t ? 'active' : null; };

  const list = useListControls({
    records,
    storageKey: 'ccs_sort',
    name: f => f.zz__Display_Organization__ct || '',
    searchKeys: ['zz__Display_Organization__ct', 'zz__Display_Contact__ct', 'Status', 'Type of Project(1)', 'Work Order'],
    chips: [
      { id: 'all', label: 'All' },
      { id: 'active', label: 'Active', color: '#3b82f6', match: f => projStatus(f.Status) === 'active' },
      { id: 'done', label: 'Completed', color: '#22c55e', match: f => projStatus(f.Status) === 'done' },
      { id: 'nogo', label: 'No go', color: '#94a3b8', match: f => projStatus(f.Status) === 'nogo' },
    ],
    sorts: [
      { id: 'alpha', label: 'Name', alpha: true, value: f => (f.zz__Display_Organization__ct || '').trim().toLowerCase() || '￿' },
      { id: 'created', label: 'Created', value: f => parseFmDate(f.zz__Created_On) },
      { id: 'modified', label: 'Modified', value: f => parseFmDate(f.zz__Modified_On) },
    ],
    defaultSort: 'created', defaultOrder: 'desc',
  });

  async function handleSelect(r) {
    setEdits({}); setDataEditing(false); setSaveStatus(null);
    primary.setEditMode(false); checklists.setEditMode(false);
    setSelected(r); setActiveTab('primary');
    getRecord(LAYOUT, r.recordId).then(detail => {
      setSelected(prev => prev?.recordId === r.recordId ? detail.response.data[0] : prev);
    }).catch(() => {});
  }

  // When a cache patch arrives (e.g. kanban drag-drop), merge it into the open record
  useEffect(() => {
    if (!selected) return;
    const updated = records.find(r => String(r.recordId) === String(selected.recordId));
    if (!updated) return;
    setSelected(prev => prev ? { ...prev, fieldData: { ...prev.fieldData, ...updated.fieldData } } : prev);
  }, [records]);

  // Handle cross-module navigation: kanban → CCS
  useEffect(() => {
    if (navTarget?.moduleId !== 'ccs' || !navTarget.recordId) return;
    const record = records.find(r => String(r.recordId) === String(navTarget.recordId));
    if (record) { handleSelect(record); onClearNav?.(); }
  }, [navTarget, records]);

  const handleFieldChange = useCallback((fk, v) => setEdits(p => ({ ...p, [fk]: v })), []);
  const handleCheckToggle = useCallback((key, on) => handleFieldChange(key, on ? 0 : 1), [handleFieldChange]);

  const handleDiscard = () => { setEdits({}); setDataEditing(false); setSaveStatus(null); };

  const handleSave = async () => {
    if (!selected || !Object.keys(edits).length) return;
    setSaving(true); setSaveStatus(null);
    try {
      const res = await updateRecord(LAYOUT, selected.recordId, edits);
      if (res.messages?.[0]?.code === '0') {
        setSelected(p => ({ ...p, fieldData: { ...p.fieldData, ...edits } }));
        patchCachedRecord(RCD_LAYOUT, RCD_CACHE_VERSION, selected.recordId, edits);
        invalidateRecord(LAYOUT, selected.recordId);
        setEdits({}); setDataEditing(false); setSaveStatus('saved');
        setTimeout(() => setSaveStatus(null), 3000);
      } else { setSaveStatus('error'); }
    } catch { setSaveStatus('error'); }
    finally { setSaving(false); }
  };

  const dirtyCount = Object.keys(edits).length;
  const f = selected?.fieldData || {};
  const portals = selected?.portalData || {};
  const estimates = portals['Portal__Estimates 2'] || [];
  const invoices  = portals['Portal__Invoices']    || [];
  const payments  = portals['Portal__Payments']    || [];

  const sharedSectionProps = { f, editMode: activeLayout?.editMode || false, edits, onChange: handleFieldChange, dataEditing, handleCheckToggle };

  return (
    <div className="ccs-root">
      <nav className="ccs-nav" style={{ width: navWidth }}>
        <div className="ccs-nav-header">
          <span className="ccs-nav-title">CCS</span>
          <span className="ccs-nav-count">{total ? `${records.length} / ${total}` : records.length}</span>
        </div>
        <div style={{ padding: '0 12px 10px' }}>
          <ListToolbar c={list} unit="projects" />
        </div>
        <div className="ccs-list">
          <ListBody c={list} renderItem={r => {
            const rf = r.fieldData;
            const sc = statusColor(rf.Status);
            return (
              <div key={r.recordId}
                className={`ccs-list-item${selected?.recordId === r.recordId ? ' active' : ''}`}
                onClick={() => handleSelect(r)}
                // onMouseEnter={() => prefetchRecord(LAYOUT, r.recordId)}
              >
                <div className="ccs-list-org">{rf.zz__Display_Organization__ct || '—'}</div>
                <div className="ccs-list-meta">
                  <span className="ccs-list-contact">{rf.zz__Display_Contact__ct || ''}</span>
                  {rf.Status && (
                    <span className="ccs-list-status" style={{ color: sc, borderColor: sc+'44', background: sc+'18' }}>{rf.Status}</span>
                  )}
                </div>
                {rf['Type of Project(1)'] && <div className="ccs-list-type">{rf['Type of Project(1)']}</div>}
                {rf['rcd start date'] && <div className="ccs-list-date">{fmtDate(rf['rcd start date'])}</div>}
              </div>
            );
          }} />
        </div>
      </nav>

      <div className="ccs-resize-handle" onMouseDown={startResize} />

      <main className="ccs-main">
        {!selected ? (
          <div className="ccs-empty"><div className="ccs-empty-icon">◈</div><p>Select a record</p></div>
        ) : (
          <div className="ccs-detail">
            <div className="ccs-tabs">
              <div className="ccs-tabs-left">
                {[['primary','Primary Info'],['checklists','Checklists'],['financials','Financials']].map(([id,label]) => (
                  <button key={id} className={`ccs-tab${activeTab===id?' active':''}`} onClick={() => setActiveTab(id)}>{label}</button>
                ))}
                <span className="ccs-record-id">ID {selected.recordId}</span>
              </div>
              <div className="ccs-tabs-actions">
                {saveStatus === 'saved' && <span className="ccs-status-msg saved">✓ Saved</span>}
                {saveStatus === 'error' && <span className="ccs-status-msg error">✗ Failed</span>}
                {selected?.fieldData?.kanban_status && !dataEditing && (
                  <button className="ccs-action-btn" onClick={() => onNavigateTo?.('ccs-kanban', selected.recordId)}>View on Board ⊞</button>
                )}
                {!dataEditing ? (
                  <>
                    <button className="ccs-action-btn" onClick={() => { setDataEditing(true); primary.setEditMode(false); checklists.setEditMode(false); }}>✎ Edit</button>
                    {activeLayout && (
                      <>
                        <button className={`ccs-action-btn${activeLayout.editMode ? ' active' : ''}`}
                          onClick={() => { activeLayout.setEditMode(m => !m); setDataEditing(false); }}>⠿ Layout</button>
                        {activeLayout.editMode && <button className="ccs-action-btn sm" onClick={activeLayout.resetLayout}>Reset</button>}
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <button className="ccs-action-btn save" onClick={handleSave} disabled={saving || !dirtyCount}>
                      {saving ? '…' : dirtyCount ? `Save ${dirtyCount} change${dirtyCount > 1 ? 's' : ''}` : 'Save'}
                    </button>
                    <button className="ccs-action-btn" onClick={handleDiscard}>Discard</button>
                  </>
                )}
              </div>
            </div>

            <LayoutHint editMode={activeLayout?.editMode} />

            <div className="ccs-tab-body">

              {/* ── PRIMARY INFO ── */}
              {activeTab === 'primary' && (
                <DndContext sensors={primary.sensors} collisionDetection={closestCenter}
                  onDragStart={({ active }) => primary.setActiveId(active.id)}
                  onDragEnd={primary.handleSectionDragEnd}
                  onDragCancel={() => primary.setActiveId(null)}
                >
                  <SortableContext items={primary.sections.map(s => s.id)} strategy={verticalListSortingStrategy}>
                    {primary.sections.map(section => (
                      <SortableSection key={section.id} id={section.id} title={section.title} icon={section.icon} editMode={primary.editMode}>
                        <SectionContent section={section} onFieldReorder={primary.handleFieldReorder} {...sharedSectionProps} editMode={primary.editMode} />
                      </SortableSection>
                    ))}
                  </SortableContext>
                  <DragOverlay>
                    {primary.activeId && <SectionDragGhost title={primary.sections.find(s => s.id === primary.activeId)?.title} icon={primary.sections.find(s => s.id === primary.activeId)?.icon} />}
                  </DragOverlay>
                </DndContext>
              )}

              {/* ── CHECKLISTS ── */}
              {activeTab === 'checklists' && (
                <>
                  <DndContext sensors={checklists.sensors} collisionDetection={closestCenter}
                    onDragStart={({ active }) => checklists.setActiveId(active.id)}
                    onDragEnd={checklists.handleSectionDragEnd}
                    onDragCancel={() => checklists.setActiveId(null)}
                  >
                    <div className="ccs-checklist-grid">
                      <SortableContext items={checklists.sections.map(s => s.id)} strategy={verticalListSortingStrategy}>
                        {checklists.sections.map(section => (
                          <SortableSection key={section.id} id={section.id} title={section.title} icon={section.icon} editMode={checklists.editMode}>
                            <SectionContent section={section} onFieldReorder={checklists.handleFieldReorder} {...sharedSectionProps} editMode={checklists.editMode} />
                          </SortableSection>
                        ))}
                      </SortableContext>
                    </div>
                    <DragOverlay>
                      {checklists.activeId && <SectionDragGhost title={checklists.sections.find(s => s.id === checklists.activeId)?.title} />}
                    </DragOverlay>
                  </DndContext>

                  {/* Job Sheet — fixed */}
                  {(f['Job Sheet Poles']||f['Job Sheet Setting']||f['Job Sheet Equipment Rental']||f['Job Sheet Climbing Holds']||
                    f['Job Sheet Mats Tarps']||f['Job Sheet Specialty Hardware']||f['Job Sheet Lumber Order']||f['Job Sheet Permits']) && (
                    <div className="sl-section" style={{ marginTop: 12 }}>
                      <div className="sl-section-header" style={{ cursor: 'default' }}>
                        <span className="sl-section-icon">⊞</span>
                        <h3 style={{ flex: 1 }}>Job Sheet</h3>
                      </div>
                      <div className="sl-field-grid">
                        {[['Poles','Job Sheet Poles'],['Setting','Job Sheet Setting'],['Equipment Rental','Job Sheet Equipment Rental'],
                          ['Climbing Holds','Job Sheet Climbing Holds'],['Mats / Tarps','Job Sheet Mats Tarps'],
                          ['Specialty Hardware','Job Sheet Specialty Hardware'],['Lumber Order','Job Sheet Lumber Order'],
                          ['Permits','Job Sheet Permits']].map(([label, key]) => (
                          <div key={key} className="sl-field">
                            <label>{label}</label>
                            {!dataEditing
                              ? <span className="sl-value">{f[key] || '—'}</span>
                              : <input className="sl-input" value={(key in edits ? edits[key] : f[key]) || ''} onChange={e => handleFieldChange(key, e.target.value)} />
                            }
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ── FINANCIALS ── */}
              {activeTab === 'financials' && (
                <div className="sl-section">
                  <div className="sl-section-header" style={{ cursor: 'default' }}>
                    <span className="sl-section-icon">$</span>
                    <h3 style={{ flex: 1 }}>Financials</h3>
                  </div>
                  <div>
                    <div className="ccs-portal-tabs">
                      {[['estimates','Estimates',estimates.length],['invoices','Invoices',invoices.length],['payments','Payments',payments.length]].map(([id,label,count]) => (
                        <button key={id} className={`ccs-portal-tab${activePortal===id?' active':''}`} onClick={() => setActivePortal(id)}>
                          {label}<span className="ccs-portal-count">{count}</span>
                        </button>
                      ))}
                    </div>
                    <div className="ccs-table-wrap">
                      {activePortal === 'estimates' && <PortalTable columns={[{key:'cntct_ESTMT::Title',label:'Title'},{key:'cntct_ESTMT::Date',label:'Date',fmt:fmtDate},{key:'cntct_ESTMT::Status',label:'Status'},{key:'cntct_ESTMT::zz__Total__xn',label:'Total',fmt:fmtMoney}]} rows={estimates} />}
                      {activePortal === 'invoices' && <PortalTable columns={[{key:'cntct_INVO::QuickBooks_Reference_Number',label:'Ref #'},{key:'cntct_INVO::Date',label:'Date',fmt:fmtDate},{key:'cntct_INVO::zz__Total__xn',label:'Total',fmt:fmtMoney},{key:'cntct_INVO::zz__Balance_Due__cn',label:'Balance',fmt:fmtMoney}]} rows={invoices} />}
                      {activePortal === 'payments' && <PortalTable columns={[{key:'cntct_PMT::Date',label:'Date',fmt:fmtDate},{key:'cntct_PMT::Method',label:'Method'},{key:'cntct_PMT::Amount',label:'Amount',fmt:fmtMoney},{key:'cntct_PMT::zz__Balance__cn',label:'Balance',fmt:fmtMoney}]} rows={payments} />}
                    </div>
                  </div>
                </div>
              )}

              {/* Meta footer */}
              {activeTab === 'primary' && (
                <div className="ccs-meta-footer">
                  <span>Modified By <strong>{f.zz__Modified_By}</strong></span>
                  <span>Modified On <strong>{f.zz__Modified_On}</strong></span>
                  <span>Created By <strong>{f.zz__Created_By}</strong></span>
                  <span>Created On <strong>{f.zz__Created_On}</strong></span>
                  <span>RCD # <strong>{f._kpt__RCD_ID}</strong></span>
                  {f.kanban_status && <span>kanban_status <strong>{f.kanban_status}</strong></span>}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
