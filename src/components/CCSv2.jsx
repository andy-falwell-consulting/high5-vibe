import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useAllRecords } from '../hooks/useAllRecords';
import { RCD_LAYOUT, RCD_CACHE_VERSION, RCD_FIND_QUERY, RCD_SORT } from '../config/ccsCache';
import { getRecord, prefetchRecord, updateRecord, patchCachedRecord, invalidateRecord } from '../api/filemaker';
import { getCurrentEnv } from '../config/fmpEnvironments';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import AttachmentsPanel from './AttachmentsPanel';
import { listCcsAttachments, uploadCcsAttachment, deleteCcsAttachment, ccsAttachmentUrl } from '../api/ccsAttachments';
import './CCSv2.css';

const LAYOUT = RCD_LAYOUT;
const CCS_ATT_API = { list: listCcsAttachments, upload: uploadCcsAttachment, remove: deleteCcsAttachment, freshUrl: ccsAttachmentUrl };

// ── Vocabularies (grounded in live data) ─────────────────────────
const PIPELINE = [
  'New Project Inquiry', 'Working Proposals', 'Proposals Out', 'Sent Contract and DI',
  'Job Prep by Date', 'Done/Ready for Building', 'Commissioning Report Needed', "No Go's (litter box)",
];
const PIPELINE_SHORT = [
  'New inquiry', 'Working proposals', 'Proposals out', 'Sent contract & DI',
  'Job prep by date', 'Ready for building', 'Commissioning report', 'No go',
];

const STATUS_OPTIONS = ['Proposed', 'Confirmed', 'Confirmed/Scheduled', 'In Progress', 'Completed', 'No Go', 'On Hold', 'Cancelled'];
const PROJECT_TYPES  = ['Inspection', 'New Construction', 'Renovation', 'Repair', 'Training', 'Other'];
const BUILDER_OPTIONS = ['', 'Dave Klim', 'Lucas Germano', 'Gary Hillsgrove', 'Todd Brown', 'Ian Doak', 'Kyle Myers', 'Colin Morton'];

// "Job Prep - External" (event_prep phase, below) groups its checklist items
// by category, each paired with a free-text "Job Sheet <Category>" notes
// field — mirrors the RCD_New "Job Prep - External" tab exactly (fields
// verified live against the layout).
const EVENT_PREP_GROUPS = [
  { title: 'Poles', notes: 'Job Sheet Poles', items: [
    ['eprep_Poles Ordered', 'Ordered'], ['eprep_Poles Delivered', 'Delivered'],
  ]},
  { title: 'Rental', notes: 'Job Sheet Equipment Rental', items: [
    ['eprep_Equipment Requested', 'Requested'], ['eprep_Equipment Reserved', 'Reserved'],
  ]},
  { title: 'Setting', notes: 'Job Sheet Setting', items: [
    ['eprep_Setting Scheduled', 'Scheduled'], ['eprep_Setting Complete', 'Complete'],
    ['eprep_Dig Safe', 'Dig Safe / Notice to Excavate'],
  ]},
  { title: 'Climbing Holds', notes: 'Job Sheet Climbing Holds', items: [
    ['eprep_Climbing Holds Ordered', 'Ordered'], ['eprep_Climbing Holds Delivered', 'Delivered'],
  ]},
  { title: 'Mats / Tarps', notes: 'Job Sheet Mats Tarps', items: [
    ['eprep_Tarps Mats Ordered', 'Ordered'], ['eprep_Tarps Mats Delivered', 'Delivered'],
  ]},
  { title: 'Specialty Hardware', notes: 'Job Sheet Specialty Hardware', items: [
    ['eprep_Specialty Hardware', 'Specialty Hardware'],
  ]},
  { title: 'Lumber', notes: 'Job Sheet Lumber Order', items: [
    ['eprep_Lumber_ordered', 'Ordered'], ['eprep_Lumber_ordered_delivered', 'Delivered'],
  ]},
  { title: 'Permits', notes: 'Job Sheet Permits', items: [
    ['eprep_Permits', 'Permits'],
  ]},
];

