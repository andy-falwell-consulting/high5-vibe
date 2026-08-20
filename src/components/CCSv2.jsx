import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useAllRecords } from '../hooks/useAllRecords';
import { useValueLists } from '../hooks/useValueLists';
import { MERGED_STATUSES, PIPELINE_STAGES, PIPELINE_SHORT, statusColor, mergedStatus } from '../config/ccsStatus';
import { useKanbanBoard } from '../hooks/useKanbanBoard';
import { useNaFlags } from '../hooks/useNaFlags';
import { useCcsOrgs } from '../hooks/useCcsOrgs';
import { useOpsLeads } from '../hooks/useOpsLeads';
import { RCD_LAYOUT, RCD_CACHE_VERSION, RCD_FIND_QUERY, RCD_SORT } from '../config/ccsCache';
import { getRecord, patchCachedRecord, invalidateRecord } from '../api/filemaker';
import { updateVibeRecord } from '../api/vibeRecords';
import { displayFieldsForContact } from '../api/contactDisplay';
import { getCurrentEnv } from '../config/fmpEnvironments';
import { qboLink } from '../config/qboLinks';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import AttachmentsPanel from './AttachmentsPanel';
import ContactPicker from './ContactPicker';
import { listCcsAttachments, uploadCcsAttachment, deleteCcsAttachment, ccsAttachmentUrl } from '../api/ccsAttachments';
import { downloadWorkOrder } from '../api/ccsWorkOrder';
import { contactDetails } from '../api/contactLookup';
import './CCSv2.css';
import DeleteRecordButton from './DeleteRecordButton';
import ReminderModal from './ReminderModal';

const LAYOUT = RCD_LAYOUT;
const CCS_ATT_API = { list: listCcsAttachments, upload: uploadCcsAttachment, remove: deleteCcsAttachment, freshUrl: ccsAttachmentUrl };

// ── Vocabularies (grounded in live data) ─────────────────────────
// CCS status is now the single merged 9-value set — see src/config/ccsStatus.js
// (MERGED_STATUSES / PIPELINE_STAGES / mergedStatus / statusColor).

// Project type and builders come from FileMaker's own value lists at runtime
// (see useValueLists) — these are only the first-paint fallback for when FMP
// hasn't answered yet. Don't add names here; edit the value list in FileMaker.
const VL_PROJECT_TYPE = 'Type of Project';
const VL_BUILDER = 'Lead Builder';
const PROJECT_TYPES  = ['New Construction', 'Additions', 'Repairs', 'Site Evaluation', 'Inspection', 'Consulting', 'Equipment', 'Warranty Work', 'Pole Setting'];
const BUILDER_OPTIONS = ['Krister Raasoch', 'Jamie Thibodeau', 'Kyle Myers', 'Colin Morton', 'Tom Woodbury', 'Jamie Haskell', 'Ian Doak', 'Todd Brown', 'Dylan Gordon', 'Aaron Gingrich', 'Chris Damboise'];

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

// Post Job checkboxes — literal values per direct instruction (not sourced
// from FMP's own value list, unlike Project Type/Builder). Stored return-
// delimited in the single `post_job_phase` field — the same format FMP's own
// Checkbox Set uses — even though that field is still a single popupList
// control in FileMaker today, so multiple can be checked at once.
const POST_JOB_ITEMS = [
  'Inspection Report Sent',
  'Commissioning Report Sent',
  'As Built Drawings Sent',
  'MA Paper Work Sent',
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
  { id: 'post_job', name: 'Post Job', items: POST_JOB_ITEMS.map(v => [v, v]) },
];

// Contract & financials block — mirrors the RCD_New "Additional Info" form.
// `sent` is a date/text field; `rcv` is the "Received" checkbox (optional).
//
// Estimate # and Invoice # are editable. They were read-only on the grounds
// that they are QuickBooks' identifiers, but they are not — they are this
// record's *reference* to a QuickBooks document, typed by hand, and getting one
// wrong is exactly what the "belongs to another customer" warning below exists
// to catch. Making them read-only meant seeing the warning and being unable to
// act on it. RCD_New is Vibe-owned, so these save to the overlay; api/ccs-
// estimate.js reads the overlay too, so a corrected number re-resolves live.
const FIN_ROWS = [
  { label: 'Estimate #',        sent: '_kat__QuickBooks_Estimate_ID(1)', type: 'text' },
  { label: 'Contract Sent',     sent: 'Contract_Date_Sent',           type: 'date', rcv: 'cd_Received Contract' },
  { label: 'Deposit Inv. Sent', sent: 'Report Date Sent',             type: 'date', rcv: 'cd_Received Deposit' },
  { label: 'PO #',              sent: 'po_number',                    type: 'text', rcv: 'cd_Received PO' },
  { label: 'Final Inv. Sent',   sent: 'Final Sent',                   type: 'date', rcv: 'Final_Invoice_Received' },
  { label: 'Invoice #',         sent: '_kat__QuickBooks_Invoice_ID(1)', type: 'text' },
];

// ── Helpers ──────────────────────────────────────────────────────
const EMPTY_FIELDS = {};
const isOn = v => v === 1 || v === '1';
const postJobValues = raw => String(raw || '').split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);