// Phases → checklist fields (exact FileMaker keys), with labels mirroring the
// RCD_New "Additional Info" tab (Pre-Proposal / Proposal / Contract and Deposit
// / Job Prep / Job Prep - External). Keep this in sync with that tab.
const PHASES = [
  { id: 'pre_proposal', name: 'Pre-Proposal', items: [
    ['pp_Sent PD Form', 'Sent Program Development Form'],
    ['pp_New_cust_exist_course_survey', 'New customer with Existing Course Survey'],
    ['pp_Created Client Folder', 'Create Client Folder on the Server'],
    ['pp_Create CCS for Site Eval', 'Site Visit / Zoom Meeting (Create a CCS record for SITE EVAL)'],
  ]},
  { id: 'proposal', name: 'Proposal', items: [
    ['p_CCS Estimate', 'CCS Estimate'],
    ['p_Training Plan', 'Training Plan'],
    ['p_Drawings', 'Drawings'],
    ['p_Mark as Proposed', 'Mark as Proposed'],
  ]},
  { id: 'contract', name: 'Contract and Deposit', items: [
    ['cd_Sent Contract', 'Send Contract and Deposit Invoice'],
    ['cd_Add to Cal', 'Offer Dates and add to calendar'],
    ['cd_Received Contract', 'Received Contract'],
    ['cd_Received Deposit', 'Received Deposit'],
    ['cd_Received PO', 'Received PO'],
    ['Final_Invoice_Received', 'Final Invoice Received'],
  ]},
  { id: 'job_prep', name: 'Job Prep', items: [
    ['Populate_Work_Order', 'Mark as confirmed/scheduled. Populate work order.'],
    ['iprep_Prefab List', 'Prefab List'],
    ['iprep_Construction Layout', 'Construction Layout'],
    ['iprep_Training', 'Training, Notify Director of Training'],
    ['iprep_Equipment', 'Equipment, Notify Catalog'],
    ['iprep_Need Inspection', 'Inspection Needed?'],
  ]},
  { id: 'event_prep', name: 'Job Prep - External', items: EVENT_PREP_GROUPS.flatMap(g => g.items) },
];

// Contract & financials block — mirrors the RCD_New "Additional Info" form.
// `sent` is a date/text field; `rcv` is the "Received" checkbox (optional).
// `ref: true` rows are read-only QBO identifiers.
const FIN_ROWS = [
  { label: 'Estimate #',        sent: '_kat__QuickBooks_Estimate_ID(1)', type: 'text', ref: true },
  { label: 'Contract Sent',     sent: 'Contract_Date_Sent',           type: 'date', rcv: 'cd_Received Contract' },
  { label: 'Deposit Inv. Sent', sent: 'Report Date Sent',             type: 'date', rcv: 'cd_Received Deposit' },
  { label: 'PO #',              sent: 'po_number',                    type: 'text', rcv: 'cd_Received PO' },
  { label: 'Final Inv. Sent',   sent: 'Final Sent',                   type: 'date', rcv: 'Final_Invoice_Received' },
  { label: 'Invoice #',         sent: '_kat__QuickBooks_Invoice_ID(1)', type: 'text', ref: true },
];

// Prominent one-click actions → checklist field they satisfy.
const QUICK_ACTIONS = [
  { key: 'cd_Sent Contract',      label: 'Sent contract',   icon: '✉' },
  { key: 'cd_Received Deposit',   label: 'Got deposit',     icon: '$' },
  { key: 'cd_Received Contract',  label: 'Got contract',    icon: '✓' },
  { key: 'Final_Invoice_Received',label: 'Final invoiced',  icon: '⊘' },
];

// ── Helpers ──────────────────────────────────────────────────────
const EMPTY_FIELDS = {};
const isOn = v => v === 1 || v === '1';

function statusColor(s) {
  const t = (s || '').toLowerCase();
  if (t.includes('complet')) return '#22c55e';
  if (t.includes('no go') || t.includes('cancel')) return '#94a3b8';
  if (t.includes('progress')) return '#a855f7';
  if (t.includes('confirm') || t.includes('schedul')) return '#3b82f6';
  if (t.includes('propos') || t.includes('inquir')) return '#e8a23a';
  if (t.includes('hold')) return '#f59e0b';
  return '#94a3b8';
}