const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
const fmtMoneyFull = v => `$${num(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
// KPI variant: distinguishes "nothing linked" (null → em dash) from a real
// zero. A $0 balance means paid in full, which fmtMoney would hide as '—'.
const kpiMoney = v => (v == null ? '—' : `$${num(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`);

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
// QBO returns ISO dates (2026-08-07), not FileMaker's MM/DD/YYYY. Parsed as
// local parts rather than `new Date(iso)` — that would treat the value as UTC
// and can shift the date back a day for anyone west of Greenwich.
const fmtIsoShort = v => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  if (!m) return '—';
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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

// Textarea that grows to fit its content so no note is ever clipped or hidden
// behind a scrollbar (per Ian's Job Prep feedback). Height is recomputed on
// every value change, including when switching records.
function AutoGrowArea({ value, className, placeholder, onChange }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return <textarea ref={ref} className={className} rows={2} value={value || ''} placeholder={placeholder} onChange={e => onChange(e.target.value)} />;
}

// `fixed` opts out of auto-growing: the box keeps a set height and scrolls.
// Notes and Work Order both run to hundreds of lines on a real project, and a
// box that grows to fit pushed everything below them off the pane. The
// job-prep group notes stay auto-grow — they are a few words each.
function InlineText({ value, onChange, placeholder, area, big, fixed }) {
  if (area && fixed) {
    return (
      <textarea
        className={`cv2-inline cv2-inline-area cv2-inline-area-fixed${big ? ' cv2-inline-area-lg' : ''}`}
        value={value || ''} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
      />
    );
  }
  if (area) return <AutoGrowArea className={`cv2-inline cv2-inline-area${big ? ' cv2-inline-area-lg' : ''}`} value={value} placeholder={placeholder} onChange={onChange} />;
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
// onNavigateTo moves between CCS's own views (workspace ↔ board);
// onNavigateApp leaves the module entirely, for the contact links in the hero.
export default function CCSv2({ navTarget, onNavigateTo, onNavigateApp, onClearNav, onRecordSelect }) {
  const { records, total } = useAllRecords(LAYOUT, { cacheVersion: RCD_CACHE_VERSION, findQuery: RCD_FIND_QUERY, sort: RCD_SORT });
  const valueLists = useValueLists(LAYOUT, { [VL_PROJECT_TYPE]: PROJECT_TYPES, [VL_BUILDER]: BUILDER_OPTIONS });
  const board = useKanbanBoard();
  const projectTypes = valueLists[VL_PROJECT_TYPE] ?? PROJECT_TYPES;
  // Builders get a leading blank so a wrongly-assigned builder can be cleared.
  const builderOptions = useMemo(() => ['', ...(valueLists[VL_BUILDER] ?? BUILDER_OPTIONS)], [valueLists]);

  // Organization is a Vibe-only assignment held in Redis — FileMaker's own
  // organization field is a calculation and cannot be written (see
  // api/ccs-org.js). The Vibe value wins when set; otherwise FileMaker's own
  // value still shows, so the ~4,500 records that already have one are
  // untouched until somebody deliberately reassigns.
  const ccsOrgs = useCcsOrgs(getCurrentEnv().db);
  const { records: contactRecords } = useAllRecords('Contacts_New', { cacheVersion: 2 });
  const contactsById = useMemo(() => {
    const m = new Map();
    for (const c of contactRecords) m.set(String(c.fieldData?._kpt__Contact_ID), c.fieldData);
    return m;
  }, [contactRecords]);

  // Organization name → its contact id, so the organization in the hero can
  // link to its own record. Most projects have no Vibe organization assignment,
  // and FileMaker's zz__Display_Organization__ct is a calculated name carrying
  // no key — without this the link would almost never appear.
  //
  // Ambiguous names are deliberately dropped rather than resolved to whichever
  // matched first: 19 organization names are shared by more than one record, and
  // silently opening the wrong one is worse than not linking.
  const orgIdByName = useMemo(() => {
    const m = new Map();
    for (const c of contactRecords) {
      const fd = c.fieldData;
      if (String(fd?.Organization) !== '1') continue;
      const name = String(fd?.Name_Organization || '').trim().toLowerCase();
      if (!name) continue;
      m.set(name, m.has(name) ? null : String(fd._kpt__Contact_ID));
    }
    return m;
  }, [contactRecords]);
  const opsLead = useOpsLeads(getCurrentEnv().db);

  const [selected, setSelected] = useState(null);
  const [remindOpen, setRemindOpen] = useState(false);

  const naFlags = useNaFlags(selected?.recordId);
  const [navWidth, setNavWidth] = useState(300);
  const [edits, setEdits]       = useState({});
  const [saving, setSaving]     = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [saveErrorMsg, setSaveErrorMsg] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [finTab, setFinTab]     = useState('invoices');
  // Live QBO estimate(s) for the selected project — resolved from its D# via
  // /api/ccs-estimate (null = not loaded/none; array = fetched).
  const [qboEst, setQboEst]     = useState(null);
  const [qboFin, setQboFin]     = useState(null); // { estimated, invoiced, received, balanceDue } | null
  const [qboInvoices, setQboInvoices] = useState([]);
  const [qboPayments, setQboPayments] = useState([]);
  const [qboMismatch, setQboMismatch] = useState(null); // { estimates, invoices } counts
  const [woBusy, setWoBusy]     = useState(null); // 'attach' | 'download' | null
  const [woStage, setWoStage]   = useState(null);
  const [woError, setWoError]   = useState(null);
  const [contactPicker, setContactPicker] = useState(false);
  const [orgPicker, setOrgPicker] = useState(false);
  // Phone and e-mail for the project's contact. Keyed by contact id so switching
  // records cannot land a slow answer on the wrong project.
  const [contactInfo, setContactInfo] = useState(null);
  const isResizing = useRef(false);
  const selectedRef = useRef(null); // guards async estimate fetch against stale selections

  const f = useMemo(() => selected?.fieldData || EMPTY_FIELDS, [selected]);
  const val = useCallback(fk => (fk in edits ? edits[fk] : f[fk]), [edits, f]);
  const stage = useCallback((fk, v) => setEdits(p => ({ ...p, [fk]: v })), []);

  // FMP-style "Stamp": prepend "user M/D/YYYY h:mm:ss AM/PM:" to a notes field,
  // matching the Trainings module so entries read consistently across the app.
  const stampNote = useCallback((fk) => {
    let user = 'admin';
    try { user = sessionStorage.getItem('fmp_user_name') || 'admin'; } catch { /* unavailable */ }
    const now = new Date();
    const stamp = `${user} ${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.toLocaleTimeString('en-US')}:`;
    setEdits(p => {
      const cur = fk in p ? p[fk] : (f[fk] || '');
      const curText = typeof cur === 'string' ? cur.replace(/\r/g, '\n') : (cur ?? '');
      return { ...p, [fk]: `${stamp}\n${curText ? `\n${curText}` : ''}` };
    });
  }, [f]);
  const toggle = useCallback(fk => setEdits(p => ({ ...p, [fk]: isOn(fk in p ? p[fk] : f[fk]) ? 0 : 1 })), [f]);

  // Work order PDF for the builder crew — client-side render, downloaded.
  //
  // The "generate & attach" variant was removed on request: it filed a copy on
  // the record, which nobody wanted, and left two buttons doing nearly the same
  // thing. Attaching is still available generally through the attachments panel
  // if a work order ever does need to live on the record.
  async function handleGenerateWorkOrder() {
    if (!selected) return;
    setWoBusy('download');
    setWoStage('Building PDF…'); setWoError(null);
    try {
      await downloadWorkOrder(selected, setWoStage);
    } catch (e) { setWoError(e.message || 'Work order failed'); }
    finally { setWoBusy(null); setWoStage(null); }
  }

  // Phase progress (live, reflects pending edits)
  // An item marked N/A counts toward completion without requiring its own
  // checkbox — some checklist items don't apply to every project (not every
  // job needs every step), and a permanently-unchecked N/A item shouldn't
  // block a phase from ever reaching 100%.
  const phaseStats = useMemo(() => PHASES.map(p => {
    // Post Job's 4 items share one multi-value field (post_job_phase), so
    // "done" is membership in that list, not isOn() on a per-item field.
    if (p.id === 'post_job') {
      const postJobSel = postJobValues('post_job_phase' in edits ? edits['post_job_phase'] : f['post_job_phase']);
      const done = p.items.filter(([k]) => postJobSel.includes(k) || naFlags.keys.has(`${p.id}::${k}`)).length;
      return { id: p.id, name: p.name, done, all: p.items.length, pct: done / p.items.length };
    }
    const done = p.items.filter(([k]) => isOn(k in edits ? edits[k] : f[k]) || naFlags.keys.has(`${p.id}::${k}`)).length;
    return { id: p.id, name: p.name, done, all: p.items.length, pct: done / p.items.length };
  }), [edits, f, naFlags.keys]);

  const allPhasesDone = phaseStats.every(s => s.pct >= 1);

  // Type of Project is a 3-rep FMP field (maxRepeat=3) — read/write all three
  // reps, packed with no gaps, so multi-select works within that ceiling.
  const projectTypeSelected = [1, 2, 3].map(i => val(`Type of Project(${i})`)).filter(Boolean);
  const toggleProjectType = t => {
    const cur = projectTypeSelected;
    let next;
    if (cur.includes(t)) next = cur.filter(x => x !== t);
    else { if (cur.length >= 3) return; next = [...cur, t]; }
    for (let i = 0; i < 3; i++) stage(`Type of Project(${i + 1})`, next[i] || '');
  };

  const postJobSelected = postJobValues(val('post_job_phase'));
  const togglePostJob = v => {
    const next = postJobSelected.includes(v) ? postJobSelected.filter(x => x !== v) : [...postJobSelected, v];
    // Write back in canonical order, not click order, so re-reads are stable.
    stage('post_job_phase', POST_JOB_ITEMS.filter(o => next.includes(o)).join('\r'));
  };

  const merged = mergedStatus({ Status: val('Status') });
  const pipelineIdx = PIPELINE_STAGES.indexOf(merged);
  const startDays = daysUntil(val('rcd start date'));
  const eventStat = phaseStats.find(s => s.id === 'job_prep');
  const eventUrgent = startDays != null && startDays >= 0 && startDays <= 30 && eventStat && eventStat.pct < 1;
  const eventCritical = eventUrgent && startDays <= 10;

  const phaseColor = useCallback((s) => {
    if (s.pct >= 1) return '#1d9e75';
    if (s.id === 'job_prep' && eventUrgent) return eventCritical ? '#e24b4a' : '#ba7517';
    return '#d85a30';
  }, [eventUrgent, eventCritical]);


  // Financial roll-ups.
  //
  // These come from QuickBooks, resolved live from the estimate/invoice
  // references stored on the record — NOT from the FileMaker portals below.
  // Those portals (`Portal__Invoices`, `Portal__Payments`) are filtered by
  // GLOBAL fields, which are session state a Data API request never receives:
  // over the API they return hollow rows (real row ids, every field blank) and
  // no payments at all, which is why these tiles read '—' on every record.
  // They're also contact-scoped, so even working they'd show every invoice for
  // the client rather than this project's. See api/ccs-estimate.js.
  //
  // null (not 0) means "nothing linked" → the tile shows an em dash instead of
  // a confident $0.00.
  const estValue   = qboFin ? qboFin.estimated  : null;
  const received   = qboFin ? qboFin.received   : null;
  const balanceDue = qboFin ? qboFin.balanceDue : null;
  const finLive    = !!qboFin && (estValue != null || received != null || balanceDue != null);
  const mismatchCount = (qboMismatch?.estimates || 0) + (qboMismatch?.invoices || 0);

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
    // Live QBO financials (estimates + invoices, via the project's stored refs).
    // No-ops on localhost (no serverless functions); leaves both null so the
    // KPI tiles fall back to em dashes rather than showing a wrong number.
    setQboFin(null); setQboInvoices([]); setQboPayments([]); setQboMismatch(null);
    fetch(`/api/ccs-estimate?db=${encodeURIComponent(getCurrentEnv().db)}&recordId=${r.recordId}`)
      .then(res => res.ok ? res.json() : null)
      .then(j => {
        if (!j || selectedRef.current !== r.recordId) return;
        setQboEst(j.estimates || []);
        setQboFin(j.totals || null);
        setQboInvoices(j.invoices || []);
        setQboPayments(j.payments || []);
        setQboMismatch(j.mismatched || null);
      })
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

  // Reassign the CCS record's contact.
  //
  // Saved immediately rather than staged: _kft__Contact_ID drives a whole set
  // of derived values — zz__Display_Contact__ct, the billing address block and
  // the related phone/email all resolve through the contact relationship — so
  // the record is re-read afterwards instead of patched locally from the id we
  // sent. Staging it would leave the panel showing the old contact's details
  // next to the new name until Save.
  //
  // Writes to VIBE as of Phase C1. This was the last FileMaker write on this
  // layout, kept there because reassigning the contact re-derives a family of
  // FileMaker calcs that a Vibe fragment could not reproduce. It can now:
  // api/_contactDisplay.js resolves the names and the billing address block
  // from Vibe's own contact model, measured at 295/295 names and 294/295
  // organizations over 300 production projects (docs/derived-fields-audit.md).
  //
  // The related phone and email are NOT reproduced, and deliberately: they are
  // empty on all 1,000 sampled production records, so there has never been
  // anything there to carry over.
  //
  // NOTE: this sets the CONTACT only. A CCS record's Organization comes from a
  // second link that is not writable over the Data API (nothing on any
  // API-visible layout sets it, and _kmt__Contact_ID is auto-enter — it gets
  // rebuilt from _kft__Contact_ID and discards anything written to it). So
  // picking an organization-type contact here shows it as the Contact and
  // leaves Organization blank. Fixing that needs a FileMaker-side script.
  const handleContactChange = async (contactRecord) => {
    setContactPicker(false);
    const contactId = String(contactRecord?.fieldData?._kpt__Contact_ID || '').trim();
    if (!selected || !contactId) return;
    setSaving(true); setSaveStatus(null); setSaveErrorMsg(null);
    try {
      // Vibe resolves what FileMaker used to re-derive. No organization hint:
      // the whole point is that the contact is CHANGING, so the organization
      // already on the record describes the OLD one and would drag it forward.
      const { fields: display, resolved } = await displayFieldsForContact(
        LAYOUT, contactId, { clearAddress: true, fallbackRecord: contactRecord?.fieldData });

      // clearAddress above is deliberate. The block currently on the record is
      // the previous contact's, so leaving it when the new one cannot be
      // resolved would keep printing a real address for the wrong organization
      // on work orders. Blank is recoverable; wrong is not.
      const edits = { _kft__Contact_ID: contactId, ...display };
      await updateVibeRecord(LAYOUT, selected.recordId, edits);
      patchCachedRecord(RCD_LAYOUT, RCD_CACHE_VERSION, selected.recordId, edits);
      setSelected(prev => ({ ...prev, fieldData: { ...prev.fieldData, ...edits } }));

      if (resolved && !resolved.addressBlock) {
        setSaveStatus('error');
        setSaveErrorMsg(resolved.ambiguous
          ? 'Contact changed. This person belongs to more than one organization, so the billing address was cleared rather than guessed — set it on the contact.'
          : 'Contact changed. No address is on file for this contact, so the billing address was cleared.');
        return;
      }
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2500);
    } catch (e) { setSaveStatus('error'); setSaveErrorMsg(e?.message || null); }
    finally { setSaving(false); }
  };
  // Saves to VIBE, not FileMaker. CCS projects are Vibe-owned as of Phase 1c
  // (docs/vibe-owns-the-record.md) — FileMaker is a read-only source for them
  // now, and the sync only ever refreshes the FileMaker half.
  //
  // Two consequences worth knowing. It needs only a Google session, so the
  // "no FileMaker account in this environment" failure that blocked production
  // writes is gone. And the value cannot be reverted by the replica catching
  // up, which is what the whole optimistic-guard apparatus existed to prevent.
  const handleSave = async () => {
    if (!selected || !Object.keys(edits).length) return;
    setSaving(true); setSaveStatus(null); setSaveErrorMsg(null);
    try {
      await updateVibeRecord(LAYOUT, selected.recordId, edits);
      setSelected(p => ({ ...p, fieldData: { ...p.fieldData, ...edits } }));
      patchCachedRecord(RCD_LAYOUT, RCD_CACHE_VERSION, selected.recordId, edits);
      invalidateRecord(LAYOUT, selected.recordId);
      setEdits({}); setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2500);
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
  const sc = statusColor(merged);
  // Vibe's assignment wins when present; otherwise FileMaker's calculated
  // value still shows, so records that already have one are unaffected.
  // Contact details come from Vibe, not FileMaker's related fields: those are on
  // the layout but empty on all 6,436 CCS projects, which is why this card only
  // ever showed an address. See src/api/contactLookup.js.
  const contactFk = String(f?._kft__Contact_ID || '').trim();
  useEffect(() => {
    if (!contactFk) return undefined;
    let alive = true;
    contactDetails(contactFk)
      .then(d => { if (alive) setContactInfo({ id: contactFk, ...d }); })
      .catch(() => { if (alive) setContactInfo({ id: contactFk }); });
    return () => { alive = false; };
  }, [contactFk]);
  const ci = contactInfo?.id === contactFk ? contactInfo : null;

  const vibeOrgId = selected ? ccsOrgs.orgIdFor(selected.recordId) : '';
  const vibeOrgName = vibeOrgId ? (contactsById.get(String(vibeOrgId))?.Name_Organization || '') : '';
  const org = vibeOrgName || f.zz__Display_Organization__ct || '—';
  const orgIsFromVibe = !!vibeOrgName;

  // Vibe's assignment is an id already; otherwise resolve the displayed name,
  // which yields null when more than one organization answers to it.
  const orgLinkId = vibeOrgId || orgIdByName.get(String(org).trim().toLowerCase()) || '';

  // '<unassigned>' is what the FileMaker calc renders when no contact is set —
  // a label, not a name, so it must never read as one or be linked.
  const hasContact = !!f.zz__Display_Contact__ct && f.zz__Display_Contact__ct !== '<unassigned>';
  // Contacts v2 keys on _kpt__Contact_ID, which is exactly what this FK holds,
  // and resolves either a person or an organization from the one id.
  const contactId = String(f._kft__Contact_ID || '').trim();

  return (
    <div className="cv2-root">
      <nav className="cv2-nav" style={{ width: navWidth }}>
        <div className="cv2-nav-head">
          <div className="cv2-nav-title"><div><div className="cv2-nav-name">CCS</div><div className="cv2-nav-count">{total ? `${records.length} / ${total}` : records.length}</div></div></div>
          <ListToolbar c={list} unit="projects" />
        </div>
        <div className="cv2-list">
          <ListBody c={list} activeId={selected?.recordId} renderItem={r => {
            const rf = r.fieldData; const c = statusColor(mergedStatus(rf));
            const d = daysUntil(rf['rcd start date']);
            return (
              <div key={r.recordId} className={`cv2-list-item${selected?.recordId === r.recordId ? ' active' : ''}`}
                onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId, r.fieldData?.zz__Display_Organization__ct); }} /* onMouseEnter={() => prefetchRecord(LAYOUT, r.recordId)} */>
                <span className="cv2-list-dot" style={{ background: c }} />
                <div className="cv2-list-body">
                  <div className="cv2-list-org">{rf.zz__Display_Organization__ct || '—'}</div>
                  <div className="cv2-list-sub">
                    <span>{rf.zz__Display_Contact__ct || mergedStatus(rf) || ''}</span>
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
                {(() => {
                  const onBoard = board.ids.has(String(selected.recordId));
                  return (
                    <button className={`cv2-ghost-btn${onBoard ? ' cv2-on-board' : ''}`}
                      onClick={() => board.toggle(selected.recordId, !onBoard)}
                      title={onBoard ? 'Remove this project from the Kanban board' : 'Add this project to the Kanban board'}>
                      {onBoard ? '⊞ On board ✓' : '⊞ Add to board'}
                    </button>
                  );
                })()}
                <button className="cv2-ghost-btn" onClick={() => onNavigateTo?.('ccs-kanban', selected.recordId)}>Board →</button>
                <span className="cv2-crumb-id">#{f._kpt__RCD_ID || selected.recordId}</span>
                <button className="cv2-ghost-btn" onClick={() => setRemindOpen(true)}>⏰ Remind</button>
                <DeleteRecordButton
                  layout={LAYOUT} cacheVersion={RCD_CACHE_VERSION}
                  recordId={selected.recordId}
                  name={org}
                  onDeleted={() => setSelected(null)}
                />
              </div>

              {/* HERO */}
              <div className="cv2-hero">
                <div className="cv2-hero-top">
                  <div className="cv2-hero-id">
                    <div className="cv2-hero-type">{projectTypeSelected.join(' · ') || 'Project'}</div>
                    <h1 className="cv2-hero-org">
                      {/* Plain text when no id can be established — a link that
                          opens the wrong organization is worse than none. */}
                      {orgLinkId
                        ? <button type="button" className="cv2-hero-link" title="Open this organization"
                            onClick={() => onNavigateApp?.('contacts-v2', orgLinkId)}>{org}</button>
                        : org}
                      <button className="cv2-pick-btn" onClick={() => setOrgPicker(true)} title="Assign this project to an organization">
                        {orgIsFromVibe || f.zz__Display_Organization__ct ? 'Change' : 'Assign'}
                      </button>
                    </h1>
                    <div className="cv2-hero-contact">
                      <span className="cv2-ic">◉</span>
                      {hasContact
                        ? (contactId
                            ? <button type="button" className="cv2-hero-link" title="Open this contact"
                                onClick={() => onNavigateApp?.('contacts-v2', String(contactId))}>{f.zz__Display_Contact__ct}</button>
                            : f.zz__Display_Contact__ct)
                        : <span className="cv2-hero-none">No contact</span>}
                      <button className="cv2-pick-btn" onClick={() => setContactPicker(true)} title="Choose the contact for this project">
                        {hasContact ? 'Change' : 'Assign'}
                      </button>
                    </div>
                  </div>
                  <select className="cv2-status" style={{ color: sc, borderColor: sc + '55', background: sc + '14' }}
                    value={merged} onChange={e => stage('Status', e.target.value)}>
                    <option value="">— status —</option>
                    {MERGED_STATUSES.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>

                {/* pipeline */}
                <div className="cv2-pipe-wrap">
                  <div className="cv2-pipe-head">
                    <span className="cv2-pipe-label">Pipeline</span>
                    <span className="cv2-pipe-stage">
                      {pipelineIdx >= 0
                        ? <><b style={{ color: '#993c1d' }}>Stage {pipelineIdx + 1} of {PIPELINE_STAGES.length}</b> · {PIPELINE_SHORT[pipelineIdx]}</>
                        : <b style={{ color: statusColor(merged) }}>{merged || '—'}</b>}
                    </span>
                  </div>
                  <div className="cv2-pipe">
                    {PIPELINE_STAGES.map((s, i) => (
                      <div key={s} className="cv2-pipe-seg">
                        {i > 0 && <span className="cv2-pipe-line" style={{ background: i <= pipelineIdx ? '#d85a30' : 'var(--cv2-line)' }} />}
                        <button className={`cv2-pipe-dot${i < pipelineIdx ? ' done' : i === pipelineIdx ? ' cur' : ''}`}
                          title={PIPELINE_SHORT[i]} aria-label={PIPELINE_SHORT[i]}
                          onClick={() => stage('Status', s)} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>


              {/* KPIs */}
              <div className="cv2-kpis">
                <div className="cv2-kpi">
                  <div className="cv2-kpi-label">Estimated value</div>
                  <div className="cv2-kpi-num">{kpiMoney(estValue)}</div>
                  {finLive && <div className="cv2-kpi-sub">live from QuickBooks</div>}
                </div>
                <div className="cv2-kpi">
                  <div className="cv2-kpi-label">Received</div>
                  <div className="cv2-kpi-num" style={{ color: received ? '#0f6e56' : 'inherit' }}>{kpiMoney(received)}</div>
                  {finLive && <div className="cv2-kpi-sub">live from QuickBooks</div>}
                </div>
                <div className="cv2-kpi">
                  <div className="cv2-kpi-label">Balance due</div>
                  <div className="cv2-kpi-num" style={{ color: balanceDue ? '#854f0b' : 'inherit' }}>{kpiMoney(balanceDue)}</div>
                  {finLive && balanceDue === 0 && <div className="cv2-kpi-sub">paid in full</div>}
                  {finLive && balanceDue !== 0 && <div className="cv2-kpi-sub">live from QuickBooks</div>}
                </div>
                <div className="cv2-kpi">
                  <div className="cv2-kpi-label">Event date</div>
                  <div className="cv2-kpi-num">{fmtDate(val('rcd start date'))}</div>
                  {startDays != null && <div className={`cv2-kpi-sub${eventUrgent ? ' urg' : ''}`}>{startDays < 0 ? `${-startDays}d ago` : startDays === 0 ? 'today' : `in ${startDays}d`}</div>}
                </div>
              </div>

              {/* A stored reference resolving to another client's record is common
                  enough (roughly 3 in 4 estimate links) that it needs saying out
                  loud — those records are excluded from the totals above. */}
              {mismatchCount > 0 && (
                <div className="cv2-fin-mismatch">
                  ⚠ {mismatchCount === 1
                    ? 'A QuickBooks record linked to this project belongs to a different customer, so it is'
                    : `${mismatchCount} QuickBooks records linked to this project belong to a different customer, so they are`} excluded
                  from the figures above. Check the estimate and invoice numbers on this record.
                </div>
              )}

                {/* BODY: contract & financials → details → phases → contact/team */}
                <div className="cv2-body">
                {/* Contact beside Contract & Financials — the contact is who you
                    call about the money, so the two belong on one line. */}
                <div className="cv2-cols cv2-cols-third">
                <div className="cv2-stack">
                {/* contact */}
                  <div className="cv2-card">
                    <div className="cv2-card-head">
                      <span>Contact</span>
                      <button className="cv2-contact-change" onClick={() => setContactPicker(true)} disabled={saving}>
                        {f.zz__Display_Contact__ct && f.zz__Display_Contact__ct !== '<unassigned>' ? 'Change' : 'Assign'}
                      </button>
                    </div>
                    {/* Details come from Vibe (contactLookup). FileMaker's own
                        related fields are kept only as a fallback — they are
                        empty on all 6,436 CCS projects, which is why this card
                        used to show nothing but an address. */}
                    <div className="cv2-contact">
                      {f.Address_Block_Billing && (
                        <div className="cv2-contact-row"><span className="cv2-ic">⌖</span>
                          <span style={{ whiteSpace: 'pre-wrap' }}>{f.Address_Block_Billing.replace(/\r/g, '\n')}</span>
                        </div>
                      )}
                      {(() => {
                        const email = ci?.email || '';
                        const work = ci?.workPhone || '';
                        const cell = ci?.cellPhone || '';
                        const workHref = ci?.workHref || (work ? `tel:${work.replace(/[^\d+]/g, '')}` : '');
                        const cellHref = ci?.cellHref || (cell ? `tel:${cell.replace(/[^\d+]/g, '')}` : '');
                        if (!email && !work && !cell) {
                          return contactFk
                            ? <div className="cv2-contact-row cv2-contact-none">{ci ? 'No phone or e-mail on this contact.' : 'Loading…'}</div>
                            : <div className="cv2-contact-row cv2-contact-none">No contact assigned.</div>;
                        }
                        return (
                          <>
                            {email && <div className="cv2-contact-row"><span className="cv2-ic">✉</span><a href={`mailto:${email}`}>{email}</a></div>}
                            {work && <div className="cv2-contact-row"><span className="cv2-ic">✆</span><a href={workHref}>{work}</a><span className="cv2-contact-tag">work</span></div>}
                            {cell && <div className="cv2-contact-row"><span className="cv2-ic">▢</span><a href={cellHref}>{cell}</a><span className="cv2-contact-tag">mobile</span></div>}
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  {/* team */}
                  <div className="cv2-card">
                    <div className="cv2-card-head"><span>Team</span></div>
                      <div className="cv2-team">
                        {/* Operations Lead is a Vibe-only field held in Redis, not
                            FileMaker — so it saves immediately on change rather
                            than going through stage()/the record's Save button. */}
                        <div className="cv2-team-row">
                          <Avatar name={opsLead.leadFor(selected.recordId)} lead />
                          <div className="cv2-team-pick">
                            <label>Operations lead</label>
                            <InlineSelect
                              value={opsLead.leadFor(selected.recordId)}
                              options={['', ...opsLead.roster]}
                              onChange={v => opsLead.assign(selected.recordId, v)}
                            />
                          </div>
                        </div>
                        {/* Every filled builder slot, editable in place, plus
                            exactly one open slot at the end — same "add and
                            expand" treatment as Trainings' Trainers card:
                            filling it reveals the next blank one on the next
                            render, instead of always showing all 4 rows. */}
                        {(() => {
                          const allKeys = [['Lead Builder', 'Lead builder'], ...['Builder1', 'Builder2', 'Builder3'].map((k, i) => [k, `Builder ${i + 1}`])];
                          const filled = allKeys.filter(([k]) => String(val(k) || '').trim());
                          const nextEmpty = allKeys.find(([k]) => !String(val(k) || '').trim());
                          const rows = nextEmpty ? [...filled, nextEmpty] : filled;
                          return rows.map(([k, label]) => (
                            <div className="cv2-team-row" key={k}>
                              <Avatar name={val(k)} lead={k === 'Lead Builder'} />
                              <div className="cv2-team-pick"><label>{label}</label><InlineSelect value={val(k)} options={builderOptions} onChange={v => stage(k, v)} /></div>
                            </div>
                          ));
                        })()}
                      </div>
                    </div>
                </div>

                <div className="cv2-card">
                  <div className="cv2-card-head"><span>Contract &amp; Financials</span></div>
                  <div className="cv2-fin-grid">
                    {FIN_ROWS.map(row => (
                      <div className="cv2-fin-line" key={row.label}>
                        <span className="cv2-fin-label">{row.label}</span>
                        <div className="cv2-fin-input">
                          {row.type === 'date'
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
                        // A missing estimate has no QBO id, so it stays a plain
                        // row — there's nothing to open.
                        e.missing ? (
                          <div className="cv2-qboest-row" key={e.docNumber}>
                            <span className="cv2-qboest-doc">{e.docNumber}</span>
                            <span className="cv2-qboest-missing">not found in QBO</span>
                          </div>
                        ) : (
                          <a className={`cv2-qboest-row cv2-fin-link${e.customerMatch === false ? ' cv2-fin-suspect' : ''}`} key={e.docNumber}
                            href={qboLink('Estimate', e.qboId)} target="_blank" rel="noreferrer"
                            title={e.customerMatch === false
                              ? `This QuickBooks estimate belongs to "${e.customer}", not this project — check the estimate number on the record`
                              : 'Open this estimate in QuickBooks Online'}>
                            <span className="cv2-qboest-doc">{e.docNumber}</span>
                            {e.customerMatch === false
                              ? <span className="cv2-fin-warn">⚠ {e.customer}</span>
                              : <span className={`cv2-qboest-status ${String(e.status || '').toLowerCase()}`}>{e.status || '—'}</span>}
                            <span className="cv2-qboest-total">{fmtMoneyFull(e.total)}<span className="cv2-fin-ext">↗</span></span>
                          </a>
                        )
                      ))}
                    </div>
                  )}
                  {/* Invoices / Payments (folded in from the old Financials card;
                      estimates are covered by the live QBO block above). */}
                  <div className="cv2-fin-embed">
                    <div className="cv2-fin-tabs">
                      {[['invoices', 'Invoices', qboInvoices.length], ['payments', 'Payments', qboPayments.length]].map(([id, lbl, n]) => (
                        <button key={id} className={`cv2-fin-tab${finTab === id ? ' active' : ''}`} onClick={() => setFinTab(id)}>{lbl}<span>{n}</span></button>
                      ))}
                    </div>
                    <div className="cv2-fin-list">
                      {finTab === 'invoices' && (qboInvoices.length ? qboInvoices.map(r => (
                        <a className={`cv2-fin-row cv2-fin-link${r.customerMatch === false ? ' cv2-fin-suspect' : ''}`} key={r.qboId}
                          href={qboLink('Invoice', r.qboId)} target="_blank" rel="noreferrer"
                          title={r.customerMatch === false
                            ? `This QuickBooks invoice belongs to "${r.customer}", not this project — check the invoice number on the record`
                            : 'Open this invoice in QuickBooks Online'}>
                          <span className="cv2-fin-main">
                            #{r.docNumber || r.qboId} · {fmtIsoShort(r.date)}
                            {r.customerMatch === false
                              ? <span className="cv2-fin-warn">⚠ {r.customer}</span>
                              : r.balance > 0
                                ? <span className="cv2-fin-tag due">{fmtMoneyFull(r.balance)} due</span>
                                : <span className="cv2-fin-tag paid">paid</span>}
                          </span>
                          <span className="cv2-fin-amt">{fmtMoneyFull(r.total)}<span className="cv2-fin-ext">↗</span></span>
                        </a>
                      )) : <div className="cv2-fin-empty">{qboFin ? 'No invoices in QuickBooks' : 'No invoice linked to this project'}</div>)}
                      {finTab === 'payments' && (qboPayments.length ? qboPayments.map(r => (
                        <a className="cv2-fin-row cv2-fin-link" key={r.qboId}
                          href={qboLink('Payment', r.qboId)} target="_blank" rel="noreferrer"
                          title="Open this payment in QuickBooks Online">
                          <span className="cv2-fin-main">
                            {fmtIsoShort(r.date)} · {r.method || 'Payment'}{r.reference ? ` · ${r.reference}` : ''}
                            {/* A payment can settle several invoices at once; show the
                                whole cheque only when it exceeded this project's share. */}
                            {r.paymentTotal > r.amount && <span className="cv2-fin-tag">of {fmtMoneyFull(r.paymentTotal)}</span>}
                          </span>
                          <span className="cv2-fin-amt">{fmtMoneyFull(r.amount)}<span className="cv2-fin-ext">↗</span></span>
                        </a>
                      )) : <div className="cv2-fin-empty">{qboInvoices.length ? 'No payments received yet' : 'No invoice linked to this project'}</div>)}
                    </div>
                    {(qboInvoices.length > 0 || qboPayments.length > 0) && (
                      <div className="cv2-fin-src">live from QuickBooks</div>
                    )}
                  </div>
                </div>
                </div>

                {/* details */}
                <div className="cv2-card">
                  <div className="cv2-card-head"><span>Details</span></div>
                  <div className="cv2-detail-grid">
                    <label>Project type <span className="cv2-type-max">(up to 3)</span></label>
                    <div className="cv2-type-chips">
                      {projectTypes.map(t => {
                        const on = projectTypeSelected.includes(t);
                        const disabled = !on && projectTypeSelected.length >= 3;
                        return (
                          <button key={t} type="button" disabled={disabled}
                            className={`cv2-type-chip${on ? ' on' : ''}`}
                            onClick={() => toggleProjectType(t)}>{t}</button>
                        );
                      })}
                    </div>
                    <label>Start date</label><InlineDate value={val('rcd start date')} onChange={v => stage('rcd start date', v)} />
                    <label>End date</label><InlineDate value={val('rcd end date')} onChange={v => stage('rcd end date', v)} />
                    {/* Calculated — never editable, here or on any other layout. */}
                    <label>Distance to HQ</label><span className="cv2-static">{val('Distance to High5') || '—'}</span>
                    <label>Drive time</label><span className="cv2-static">{val('Drive Time') || '—'}</span>
                  </div>
                </div>

                {/* Work Order Notes and Notes side by side. Both are long free
                    text read while doing the same thing, so stacking them meant
                    scrolling past one to reach the other. */}
                <div className="cv2-cols cv2-cols-even cv2-notes-row">
                  <div className="cv2-card">
                    <div className="cv2-card-head"><span>Work Order Notes</span></div>
                    <div className="cv2-field-block cv2-field-block--card">
                      <InlineText value={val('Work Order')} onChange={v => stage('Work Order', v)} placeholder="Add a work order…" area big fixed />
                      <div className="cv2-wo-actions">
                        <button type="button" className="cv2-wo-btn" disabled={!!woBusy} onClick={handleGenerateWorkOrder}>
                          {woBusy ? (woStage || 'Working…') : '⤓ Download work order'}
                        </button>
                      </div>
                      {woError && <p className="cv2-wo-error">{woError}</p>}
                    </div>
                  </div>

                  <div className="cv2-card">
                    <div className="cv2-card-head">
                      <span>Notes</span>
                      <button type="button" className="cv2-stamp-btn" onClick={() => stampNote('Notes')}>⏱ Stamp</button>
                    </div>
                    <div className="cv2-field-block cv2-field-block--card">
                      <InlineText value={val('Notes')} onChange={v => stage('Notes', v)} placeholder="Add notes…" area big fixed />
                    </div>
                  </div>
                </div>

                {/* project phases — full width */}
                <div className="cv2-card cv2-phases-card">
                  <div className="cv2-card-head"><span>Project phases</span><span className="cv2-card-hint">click to expand · check to update</span></div>
                  <div className="cv2-phases">
                    {phaseStats.map(s => {
                      const phase = PHASES.find(p => p.id === s.id);
                      const col = phaseColor(s); const open = !!expanded[s.id]; const full = s.pct >= 1;
                      const nextStageName = pipelineIdx >= 0 && pipelineIdx < PIPELINE_STAGES.length - 1 ? PIPELINE_SHORT[pipelineIdx + 1] : null;
                      // One checklist row: the item's own toggle + a small N/A
                      // toggle beside it. N/A'd items count toward the phase's
                      // completion (see phaseStats) without needing a real check —
                      // not every item applies to every project.
                      const renderCheckItem = (k, label, on, onToggle) => {
                        const naKey = `${s.id}::${k}`;
                        const isNA = naFlags.keys.has(naKey);
                        return (
                          <div className="cv2-check-row" key={k}>
                            <button className={`cv2-check${on ? ' on' : ''}${isNA ? ' na' : ''}`} onClick={onToggle}>
                              <span className="cv2-check-box" style={on && !isNA ? { background: col, borderColor: col } : undefined}>{isNA ? '—' : (on ? '✓' : '')}</span>
                              <span className="cv2-check-label">{label}</span>
                            </button>
                            <button className={`cv2-na-toggle${isNA ? ' on' : ''}`} title="Doesn't apply to this project"
                              onClick={() => naFlags.toggle(naKey, !isNA)}>N/A</button>
                          </div>
                        );
                      };
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
                                        {g.items.map(([k, label]) => renderCheckItem(k, label, isOn(val(k)), () => toggle(k)))}
                                      </div>
                                      <InlineText value={val(g.notes)} onChange={v => stage(g.notes, v)} placeholder="Notes…" area />
                                    </div>
                                  ))}
                                </div>
                              ) : s.id === 'post_job' ? (
                                <div className="cv2-checks">
                                  {POST_JOB_ITEMS.map(v => renderCheckItem(v, v, postJobSelected.includes(v), () => togglePostJob(v)))}
                                </div>
                              ) : (
                                <div className="cv2-checks">
                                  {phase.items.map(([k, label]) => renderCheckItem(k, label, isOn(val(k)), () => toggle(k)))}
                                </div>
                              )}
                              {full && nextStageName && pipelineIdx < PIPELINE_STAGES.length - 1 && (
                                <div className="cv2-advance">
                                  <span>✓ Phase complete</span>
                                  <button onClick={() => stage('Status', PIPELINE_STAGES[pipelineIdx + 1])}>Advance to {nextStageName} →</button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
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

      {remindOpen && selected && (
        <ReminderModal
          initial={{
            // 'projects' is CCS's module id and is already a registered record
            // source (RCD_New), so a reminder made here deep-links back to the
            // project rather than dead-ending.
            recordType: 'projects',
            recordId: String(selected.recordId),
            recordLabel: org || 'project',
            title: `Follow up on ${org || 'project'}`,
          }}
          onClose={() => setRemindOpen(false)}
          onSaved={() => setRemindOpen(false)} />
      )}

      {orgPicker && (
        <ContactPicker
          title="Assign this project to an organization"
          filter={c => String(c.Organization) === '1'}
          filterLabel="organizations"
          onSelect={r => { ccsOrgs.assign(selected.recordId, r?.fieldData?._kpt__Contact_ID); setOrgPicker(false); }}
          onClose={() => setOrgPicker(false)}
        />
      )}

      {/* Scoped to the chosen organization's people — the whole point of the
          two-step pick. Contacts carry no organization id, only the calculated
          NAME, so the roster is joined on that. The picker's "search all"
          escape hatch matters here: a brand-new organization has no staff yet
          and the list would otherwise be a dead end. */}
      {contactPicker && (
        <ContactPicker
          title={org && org !== '—' ? `Contact at ${org}` : 'Assign a contact to this project'}
          filter={org && org !== '—'
            ? (c => String(c.Organization) === '0' && c.zz__Display_Organization__ct === org)
            : undefined}
          filterLabel={org && org !== '—' ? `at ${org}` : undefined}
          onSelect={handleContactChange}
          onClose={() => setContactPicker(false)}
        />
      )}
    </div>
  );
}