const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
const fmtMoney = v => { const n = num(v); return n ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—'; };
const fmtMoneyFull = v => `$${num(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

const parseFmDate = v => {
  if (!v) return null;
  const [date] = String(v).split(' ');
  const [m, d, y] = date.split('/');
  if (!y) return null;
  const dt = new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00`);
  return isNaN(dt) ? null : dt;
};
const fmtDate = v => {
  const dt = parseFmDate(v);
  return dt ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : (v || '—');
};
const fmtDateShort = v => {
  const dt = parseFmDate(v);
  return dt ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
};
const daysUntil = v => {
  const dt = parseFmDate(v);
  if (!dt) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((dt - today) / 86400000);
};
const toIso = v => {
  if (!v) return '';
  const p = String(v).split('/');
  return p.length === 3 ? `${p[2]}-${p[0].padStart(2, '0')}-${p[1].padStart(2, '0')}` : '';
};
const fromIso = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
const initials = name => (name || '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '—';

// ── Small UI pieces ──────────────────────────────────────────────
function Ring({ pct, color, size = 38, stroke = 4 }) {
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const off = C * (1 - Math.min(1, pct));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--cv2-ring-track)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeLinecap="round" strokeDasharray={C.toFixed(2)} strokeDashoffset={off.toFixed(2)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

function Avatar({ name, lead }) {
  return (
    <span className={`cv2-avatar${lead ? ' lead' : ''}`} title={name}>{initials(name)}</span>
  );
}

function InlineText({ value, onChange, placeholder, area, big }) {
  if (area) return <textarea className={`cv2-inline cv2-inline-area${big ? ' cv2-inline-area-lg' : ''}`} rows={3} value={value || ''} placeholder={placeholder} onChange={e => onChange(e.target.value)} />;
  return <input className="cv2-inline" value={value || ''} placeholder={placeholder} onChange={e => onChange(e.target.value)} />;
}
function InlineSelect({ value, options, onChange }) {
  return (
    <select className="cv2-inline cv2-inline-select" value={value || ''} onChange={e => onChange(e.target.value)}>
      <option value="">—</option>
      {options.filter(Boolean).map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
function InlineDate({ value, onChange }) {
  return <input type="date" className="cv2-inline cv2-inline-date" value={toIso(value)} onChange={e => onChange(fromIso(e.target.value))} />;
}

// ── Main ─────────────────────────────────────────────────────────
export default function CCSv2({ navTarget, onNavigateTo, onClearNav, onRecordSelect }) {
  const { records, total } = useAllRecords(LAYOUT, { cacheVersion: RCD_CACHE_VERSION, findQuery: RCD_FIND_QUERY, sort: RCD_SORT });

  const [selected, setSelected] = useState(null);
  const [navWidth, setNavWidth] = useState(300);
  const [edits, setEdits]       = useState({});
  const [saving, setSaving]     = useState(false);
  const [addingToBoard, setAddingToBoard] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [saveErrorMsg, setSaveErrorMsg] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [finTab, setFinTab]     = useState('invoices');
  // Live QBO estimate(s) for the selected project — resolved from its D# via
  // /api/ccs-estimate (null = not loaded/none; array = fetched).
  const [qboEst, setQboEst]     = useState(null);
  const isResizing = useRef(false);
  const selectedRef = useRef(null); // guards async estimate fetch against stale selections

  const f = useMemo(() => selected?.fieldData || EMPTY_FIELDS, [selected]);
  const val = useCallback(fk => (fk in edits ? edits[fk] : f[fk]), [edits, f]);
  const stage = useCallback((fk, v) => setEdits(p => ({ ...p, [fk]: v })), []);
  const toggle = useCallback(fk => setEdits(p => ({ ...p, [fk]: isOn(fk in p ? p[fk] : f[fk]) ? 0 : 1 })), [f]);

  // Phase progress (live, reflects pending edits)
  const phaseStats = useMemo(() => PHASES.map(p => {
    const done = p.items.filter(([k]) => isOn(k in edits ? edits[k] : f[k])).length;
    return { id: p.id, name: p.name, done, all: p.items.length, pct: done / p.items.length };
  }), [edits, f]);

  const allPhasesDone = phaseStats.every(s => s.pct >= 1);
  const pipelineIdx = PIPELINE.indexOf(val('kanban_status'));
  const startDays = daysUntil(val('rcd start date'));
  const eventStat = phaseStats.find(s => s.id === 'job_prep');
  const eventUrgent = startDays != null && startDays >= 0 && startDays <= 30 && eventStat && eventStat.pct < 1;
  const eventCritical = eventUrgent && startDays <= 10;

  const phaseColor = useCallback((s) => {
    if (s.pct >= 1) return '#1d9e75';
    if (s.id === 'job_prep' && eventUrgent) return eventCritical ? '#e24b4a' : '#ba7517';
    return '#d85a30';
  }, [eventUrgent, eventCritical]);


  // Financial roll-ups from portals
  const portals = selected?.portalData || {};
  const estimates = portals['Portal__Estimates 2'] || [];
  const invoices  = portals['Portal__Invoices']    || [];
  const payments  = portals['Portal__Payments']    || [];
  const estTotal  = estimates.reduce((a, r) => a + num(r['cntct_ESTMT::zz__Total__xn']), 0);
  const invTotal  = invoices.reduce((a, r) => a + num(r['cntct_INVO::zz__Total__xn']), 0);
  const balanceDue = invoices.reduce((a, r) => a + num(r['cntct_INVO::zz__Balance_Due__cn']), 0);
  const paid      = payments.reduce((a, r) => a + num(r['cntct_PMT::Amount']), 0);
  const received  = paid > 0 ? paid : Math.max(0, invTotal - balanceDue);
  const estValue  = estTotal || invTotal;

  // ── Selection / nav / cache sync ──
  async function handleSelect(r) {
    setEdits({}); setSaveStatus(null); setFinTab('invoices'); setQboEst(null);
    selectedRef.current = r.recordId;
    setSelected(r);
    // auto-expand the first incomplete phase
    const firstOpen = PHASES.find(p => p.items.some(([k]) => !isOn(r.fieldData[k])));
    setExpanded(firstOpen ? { [firstOpen.id]: true } : {});
    getRecord(LAYOUT, r.recordId).then(detail => {
      setSelected(prev => prev?.recordId === r.recordId ? detail.response.data[0] : prev);
    }).catch(() => {});
    // Live QBO estimate lookup (via the project's D#). No-ops on localhost
    // (no serverless functions); leaves qboEst null so nothing renders.
    fetch(`/api/ccs-estimate?db=${encodeURIComponent(getCurrentEnv().db)}&recordId=${r.recordId}`)
      .then(res => res.ok ? res.json() : null)
      .then(j => { if (j) setQboEst(prev => (selectedRef.current === r.recordId ? (j.estimates || []) : prev)); })
      .catch(() => {});
  }

  useEffect(() => {
    if (!selected) return;
    const updated = records.find(r => String(r.recordId) === String(selected.recordId));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync selected with cache patches
    if (updated) setSelected(prev => prev ? { ...prev, fieldData: { ...prev.fieldData, ...updated.fieldData } } : prev);
  }, [records]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (navTarget?.moduleId !== 'ccs-v2' || !navTarget.recordId) return;
    const record = records.find(r => String(r.recordId) === String(navTarget.recordId));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deep-link selection
    if (record) { handleSelect(record); onClearNav?.(); return; }
    // Older projects fall outside the 2-year list filter, so a deep-link / agent
    // source pill won't find them in `records`. Fetch directly so it still opens.
    let alive = true;
    getRecord(LAYOUT, navTarget.recordId).then(d => {
      const r = d?.response?.data?.[0];
      if (alive && r) { handleSelect(r); onClearNav?.(); }
    }).catch(() => {});
    return () => { alive = false; };
  }, [navTarget, records]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDiscard = () => { setEdits({}); setSaveStatus(null); setSaveErrorMsg(null); };
  const handleSave = async () => {
    if (!selected || !Object.keys(edits).length) return;
    setSaving(true); setSaveStatus(null); setSaveErrorMsg(null);
    try {
      const res = await updateRecord(LAYOUT, selected.recordId, edits);
      if (res.messages?.[0]?.code === '0') {
        setSelected(p => ({ ...p, fieldData: { ...p.fieldData, ...edits } }));
        patchCachedRecord(RCD_LAYOUT, RCD_CACHE_VERSION, selected.recordId, edits);
        invalidateRecord(LAYOUT, selected.recordId);
        setEdits({}); setSaveStatus('saved');
        setTimeout(() => setSaveStatus(null), 2500);
      } else setSaveStatus('error');
    } catch (e) { setSaveStatus('error'); setSaveErrorMsg(e?.message || null); }
    finally { setSaving(false); }
  };

  const startResize = useCallback((e) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
    const startX = e.clientX, startW = navWidth;
    const onMove = ev => { if (isResizing.current) setNavWidth(Math.min(460, Math.max(220, startW + (ev.clientX - startX)))); };
    const onUp = () => { isResizing.current = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  }, [navWidth]);

  // ── List filtering / sorting ──
  const parseTs = v => { const dt = parseFmDate(v); return dt ? dt.getTime() : 0; };
  const projStatus = t => { t = (t || '').toLowerCase(); if (t.includes('complet')) return 'done'; if (t.includes('no go') || t.includes('cancel')) return 'nogo'; return t ? 'active' : null; };

  const list = useListControls({
    records,
    storageKey: 'ccs2_sort',
    name: f => f.zz__Display_Organization__ct || '',
    searchKeys: ['zz__Display_Organization__ct', 'zz__Display_Contact__ct', 'Status', 'kanban_status'],
    chips: [
      { id: 'all', label: 'All' },
      { id: 'active', label: 'Active', color: '#3b82f6', match: f => projStatus(f.Status) === 'active' },
      { id: 'done', label: 'Completed', color: '#22c55e', match: f => projStatus(f.Status) === 'done' },
      { id: 'nogo', label: 'No go', color: '#94a3b8', match: f => projStatus(f.Status) === 'nogo' },
    ],
    sorts: [
      { id: 'created', label: 'Created', value: f => parseTs(f.zz__Created_On) },
      { id: 'modified', label: 'Modified', value: f => parseTs(f.zz__Modified_On) },
      { id: 'event', label: 'Event date', value: f => parseTs(f['rcd start date']) },
      { id: 'alpha', label: 'Name', alpha: true, value: f => (f.zz__Display_Organization__ct || '').trim().toLowerCase() || '￿' },
    ],
    defaultSort: 'created', defaultOrder: 'desc',
  });

  const dirtyCount = Object.keys(edits).length;
  const status = val('Status');
  const sc = statusColor(status);
  const org = f.zz__Display_Organization__ct || '—';

  return (
    <div className="cv2-root">
      <nav className="cv2-nav" style={{ width: navWidth }}>
        <div className="cv2-nav-head">
          <div className="cv2-nav-title"><div><div className="cv2-nav-name">CCS</div><div className="cv2-nav-count">{total ? `${records.length} / ${total}` : records.length}</div></div></div>
          <ListToolbar c={list} unit="projects" />
        </div>
        <div className="cv2-list">
          <ListBody c={list} activeId={selected?.recordId} renderItem={r => {
            const rf = r.fieldData; const c = statusColor(rf.Status);
            const d = daysUntil(rf['rcd start date']);
            return (
              <div key={r.recordId} className={`cv2-list-item${selected?.recordId === r.recordId ? ' active' : ''}`}
                onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId, r.fieldData?.zz__Display_Organization__ct); }} /* onMouseEnter={() => prefetchRecord(LAYOUT, r.recordId)} */>
                <span className="cv2-list-dot" style={{ background: c }} />
                <div className="cv2-list-body">
                  <div className="cv2-list-org">{rf.zz__Display_Organization__ct || '—'}</div>
                  <div className="cv2-list-sub">
                    <span>{rf.zz__Display_Contact__ct || rf.kanban_status || ''}</span>
                    {d != null && d >= 0 && d <= 30 && <span className="cv2-list-due">{d}d</span>}
                  </div>
                </div>
              </div>
            );
          }} />
        </div>
      </nav>

      <div className="cv2-resize" onMouseDown={startResize} />

      <main className="cv2-main">
        {!selected ? (
          <div className="cv2-empty"><div className="cv2-empty-icon">◈</div><p>Select a project</p></div>
        ) : (
          <>
            <div className="cv2-canvas">
              {/* breadcrumb */}
              <div className="cv2-crumb">
                <span className="cv2-crumb-dim">CCS v2</span><span className="cv2-crumb-sep">/</span><span>{org}</span>
                <span className="cv2-crumb-spacer" />
                {val('kanban_status')
                  ? <button className="cv2-ghost-btn" onClick={() => onNavigateTo?.('ccs-kanban', selected.recordId)}>⊞ Board</button>
                  : <button className="cv2-ghost-btn cv2-add-board" disabled={addingToBoard} onClick={async () => {
                      // One-click: put this project on the Kanban board (first stage), saved immediately.
                      setAddingToBoard(true);
                      try {
                        await updateRecord(LAYOUT, selected.recordId, { kanban_status: PIPELINE[0] });
                        patchCachedRecord(RCD_LAYOUT, RCD_CACHE_VERSION, selected.recordId, { kanban_status: PIPELINE[0] });
                        setSelected(s => ({ ...s, fieldData: { ...s.fieldData, kanban_status: PIPELINE[0] } }));
                      } catch { window.alert('Could not add to the board.'); }
                      finally { setAddingToBoard(false); }
                    }}>{addingToBoard ? 'Adding…' : '⊞ Add to board'}</button>}
                <span className="cv2-crumb-id">#{f._kpt__RCD_ID || selected.recordId}</span>
              </div>

              {/* HERO */}
              <div className="cv2-hero">
                <div className="cv2-hero-top">
                  <div className="cv2-hero-id">
                    <div className="cv2-hero-type">{val('Type of Project(1)') || 'Project'}</div>
                    <h1 className="cv2-hero-org">{org}</h1>
                    <div className="cv2-hero-contact">
                      {f.zz__Display_Contact__ct && <><span className="cv2-ic">◉</span>{f.zz__Display_Contact__ct}</>}
                    </div>
                  </div>
                  <select className="cv2-status" style={{ color: sc, borderColor: sc + '55', background: sc + '14' }}
                    value={status || ''} onChange={e => stage('Status', e.target.value)}>
                    {!STATUS_OPTIONS.includes(status) && status && <option value={status}>{status}</option>}
                    <option value="">— status —</option>
                    {STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>

                {/* pipeline */}
                <div className="cv2-pipe-wrap">
                  <div className="cv2-pipe-head">
                    <span className="cv2-pipe-label">Pipeline</span>
                    <span className="cv2-pipe-stage">
                      {pipelineIdx >= 0
                        ? <><b style={{ color: '#993c1d' }}>Stage {pipelineIdx + 1} of {PIPELINE.length}</b> · {PIPELINE_SHORT[pipelineIdx]}</>
                        : <button className="cv2-link-btn" onClick={() => { stage('kanban_status', PIPELINE[0]); }}>+ Add to pipeline</button>}
                    </span>
                  </div>
                  <div className="cv2-pipe">
                    {PIPELINE.map((s, i) => (
                      <div key={s} className="cv2-pipe-seg">
                        {i > 0 && <span className="cv2-pipe-line" style={{ background: i <= pipelineIdx ? '#d85a30' : 'var(--cv2-line)' }} />}
                        <button className={`cv2-pipe-dot${i < pipelineIdx ? ' done' : i === pipelineIdx ? ' cur' : ''}`}
                          title={PIPELINE_SHORT[i]} aria-label={PIPELINE_SHORT[i]}
                          onClick={() => stage('kanban_status', s)} />
                      </div>
                    ))}
                  </div>
                </div>

                {/* quick actions */}
                <div className="cv2-quick">
                  {QUICK_ACTIONS.map(qa => {
                    const on = isOn(val(qa.key));
                    return (
                      <button key={qa.key} className={`cv2-quick-btn${on ? ' on' : ''}`} onClick={() => toggle(qa.key)}>
                        <span className="cv2-quick-ic">{on ? '✓' : qa.icon}</span>{qa.label}
                      </button>
                    );
                  })}
                </div>
              </div>


              {/* KPIs */}
              <div className="cv2-kpis">
                <div className="cv2-kpi"><div className="cv2-kpi-label">Estimated value</div><div className="cv2-kpi-num">{fmtMoney(estValue)}</div></div>
                <div className="cv2-kpi"><div className="cv2-kpi-label">Received</div><div className="cv2-kpi-num" style={{ color: received ? '#0f6e56' : 'inherit' }}>{fmtMoney(received)}</div></div>
                <div className="cv2-kpi"><div className="cv2-kpi-label">Balance due</div><div className="cv2-kpi-num" style={{ color: balanceDue ? '#854f0b' : 'inherit' }}>{fmtMoney(balanceDue)}</div></div>
                <div className="cv2-kpi">
                  <div className="cv2-kpi-label">Event date</div>
                  <div className="cv2-kpi-num">{fmtDate(val('rcd start date'))}</div>
                  {startDays != null && <div className={`cv2-kpi-sub${eventUrgent ? ' urg' : ''}`}>{startDays < 0 ? `${-startDays}d ago` : startDays === 0 ? 'today' : `in ${startDays}d`}</div>}
                </div>
              </div>

              {/* BODY: full-width phases → details → contact/financials/contract/team cluster */}
              <div className="cv2-body">
                {/* project phases — full width */}
                <div className="cv2-card cv2-phases-card">
                  <div className="cv2-card-head"><span>Project phases</span><span className="cv2-card-hint">click to expand · check to update</span></div>
                  <div className="cv2-phases">
                    {phaseStats.map(s => {
                      const phase = PHASES.find(p => p.id === s.id);
                      const col = phaseColor(s); const open = !!expanded[s.id]; const full = s.pct >= 1;
                      const nextStageName = pipelineIdx >= 0 && pipelineIdx < PIPELINE.length - 1 ? PIPELINE_SHORT[pipelineIdx + 1] : null;
                      return (
                        <div key={s.id} className={`cv2-phase${open ? ' open' : ''}`}>
                          <button className="cv2-phase-head" onClick={() => setExpanded(p => ({ ...p, [s.id]: !p[s.id] }))}>
                            <Ring pct={s.pct} color={col} />
                            <div className="cv2-phase-info">
                              <div className="cv2-phase-row"><span className="cv2-phase-name">{s.name}</span><span className="cv2-phase-count" style={{ color: full ? '#0f6e56' : 'var(--cv2-text-2)' }}>{s.done}/{s.all}{full ? ' · done' : ''}</span></div>
                              <div className="cv2-phase-bar"><div style={{ width: `${Math.round(s.pct * 100)}%`, background: col }} /></div>
                            </div>
                            <span className="cv2-chev">{open ? '▴' : '▾'}</span>
                          </button>
                          {open && (
                            <div className="cv2-phase-body">
                              {s.id === 'event_prep' ? (
                                <div className="cv2-eprep-grid">
                                  {EVENT_PREP_GROUPS.map(g => (
                                    <div className="cv2-eprep-group" key={g.title}>
                                      <div className="cv2-eprep-title">{g.title}</div>
                                      <div className="cv2-checks">
                                        {g.items.map(([k, label]) => {
                                          const on = isOn(val(k));
                                          return (
                                            <button key={k} className={`cv2-check${on ? ' on' : ''}`} onClick={() => toggle(k)}>
                                              <span className="cv2-check-box" style={on ? { background: col, borderColor: col } : undefined}>{on ? '✓' : ''}</span>
                                              <span className="cv2-check-label">{label}</span>
                                            </button>
                                          );
                                        })}
                                      </div>
                                      <InlineText value={val(g.notes)} onChange={v => stage(g.notes, v)} placeholder="Notes…" area />
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="cv2-checks">
                                  {phase.items.map(([k, label]) => {
                                    const on = isOn(val(k));
                                    return (
                                      <button key={k} className={`cv2-check${on ? ' on' : ''}`} onClick={() => toggle(k)}>
                                        <span className="cv2-check-box" style={on ? { background: col, borderColor: col } : undefined}>{on ? '✓' : ''}</span>
                                        <span className="cv2-check-label">{label}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                              {full && nextStageName && pipelineIdx < PIPELINE.length - 1 && (
                                <div className="cv2-advance">
                                  <span>✓ Phase complete</span>
                                  <button onClick={() => stage('kanban_status', PIPELINE[pipelineIdx + 1])}>Advance to {nextStageName} →</button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* details */}
                <div className="cv2-card">
                  <div className="cv2-card-head"><span>Details</span></div>
                  <div className="cv2-detail-grid">
                    <label>Project type</label><InlineSelect value={val('Type of Project(1)')} options={PROJECT_TYPES} onChange={v => stage('Type of Project(1)', v)} />
                    <label>Start date</label><InlineDate value={val('rcd start date')} onChange={v => stage('rcd start date', v)} />
                    <label>End date</label><InlineDate value={val('rcd end date')} onChange={v => stage('rcd end date', v)} />
                    <label>Stage</label><InlineSelect value={val('kanban_status')} options={PIPELINE} onChange={v => stage('kanban_status', v)} />
                    <label>Distance to HQ</label><InlineText value={val('Distance to High5')} onChange={v => stage('Distance to High5', v)} placeholder="—" />
                    <label>Drive time</label><InlineText value={val('Drive Time')} onChange={v => stage('Drive Time', v)} placeholder="—" />
                  </div>
                  <div className="cv2-field-block">
                    <label>Work order</label>
                    <InlineText value={val('Work Order')} onChange={v => stage('Work Order', v)} placeholder="Add a work order…" area big />
                  </div>
                  <div className="cv2-field-block">
                    <label>Notes</label>
                    <InlineText value={val('Notes')} onChange={v => stage('Notes', v)} placeholder="Add notes…" area />
                  </div>
                </div>

                <div className="cv2-cols">
                  <div className="cv2-col-main">
                    <div className="cv2-card">
                      <div className="cv2-card-head"><span>Contract &amp; Financials</span></div>
                      <div className="cv2-fin-grid">
                        {FIN_ROWS.map(row => (
                          <div className="cv2-fin-line" key={row.label}>
                            <span className="cv2-fin-label">{row.label}</span>
                            <div className="cv2-fin-input">
                              {row.ref
                                ? <span className="cv2-fin-ref">{val(row.sent) || '—'}</span>
                                : row.type === 'date'
                                  ? <InlineDate value={val(row.sent)} onChange={v => stage(row.sent, v)} />
                                  : <InlineText value={val(row.sent)} onChange={v => stage(row.sent, v)} placeholder="—" />}
                            </div>
                            {row.rcv
                              ? <button className={`cv2-fin-rcv${isOn(val(row.rcv)) ? ' on' : ''}`} onClick={() => toggle(row.rcv)}>
                                  <span className="cv2-fin-rcv-box">{isOn(val(row.rcv)) ? '✓' : ''}</span>Received
                                </button>
                              : <span className="cv2-fin-rcv-spacer" />}
                          </div>
                        ))}
                      </div>
                      {qboEst && qboEst.length > 0 && (
                        <div className="cv2-qboest">
                          <div className="cv2-qboest-head">QuickBooks estimate{qboEst.length > 1 ? 's' : ''} · live</div>
                          {qboEst.map(e => (
                            <div className="cv2-qboest-row" key={e.docNumber}>
                              <span className="cv2-qboest-doc">{e.docNumber}</span>
                              {e.missing
                                ? <span className="cv2-qboest-missing">not found in QBO</span>
                                : <>
                                    <span className={`cv2-qboest-status ${String(e.status || '').toLowerCase()}`}>{e.status || '—'}</span>
                                    <span className="cv2-qboest-total">{fmtMoneyFull(e.total)}</span>
                                  </>}
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Invoices / Payments (folded in from the old Financials card;
                          estimates are covered by the live QBO block above). */}
                      <div className="cv2-fin-embed">
                        <div className="cv2-fin-tabs">
                          {[['invoices', 'Invoices', invoices.length], ['payments', 'Payments', payments.length]].map(([id, lbl, n]) => (
                            <button key={id} className={`cv2-fin-tab${finTab === id ? ' active' : ''}`} onClick={() => setFinTab(id)}>{lbl}<span>{n}</span></button>
                          ))}
                        </div>
                        <div className="cv2-fin-list">
                          {finTab === 'invoices' && (invoices.length ? invoices.map((r, i) => (
                            <div className="cv2-fin-row" key={i}><span className="cv2-fin-main">#{r['cntct_INVO::QuickBooks_Reference_Number'] || '—'} · {fmtDateShort(r['cntct_INVO::Date'])}</span><span className="cv2-fin-amt">{fmtMoneyFull(r['cntct_INVO::zz__Total__xn'])}</span></div>
                          )) : <div className="cv2-fin-empty">No invoices</div>)}
                          {finTab === 'payments' && (payments.length ? payments.map((r, i) => (
                            <div className="cv2-fin-row" key={i}><span className="cv2-fin-main">{fmtDateShort(r['cntct_PMT::Date'])} · {r['cntct_PMT::Method'] || '—'}</span><span className="cv2-fin-amt">{fmtMoneyFull(r['cntct_PMT::Amount'])}</span></div>
                          )) : <div className="cv2-fin-empty">No payments</div>)}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="cv2-col-rail">
                    {/* contact */}
                    <div className="cv2-card">
                      <div className="cv2-card-head"><span>Contact</span></div>
                      <div className="cv2-contact">
                        {f.Address_Block_Billing && <div className="cv2-contact-row"><span className="cv2-ic">⌖</span><span style={{ whiteSpace: 'pre-wrap' }}>{f.Address_Block_Billing.replace(/\r/g, '\n')}</span></div>}
                        {f['rcd_cntct_INADR__email::zz__Address__ct'] && <div className="cv2-contact-row"><span className="cv2-ic">✉</span><a href={`mailto:${f['rcd_cntct_INADR__email::zz__Address__ct']}`}>{f['rcd_cntct_INADR__email::zz__Address__ct']}</a></div>}
                        {f['rcd_cntct_PHONE__work::Number'] && <div className="cv2-contact-row"><span className="cv2-ic">✆</span><span>{f['rcd_cntct_PHONE__work::Number']}</span></div>}
                        {f['rcd_cntct_PHONE__mobile::Number'] && <div className="cv2-contact-row"><span className="cv2-ic">▢</span><span>{f['rcd_cntct_PHONE__mobile::Number']}</span></div>}
                      </div>
                    </div>

                    {/* team */}
                    <div className="cv2-card">
                      <div className="cv2-card-head"><span>Team</span></div>
                      <div className="cv2-team">
                        <div className="cv2-team-row">
                          <Avatar name={val('Lead Builder')} lead />
                          <div className="cv2-team-pick"><label>Lead builder</label><InlineSelect value={val('Lead Builder')} options={BUILDER_OPTIONS} onChange={v => stage('Lead Builder', v)} /></div>
                        </div>
                        {['Builder1', 'Builder2', 'Builder3'].map((bk, i) => (
                          <div className="cv2-team-row" key={bk}>
                            <Avatar name={val(bk)} />
                            <div className="cv2-team-pick"><label>Builder {i + 1}</label><InlineSelect value={val(bk)} options={BUILDER_OPTIONS} onChange={v => stage(bk, v)} /></div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {allPhasesDone && !(status || '').toLowerCase().includes('complet') && (
                <div className="cv2-suggest">
                  <span>All phases complete.</span>
                  <button onClick={() => stage('Status', 'Completed')}>Mark project Completed →</button>
                </div>
              )}

              <AttachmentsPanel parentId={f._kpt__RCD_ID} api={CCS_ATT_API} invoiceDocNumber={f['_kat__QuickBooks_Invoice_ID(1)']} />

              <div className="cv2-meta">
                ID {f._kpt__RCD_ID} · Record {selected.recordId} · Created {f.zz__Created_On?.split(' ')[0] || '—'} by {f.zz__Created_By} · Modified {f.zz__Modified_On?.split(' ')[0] || '—'} by {f.zz__Modified_By}
              </div>
            </div>

            {dirtyCount > 0 && (
              <div className="cv2-savebar">
                <span className="cv2-savebar-count">{dirtyCount} unsaved change{dirtyCount > 1 ? 's' : ''}</span>
                {saveStatus === 'error' && <span className="cv2-savebar-err">✗ {saveErrorMsg || 'Save failed'}</span>}
                <span className="cv2-savebar-spacer" />
                <button className="cv2-savebar-discard" onClick={handleDiscard} disabled={saving}>Discard</button>
                <button className="cv2-savebar-save" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
              </div>
            )}
            {saveStatus === 'saved' && dirtyCount === 0 && <div className="cv2-toast">✓ Saved</div>}
          </>
        )}
      </main>
    </div>
  );
}
