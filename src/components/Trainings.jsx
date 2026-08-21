import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { BRAND, UI } from '../config/brandColors'
import { getRecord, invalidateRecord, patchCachedRecord } from '../api/filemaker';
import { useAllRecords } from '../hooks/useAllRecords';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import RecordSaveBar from './RecordSaveBar';
import AttachmentsPanel from './AttachmentsPanel';
import { trainingAttachments } from '../api/trainingAttachments';
import { downloadWorkOrder } from '../api/trainingWorkOrder';
import { LayoutCard, StatTiles, Pipeline, FinancialRows, NotesPair, ThirdsRow, ContactDetails } from './RecordLayout';
import { PIPELINE_STAGES, PIPELINE_SHORT, statusOptionsFor, stageIndex, statusColor as trnStatusColor } from '../config/trainingStatus';
import { contactDetails } from '../api/contactLookup';
import { updateVibeRecord } from '../api/vibeRecords';
import { displayFieldsForContact } from '../api/contactDisplay';
import { useCcsOrgs } from '../hooks/useCcsOrgs';
import { useValueLists } from '../hooks/useValueLists';
import { useOpsLeads } from '../hooks/useOpsLeads';
import { useTrainingsKanbanBoard } from '../hooks/useTrainingsKanbanBoard';
import ContactPicker from './ContactPicker';
import { getCurrentEnv } from '../config/fmpEnvironments';
import { qboLink } from '../config/qboLinks';
import './Trainings.css';
import DeleteRecordButton from './DeleteRecordButton'
import ReminderModal from './ReminderModal'
import { TRAININGS_LAYOUT as LAYOUT, TRAININGS_CACHE_VERSION as CACHE_VERSION, TRAINER_SLOTS } from '../config/trainingsCache';
import RecordFooter from './RecordFooter';

const STATUS_COLOR = {
  'Final Invoiced': UI.success,
  'Ready to Bill':  BRAND.gold,
  'No Go':          UI.neutral,
  default:          UI.neutral,
};

// Cost grids mirroring the FMP "Training Costs/Expenses" tab: Program Costs and
// Trainer Costs, each with Estimated + Actual columns (editable). `act: null`
// means the layout has no actual-side field for that line.
const PROGRAM_COSTS = [
  { label: 'Trainer fee',           est: 'Prog Staffing Cost',              act: 'Act Prog Staffing' },
  { label: 'Planning time',         est: 'Prog Planning Time',              act: 'Act Prog Planning' },
  { label: 'Travel time fee',       est: 'Prog Travel Days',                act: 'Act Prog Travel Days' },
  { label: 'Training materials',    est: 'Prog Training Materials',         act: 'Act Prog Materials' },
  { label: 'Catalog product / equipment', est: 'Prog Equipment',            act: 'Act Prog Equipment' },
  { label: 'Shipping fee',          est: 'Prog Shipping',                   act: 'Act Prog Shipping' },
  { label: 'NY state surcharge',    est: 'ny_state_surcharge',              act: 'act_ny_state_surchage' },
  { label: 'Client food & lodging', est: 'Prog Participant Food Lodging',   act: 'Act Prog Client Food Lodging' },
  { label: 'Client lodging — dorms',  est: 'Prog Participant Lodging Dorms',  act: 'Act Prog Client Lodging Dorms' },
  { label: 'Client lodging — cabins', est: 'Prog Participant Lodging Cabins', act: 'Act Prog Client Lodging Cabins' },
  { label: 'Client lodging — yurt',   est: 'Prog Participant Lodging Yurt',   act: 'Act Prog Client Lodging Yurt' },
  { label: 'Rental — tent',         est: 'Prog Rental Fee Tent',            act: null },
  { label: 'Rental — tables/chairs', est: 'Prog Rental Fee Tables Chairs',  act: null },
  { label: 'Rental — porta-potty',  est: 'Prog Rental Fee PortaPotty',      act: null },
  { label: 'Rental — other',        est: 'Prog Rental Fee Other',           act: null },
];
const TRAINER_COSTS = [
  { label: 'Food',        est: 'Prog Food',        act: 'Act Prog Food' },
  { label: 'Lodging',     est: 'Prog Lodging',     act: 'Act Prog Lodging' },
  { label: '# of miles',  est: 'No of Miles',      act: null },
  { label: 'Mileage',     est: 'Prog Mileage',     act: null },
  { label: 'Airfare',     est: 'Prog Airfare',     act: 'Act Prog Airfare' },
  { label: 'Car rental',  est: 'Prog Car Rental',  act: 'Act Prog Car Rental' },
  { label: 'Misc travel', est: 'Prog Misc Travel', act: 'Act Prog Misc Travel' },
];

const LOGISTICS_FIELDS = [
  { key: 'Logistics: Participant List',          label: 'Participant list' },
  { key: 'Logistics: Certificates',              label: 'Certificates' },
  { key: 'Logistics: Trainer Tracker',           label: 'Trainer tracker' },
  { key: 'Logistics: Meals',                     label: 'Meals' },
  { key: 'Logistics: Lodging',                   label: 'Lodging' },
  { key: 'Logistics: Materials Manuals etc',     label: 'Materials / manuals' },
  { key: 'Logistics: Release Forms',             label: 'Release forms' },
  { key: 'Logistics: Other tents cabins facilities', label: 'Other (tents/cabins/facilities)' },
];

// Dropdown options mirrored from the trainings_New layout's FileMaker value lists.
const AUDIENCE_OPTIONS = ['Corporate', 'Adult', 'College', 'Youth Public', 'Youth Private', 'EOL'];
const PROGRAM_TYPES = ['Adventure Basics: Level 1 Training', 'Adventure Facilitaton Training', 'Beyond Basics: Level 2 Training', 'CATSEL - custom', 'Certification Exam - custom', 'CIT Training', 'Climbing Wall/Tower & Belay Skills Training', 'Corporate Program', 'Curriculum Writing', 'Consultation', 'Dialogue', 'EOL/SEL', 'EOL Sports', 'Game Bag Training', 'Gathering Again (Games & Lows)', 'Gathering Again 2 (High Elements)', 'High Elements and Belay Skills Training', 'Leadership Development', 'Low Elements Course Training', 'Low Traverse Wall Training', 'Managing an Adventure Program', 'Mastermind/Adventure Circuit', 'New Student Orientation ', 'Portable Adventure', 'Program Review', 'Team-building', 'Team Development', 'Technical Skills Refresher', 'Technical Skills Training', 'Technical Skills Verification', 'Therapeutic', 'Virtual Team-building', 'Virtual Team Development', 'Virtual Training', 'Keynote', 'Playnote', 'Other'];
// Fallback for first paint / if FileMaker's value list is unreachable — see
// useValueLists below, which reads the live "Trainers" value list instead.
const TRAINER_OPTIONS = ['Phil Brown', 'Lisa Hunt', 'Kyra Richardson', 'Elyse Norton', 'Cam Miller', 'Chris Damboise', 'Rich Keegan', 'Joshua Fisher', 'Alison Jackson-Frasier', 'Lisa Howard', 'Sadie Graham', 'Andrew  Wood', 'Olivia Howry', 'Hanne Bailey', 'Sam Copland', 'Stefanie Frazee', 'Jeff Frigon', 'Chris Ortiz', 'Ryan McCormick', 'Anne Louise Wagner', 'Chris Sanchez', 'Ky Schroeher', 'Jim Grout', 'Jiin Cruz', 'Sarah Morse', 'Phoebe Connolly', 'Ana Devlin Gauthier', 'Julia Stifler', 'Becky Proulx', 'Ron Vercellone', 'Amanda Klein', 'Mark Flynn', 'Beth Sayers', 'Nate Folan', 'Hutch Hutchinson', 'Stephanie Globus-Hoenig', 'Emily Kehoe', 'Tim Abraham', 'Ian Doak', 'Todd Brown', 'Jamie Thibodeau', 'Geoff Ward', "Constance O'Brien", 'Morgan Wiseman', 'Other'];
const num = v => Number(v || 0);
const money = v => '$' + num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// FileMaker stores line breaks as \r, which pre-wrap won't break on.
const fmText = v => (typeof v === 'string' ? v.replace(/\r/g, '\n') : v);
// Same as `money` above — named to match CCS's own helper (CCSv2.jsx) since
// this is used in the mirrored Invoices/Payments block, where `money` inside
// the component is shadowed by a no-cents variant for the stat tiles.
const fmtMoneyFull = v => `$${num(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
// QBO returns ISO dates (2026-08-07), not FileMaker's MM/DD/YYYY. Parsed as
// local parts rather than `new Date(iso)` — that would treat the value as UTC
// and can shift the date back a day for anyone west of Greenwich.
const fmtIsoShort = v => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  if (!m) return '—';
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const parseFmDate = v => {
  if (!v) return 0;
  const [date, time = '00:00:00'] = String(v).split(' ');
  const [m, d, y] = date.split('/');
  return new Date(`${y}-${m}-${d}T${time}`).getTime();
};

// Current value for a field, preferring an unsaved edit.
const val = (f, edits, fk) => (fk in edits ? edits[fk] : f?.[fk]);
const isDirty = (f, edits, fk) => fk in edits && edits[fk] !== (f?.[fk] ?? '');

function TextField({ label, fieldKey, f, edits, onChange, editing, editable, mono, wide }) {
  const v = val(f, edits, fieldKey);
  const dirty = isDirty(f, edits, fieldKey);
  return (
    <div className={`trn-field${wide ? ' wide' : ''}`}>
      <label>{label}{dirty && <span className="trn-dirty-dot" />}</label>
      {editing && editable ? (
        <input className="trn-input" value={v || ''} onChange={e => onChange(fieldKey, e.target.value)} />
      ) : (
        <span className={`trn-value${mono ? ' mono' : ''}`}>{fmText(v) || '—'}</span>
      )}
    </div>
  );
}

// FileMaker Boolean checkbox (1 / empty).
function CheckField({ label, fieldKey, f, edits, onChange }) {
  const v = val(f, edits, fieldKey);
  const dirty = isDirty(f, edits, fieldKey);
  const on = v === 1 || v === '1';
  return (
    <div className="trn-field">
      <label>{label}{dirty && <span className="trn-dirty-dot" />}</label>
      <input type="checkbox" className="trn-check" checked={on} onChange={e => onChange(fieldKey, e.target.checked ? 1 : '')} />
    </div>
  );
}

// Multi-line text (Notes, Description, Logistics notes). `onStamp` renders a
// Stamp button that prepends "user date time:" — mirroring FMP's Stamp.
function TextAreaField({ label, fieldKey, f, edits, onChange, onStamp, rows = 5 }) {
  const v = val(f, edits, fieldKey);
  const dirty = isDirty(f, edits, fieldKey);
  return (
    <div className="trn-field wide">
      <label>{label}{dirty && <span className="trn-dirty-dot" />}{onStamp && <button className="trn-stamp-btn" onClick={() => onStamp(fieldKey)}>⏱ Stamp</button>}</label>
      <textarea className="trn-input trn-textarea" rows={rows} value={fmText(v) || ''} onChange={e => onChange(fieldKey, e.target.value)} />
    </div>
  );
}

// Editable Estimated/Actual cost grid (one FMP costs group).
function CostTable({ title, lines, f, edits, onChange, totals }) {
  const cell = (fk) => {
    if (!fk) return <td className="num trn-cost-na">—</td>;
    const v = val(f, edits, fk);
    const dirty = isDirty(f, edits, fk);
    return (
      <td className="num">
        <input className={`trn-cost-input${dirty ? ' dirty' : ''}`} inputMode="decimal" value={v ?? ''} placeholder="—"
          onChange={e => onChange(fk, e.target.value)} />
      </td>
    );
  };
  return (
    <div className="trn-cost-card">
      <div className="trn-cost-title">{title}</div>
      <table className="trn-table trn-cost-table">
        <thead><tr><th /><th className="num">Estimated</th><th className="num">Actual</th></tr></thead>
        <tbody>
          {lines.map(l => (
            <tr key={l.label}><td>{l.label}</td>{cell(l.est)}{cell(l.act)}</tr>
          ))}
          {totals && (
            <tr className="total"><td>Total</td>
              <td className="num">{money(f[totals.est])}</td>
              <td className="num">{money(f[totals.act])}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, icon, children }) {
  return (
    <div className="trn-section">
      <div className="trn-section-header">
        <span className="trn-section-icon">{icon}</span>
        <h3>{title}</h3>
      </div>
      {children}
    </div>
  );
}

// Bare inputs for the layout blocks. The tabs below keep using TextField,
// which carries its own label and dirty dot; these take a value and a
// setter because the layout components supply the label themselves.
function InlineValue({ value, onChange, placeholder = '—' }) {
  return <input className="trn-inline" value={value ?? ''} placeholder={placeholder} onChange={e => onChange(e.target.value)} />;
}

function SelectValue({ value, options, onChange }) {
  const opts = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <select className="trn-inline" value={value ?? ''} onChange={e => onChange(e.target.value)}>
      <option value=""></option>
      {opts.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

// Same cv2-inline-select class CCS's own Team card uses — this sits inside
// the shared cv2-team-pick markup, so it needs CCS's styling, not trn-inline's.
// Mirrors CCSv2's Avatar and its `initials`, deliberately as a copy: both
// modules already keep their own small presentational helpers, and hoisting one
// into a shared file would touch more than this change needs to.
const initialsOf = n => String(n || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();

function Avatar({ name, lead }) {
  return <span className={`cv2-avatar${lead ? ' lead' : ''}`} title={name}>{initialsOf(name)}</span>;
}

function InlineSelect({ value, options, onChange }) {
  const opts = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <select className="cv2-inline cv2-inline-select" value={value || ''} onChange={e => onChange(e.target.value)}>
      <option value="">—</option>
      {opts.filter(Boolean).map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

// Native date input, same as CCS's own InlineDate (CCSv2.jsx) — FileMaker
// stores M/D/YYYY, the input needs ISO.
const toIso = v => {
  if (!v) return '';
  const p = String(v).split('/');
  return p.length === 3 ? `${p[2]}-${p[0].padStart(2, '0')}-${p[1].padStart(2, '0')}` : '';
};
const fromIso = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
function InlineDate({ value, onChange }) {
  return <input type="date" className="trn-inline trn-inline-date" value={toIso(value)} onChange={e => onChange(fromIso(e.target.value))} />;
}

const isOn = v => v === 1 || v === '1';

// onNavigateTo moves between Trainings' own views (workspace ↔ board);
// onNavigateApp leaves the module entirely, for the contact links in the hero.
export default function Trainings({ navTarget, onClearNav, onRecordSelect, onNavigateApp, onNavigateTo } = {}) {
  const { records, total } = useAllRecords(LAYOUT, { cacheVersion: CACHE_VERSION });
  const [selected, setSelected] = useState(null);
  const [remindOpen, setRemindOpen] = useState(false)
  const [navWidth, setNavWidth] = useState(300);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [saveErrorMsg, setSaveErrorMsg] = useState(null);
  const [tab, setTab] = useState('info');
  const [woBusy, setWoBusy] = useState(null);   // 'download' | null
  const [woStage, setWoStage] = useState(null);
  const [woError, setWoError] = useState(null);
  const [orgPicker, setOrgPicker] = useState(false);
  const [contactPicker, setContactPicker] = useState(false);
  const trainingOrgs = useCcsOrgs(getCurrentEnv().db, 'trainings');
  const board = useTrainingsKanbanBoard();
  // 'trainings' namespaces this away from CCS: both key by FileMaker recordId,
  // and those are only unique within a table.
  const opsLead = useOpsLeads(getCurrentEnv().db, 'trainings');
  const valueLists = useValueLists(LAYOUT, { Trainers: TRAINER_OPTIONS });
  const trainerOptions = valueLists.Trainers ?? TRAINER_OPTIONS;

  // Same org-name join CCS uses: trainings_New has no writable org field
  // either, only the zz__Display_Organization__ct calc, so a Vibe override
  // (trainingOrgs) or — failing that — a name match against real Vibe
  // organizations is what makes the header clickable at all.
  const { records: contactRecords } = useAllRecords('Contacts_New', { cacheVersion: 2 });
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
  // Contact phone/e-mail from Vibe, and live QuickBooks figures — both keyed so
  // a slow answer cannot land on a record the user has already moved off.
  const [contactInfo, setContactInfo] = useState(null);
  const [fin, setFin] = useState(null);
  // Which of the Invoices/Payments tabs is showing, in the Contract and
  // financials card — same control CCS's own card uses.
  const [finTab, setFinTab] = useState('invoices');
  const isResizing = useRef(false);

  const orgName = f => f.zz__Display_Organization__ct || '';

  const list = useListControls({
    records,
    storageKey: 'trn_sort',
    name: orgName,
    searchKeys: ['zz__Display_Organization__ct', 'zz__Display_Contact__ct', 'Type of Program', 'Status', 'Lead Trainer', '_kpt__TrainingProposal_ID'],
    chips: [
      { id: 'all', label: 'All' },
      { id: 'invoiced', label: 'Final invoiced', color: STATUS_COLOR['Final Invoiced'], match: f => f.Status === 'Final Invoiced' },
      { id: 'bill', label: 'Ready to bill', color: STATUS_COLOR['Ready to Bill'], match: f => f.Status === 'Ready to Bill' },
      { id: 'nogo', label: 'No go', color: STATUS_COLOR['No Go'], match: f => f.Status === 'No Go' },
    ],
    sorts: [
      { id: 'date', label: 'Start date', value: f => parseFmDate(f['Start Date']) },
      { id: 'alpha', label: 'Name', alpha: true, value: f => orgName(f).trim().toLowerCase() || '￿' },
      { id: 'created', label: 'Created', value: f => parseFmDate(f.zz__Created_On) },
      { id: 'modified', label: 'Modified', value: f => parseFmDate(f.zz__Modified_On) },
    ],
    defaultSort: 'date', defaultOrder: 'desc',
  });

  async function handleSelect(r) {
    setEdits({}); setSaveStatus(null);
    setSelected(r);
    getRecord(LAYOUT, r.recordId).then(detail => {
      setSelected(prev => prev?.recordId === r.recordId ? detail.response.data[0] : prev);
    }).catch(() => {});
  }

  // Deep-link from the command palette / Contacts custom-training rows.
  useEffect(() => {
    if (navTarget?.moduleId !== 'trainings' || !navTarget.recordId) return;
    const rec = records.find(r => String(r.recordId) === String(navTarget.recordId));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deep-link selection
    if (rec) { handleSelect(rec); onClearNav?.(); return; }
    // Not in the loaded list yet (still loading): fetch directly so it still opens.
    let alive = true;
    getRecord(LAYOUT, navTarget.recordId).then(d => {
      const r = d?.response?.data?.[0];
      if (alive && r) { handleSelect(r); onClearNav?.(); }
    }).catch(() => {});
    return () => { alive = false; };
  }, [navTarget, records]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFieldChange = useCallback((fk, v) => setEdits(p => ({ ...p, [fk]: v })), []);
  const handleDiscard = () => { setEdits({}); setSaveStatus(null); setSaveErrorMsg(null); };

  // FMP-style "Stamp": prepend "user M/D/YYYY h:mm:ss AM/PM:" to a notes field.
  const stampNote = useCallback((fk) => {
    let user = 'admin';
    try { user = sessionStorage.getItem('fmp_user_name') || 'admin'; } catch { /* unavailable */ }
    const now = new Date();
    const stamp = `${user} ${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.toLocaleTimeString('en-US')}:`;
    setEdits(p => {
      const cur = fk in p ? p[fk] : (selected?.fieldData?.[fk] || '');
      const curText = typeof cur === 'string' ? cur.replace(/\r/g, '\n') : (cur ?? '');
      return { ...p, [fk]: `${stamp}\n${curText ? '\n' + curText : ''}` };
    });
  }, [selected]);

  // Work order PDF — prints the Notes field as its body, downloaded through the
  // same pipeline training photos already use.
  //
  // Download only. There was a second button that generated the same PDF and
  // attached it to the record; it is gone, along with the branch that served
  // it. The generator itself is untouched — one PDF, one path to it.
  async function handleGenerateWorkOrder() {
    if (!selected) return;
    setWoBusy('download');
    setWoStage('Building PDF…'); setWoError(null);
    // Merge pending edits so the PDF matches what's on screen, not the last save.
    const rec = { ...selected, fieldData: { ...selected.fieldData, ...edits } };
    try {
      await downloadWorkOrder(rec, setWoStage);
    } catch (e) { setWoError(e.message || 'Work order failed'); }
    finally { setWoBusy(null); setWoStage(null); }
  }

  async function handleSave() {
    const dirtyCount = Object.keys(edits).length;
    if (!dirtyCount) { return; }
    setSaving(true); setSaveStatus(null); setSaveErrorMsg(null);
    try {
      // trainings_New is Vibe-owned (api/_vibeStore.js), so edits go to the
      // overlay rather than back to FileMaker — and no longer need a per-user
      // FileMaker account to succeed.
      await updateVibeRecord(LAYOUT, selected.recordId, edits);
      patchCachedRecord(LAYOUT, CACHE_VERSION, selected.recordId, edits);
      invalidateRecord(LAYOUT, selected.recordId);
      setSelected(prev => ({ ...prev, fieldData: { ...prev.fieldData, ...edits } }));
      setEdits({}); setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (e) { setSaveStatus('error'); setSaveErrorMsg(e?.message || null); }
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
      setNavWidth(Math.min(520, Math.max(200, startW + (e.clientX - startX))));
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
  const dirtyCount = Object.keys(edits).length;
  const status = f ? (val(f, edits, 'Status') || '') : '';
  const statusColor = trnStatusColor(status) || STATUS_COLOR[status] || STATUS_COLOR.default;
  const stage = stageIndex(status);

  const heroOrgName = f?.zz__Display_Organization__ct || '';
  const vibeOrgId = selected ? trainingOrgs.orgIdFor(selected.recordId) : '';
  // The Vibe override wins when set; otherwise fall back to a name match, same
  // precedence CCS uses. Plain text (no link) rather than guessing when
  // neither resolves — an org page opened for the wrong org is worse than none.
  const orgLinkId = vibeOrgId || orgIdByName.get(heroOrgName.trim().toLowerCase()) || '';

  const contactFk = String(f?._kft__Contact_ID || '').trim();
  const hasContact = !!f?.zz__Display_Contact__ct && f.zz__Display_Contact__ct !== '<unassigned>';

  // Reassign the training's contact.
  //
  // Writes to VIBE as of Phase C1, mirroring CCSv2.jsx's own handleContactChange
  // and for the identical reason it can now: api/_contactDisplay.js resolves the
  // names and billing address block from Vibe's contact model, which is what
  // kept this on FileMaker until today (docs/derived-fields-audit.md).
  async function handleContactChange(contactRecord) {
    setContactPicker(false);
    const newContactId = String(contactRecord?.fieldData?._kpt__Contact_ID || '').trim();
    if (!selected || !newContactId) return;
    try {
      // No organization hint — the contact is changing, so the organization on
      // the record describes the OLD one. clearAddress because the block
      // currently stored is the previous contact's: blank is recoverable, an
      // address for the wrong organization on a work order is not.
      const { fields: display } = await displayFieldsForContact(
        LAYOUT, newContactId, { clearAddress: true, fallbackRecord: contactRecord?.fieldData });
      const edits = { _kft__Contact_ID: newContactId, ...display };
      await updateVibeRecord(LAYOUT, selected.recordId, edits);
      patchCachedRecord(LAYOUT, CACHE_VERSION, selected.recordId, edits);
      setSelected(prev => ({ ...prev, fieldData: { ...prev.fieldData, ...edits } }));
    } catch { /* the picker already closed; a failed reassignment just leaves the old contact showing */ }
  }

  useEffect(() => {
    if (!contactFk) return undefined;
    let alive = true;
    contactDetails(contactFk, { firstEmail: true })
      .then(d => { if (alive) setContactInfo({ id: contactFk, ...d }); })
      .catch(() => { if (alive) setContactInfo({ id: contactFk }); });
    return () => { alive = false; };
  }, [contactFk]);
  const ci = contactInfo?.id === contactFk ? contactInfo : null;

  // Live QuickBooks figures. `source=trainings` tells the endpoint to read the
  // single-value reference fields rather than RCD's repeating ones.
  const recId = selected?.recordId;
  useEffect(() => {
    if (!recId) return undefined;
    let alive = true;
    fetch(`/api/ccs-estimate?db=${encodeURIComponent(getCurrentEnv().db)}&recordId=${recId}&source=trainings`,
      { credentials: 'include' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(j => { if (alive) setFin({ id: recId, ...j }); })
      .catch(() => { if (alive) setFin({ id: recId }); });
    return () => { alive = false; };
  }, [recId]);
  const qb = fin?.id === recId ? fin : null;
  const money = v => (v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }));


  return (
    <div className="trn-container">
      <aside className="trn-sidebar" style={{ width: navWidth }}>
        <div className="trn-sidebar-header">
          <div className="trn-sidebar-title">
            <div>
              <div className="trn-sidebar-module">Trainings</div>
              <div className="trn-sidebar-count">{total ? `${total.toLocaleString()} trainings` : 'Loading…'}</div>
            </div>
          </div>
          <ListToolbar c={list} unit="trainings" />
        </div>

        {records.length === 0 ? (
          <div className="trn-loading">{[...Array(8)].map((_, i) => <div key={i} className="trn-skeleton" />)}</div>
        ) : (
          <div className="trn-list">
            <ListBody c={list} activeId={selected?.recordId} renderItem={r => {
              const color = STATUS_COLOR[r.fieldData.Status] || STATUS_COLOR.default;
              return (
                <div key={r.recordId}
                  className={`trn-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                  onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId, r.fieldData?.zz__Display_Organization__ct); }}
                  // onMouseEnter={() => prefetchRecord(LAYOUT, r.recordId)}
                >
                  <span className="trn-item-dot" style={{ background: color }} />
                  <div className="trn-item-text">
                    <div className="trn-item-name">{r.fieldData.zz__Display_Organization__ct || '—'}</div>
                    <div className="trn-item-sub">
                      {[r.fieldData['Type of Program'], r.fieldData['Start Date']].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                </div>
              );
            }} />
          </div>
        )}
      </aside>

      <div className="trn-resize-handle" onMouseDown={startResize} />

      <main className="trn-main">
        {!selected && (
          <div className="trn-empty-state">
            <div className="trn-empty-icon">◳</div>
            <p>Select a training</p>
          </div>
        )}

        {selected && f && (
          <>
            <div className="trn-topbar">
              <div className="trn-topbar-actions">
                {/* Same board-membership toggle + nav CCS's crumb bar uses
                    (CCSv2.jsx) — cv2-ghost-btn/cv2-on-board are already
                    loaded via RecordLayout.jsx's CCSv2.css import. */}
                {(() => {
                  const onBoard = board.ids.has(String(selected.recordId));
                  return (
                    <button className={`cv2-ghost-btn${onBoard ? ' cv2-on-board' : ''}`}
                      onClick={() => board.toggle(selected.recordId, !onBoard)}
                      title={onBoard ? 'Remove this training from the Kanban board' : 'Add this training to the Kanban board'}>
                      {onBoard ? '⊞ On board ✓' : '⊞ Add to board'}
                    </button>
                  );
                })()}
                <button className="cv2-ghost-btn" onClick={() => onNavigateTo?.('trainings-kanban', selected.recordId)}>Board →</button>
                <button className="h5-btn h5-btn--quiet h5-btn--sm" onClick={() => setRemindOpen(true)}>⏰ Remind</button>
                <DeleteRecordButton
                  layout={LAYOUT} cacheVersion={CACHE_VERSION}
                  recordId={selected.recordId}
                  name={f.zz__Display_Organization__ct}
                  onDeleted={() => setSelected(null)}
                />
              </div>
            </div>

            {/* HERO — same shape as CCS's: project type above the org name,
                contact underneath, both clickable when an id resolves and
                both offering Change/Assign. Status lives here as a select,
                not restated lower on the page. */}
            <div className="cv2-hero">
              <div className="cv2-hero-top">
                <div className="cv2-hero-id">
                  <div className="cv2-hero-type">{f['Type of Program'] || 'Training'}</div>
                  <h1 className="cv2-hero-org">
                    {orgLinkId
                      ? <button type="button" className="cv2-hero-link" title="Open this organization"
                          onClick={() => onNavigateApp?.('contacts-v2', orgLinkId)}>{heroOrgName || '—'}</button>
                      : (heroOrgName || '—')}
                    <button className="cv2-pick-btn" onClick={() => setOrgPicker(true)} title="Assign this training to an organization">
                      {orgLinkId || heroOrgName ? 'Change' : 'Assign'}
                    </button>
                  </h1>
                  <div className="cv2-hero-contact">
                    <span className="cv2-ic">◉</span>
                    {hasContact
                      ? (contactFk
                          ? <button type="button" className="cv2-hero-link" title="Open this contact"
                              onClick={() => onNavigateApp?.('contacts-v2', contactFk)}>{f.zz__Display_Contact__ct}</button>
                          : f.zz__Display_Contact__ct)
                      : <span className="cv2-hero-none">No contact</span>}
                    <button className="cv2-pick-btn" onClick={() => setContactPicker(true)} title="Choose the contact for this training">
                      {hasContact ? 'Change' : 'Assign'}
                    </button>
                  </div>
                </div>
                <select className="cv2-status" style={{ color: statusColor, borderColor: statusColor + '55', background: statusColor + '14' }}
                  value={status} onChange={e => handleFieldChange('Status', e.target.value)}>
                  <option value="">— status —</option>
                  {/* statusOptionsFor, not ALL_STATUSES: five values were retired
                      on 2026-08-20 and 84 records still hold one. A <select>
                      whose value is not among its options renders BLANK, and
                      saving that record would write the blank over a real
                      status. This prepends the record's own value when it is a
                      retired one, so opening a record can never erase it. */}
                  {statusOptionsFor(status).map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            </div>

            {/* ── The CCS record layout, applied to a training ──────────
                Everything above the tab strip is always visible; the tabs
                below keep the deeper content (costs, logistics, attachments)
                exactly where it was. See src/components/RecordLayout.jsx. */}
            <div className="trn-canvas">

              {/* A pipeline is shown only for a record actually in flight.
                  1,493 trainings are Final Invoiced and 753 are No Go — 91% of
                  the table — and for those the status pill above says it all;
                  a stage bar would just read "not a stage" forever. */}
              {stage >= 0 && (
                <Pipeline
                  stages={PIPELINE_STAGES}
                  shortLabels={PIPELINE_SHORT}
                  index={stage}
                  fallbackLabel={status}
                  fallbackColor={statusColor}
                  onSetStage={s => handleFieldChange('Status', s)}
                />
              )}

              <StatTiles tiles={[
                { label: 'Estimated', value: money(qb?.totals?.estimated) },
                { label: 'Invoiced', value: money(qb?.totals?.invoiced) },
                { label: 'Received', value: money(qb?.totals?.received) },
                { label: 'Balance due', value: money(qb?.totals?.balanceDue),
                  tone: qb?.totals?.balanceDue > 0 ? statusColor : undefined },
              ]} />

              <ThirdsRow
                left={<>
                  <LayoutCard title="Contact">
                    <ContactDetails
                      addressBlock={f.Address_Block_Billing}
                      info={ci}
                      hasContact={!!contactFk}
                    />
                  </LayoutCard>

                  <LayoutCard title="Trainers">
                    <div className="cv2-team">
                      {/* Operations lead — a Vibe-only field held in Redis, not
                          FileMaker, exactly as CCS has it. Saves immediately on
                          change rather than going through the record's Save
                          button, because there is no FileMaker field to stage. */}
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
                      {/* Every filled slot, editable in place, plus exactly one
                          open slot at the end so adding a trainer is just
                          picking a name — filling it reveals the next blank
                          one on the next render. Up to 19 total (Lead + 18
                          numbered) now that trainers10-18 exist. */}
                      {(() => {
                        const allKeys = [['Lead Trainer', 'Lead trainer'], ...TRAINER_SLOTS.map((k, i) => [k, `Trainer ${i + 1}`])];
                        const filled = allKeys.filter(([k]) => String(val(f, edits, k) || '').trim());
                        const nextEmpty = allKeys.find(([k]) => !String(val(f, edits, k) || '').trim());
                        const rows = nextEmpty ? [...filled, nextEmpty] : filled;
                        return rows.map(([k, label]) => (
                          <div className="cv2-team-row" key={k}>
                            <span className="trn-avatar">{String(val(f, edits, k) || '').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '—'}</span>
                            <div className="cv2-team-pick">
                              <label>{label}</label>
                              <InlineSelect value={val(f, edits, k)} options={trainerOptions} onChange={v => handleFieldChange(k, v)} />
                            </div>
                          </div>
                        ));
                      })()}
                    </div>
                  </LayoutCard>
                </>}
                right={
                  <LayoutCard title="Contract and financials">
                    {/* Same 6 labels as CCS's card, each wired to Trainings'
                        own field. Two are not a clean 1:1: Trainings has no
                        PO-number text field, so 'PO #' shows deposit_number
                        (paired with the real po_received checkbox); and
                        'Final Invoice Sent' has no matching *_recvd field, so
                        it gets no Received button, same as CCS would show
                        for a milestone with no checkbox. 'Sent in-house' is
                        dropped from this card — still editable on the
                        Logistics tab as 'Logistics sent', same field. */}
                    <FinancialRows
                      InlineText={InlineValue}
                      InlineDate={InlineDate}
                      rows={[
                        { label: 'Estimate #', value: val(f, edits, '_kat__QuickBooks_Estimate_ID') || '', onChange: v => handleFieldChange('_kat__QuickBooks_Estimate_ID', v) },
                        { label: 'Contract Sent', type: 'date', value: val(f, edits, 'Proposed') || '', onChange: v => handleFieldChange('Proposed', v),
                          received: isOn(val(f, edits, 'proposed_recvd')), onToggle: () => handleFieldChange('proposed_recvd', isOn(val(f, edits, 'proposed_recvd')) ? 0 : 1) },
                        { label: 'Deposit Invoice Sent', type: 'date', value: val(f, edits, 'Confirmed') || '', onChange: v => handleFieldChange('Confirmed', v),
                          received: isOn(val(f, edits, 'confirmed_recvd')), onToggle: () => handleFieldChange('confirmed_recvd', isOn(val(f, edits, 'confirmed_recvd')) ? 0 : 1) },
                        { label: 'PO #', value: val(f, edits, 'deposit_number') || '', onChange: v => handleFieldChange('deposit_number', v),
                          received: isOn(val(f, edits, 'po_received')), onToggle: () => handleFieldChange('po_received', isOn(val(f, edits, 'po_received')) ? 0 : 1) },
                        { label: 'Final Invoice Sent', type: 'date', value: val(f, edits, 'Final Sent') || '', onChange: v => handleFieldChange('Final Sent', v) },
                        { label: 'Invoice #', value: val(f, edits, '_kat__QuickBooks_Invoice_ID') || '', onChange: v => handleFieldChange('_kat__QuickBooks_Invoice_ID', v) },
                      ]}
                    />
                    {qb?.estimates?.length > 0 && (
                      <div className="cv2-qboest">
                        <div className="cv2-qboest-head">QuickBooks estimate{qb.estimates.length > 1 ? 's' : ''} · live</div>
                        {qb.estimates.map(e => (
                          <div className="cv2-qboest-row" key={e.docNumber}>
                            <span className="cv2-qboest-doc">{e.docNumber}</span>
                            {e.missing
                              ? <span className="cv2-qboest-missing">not found in QuickBooks</span>
                              : <span className={`cv2-qboest-status ${String(e.status || '').toLowerCase()}`}>{e.status || '—'}</span>}
                            {!e.missing && <span className="cv2-qboest-total">{money(e.total)}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Invoices / Payments — same placement and markup as
                        CCS's card (cv2-fin-embed). api/ccs-estimate.js
                        already returns both regardless of source, so this
                        was just unwired UI, not missing data. */}
                    <div className="cv2-fin-embed">
                      <div className="cv2-fin-tabs">
                        {[['invoices', 'Invoices', qb?.invoices?.length || 0], ['payments', 'Payments', qb?.payments?.length || 0]].map(([id, lbl, n]) => (
                          <button key={id} className={`cv2-fin-tab${finTab === id ? ' active' : ''}`} onClick={() => setFinTab(id)}>{lbl}<span>{n}</span></button>
                        ))}
                      </div>
                      <div className="cv2-fin-list">
                        {finTab === 'invoices' && (qb?.invoices?.length ? qb.invoices.map(r => (
                          <a className={`cv2-fin-row cv2-fin-link${r.customerMatch === false ? ' cv2-fin-suspect' : ''}`} key={r.qboId}
                            href={qboLink('Invoice', r.qboId)} target="_blank" rel="noreferrer"
                            title={r.customerMatch === false
                              ? `This QuickBooks invoice belongs to "${r.customer}", not this training — check the invoice number on the record`
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
                        )) : <div className="cv2-fin-empty">{qb ? 'No invoices in QuickBooks' : 'No invoice linked to this training'}</div>)}
                        {finTab === 'payments' && (qb?.payments?.length ? qb.payments.map(r => (
                          <a className="cv2-fin-row cv2-fin-link" key={r.qboId}
                            href={qboLink('Payment', r.qboId)} target="_blank" rel="noreferrer"
                            title="Open this payment in QuickBooks Online">
                            <span className="cv2-fin-main">
                              {fmtIsoShort(r.date)} · {r.method || 'Payment'}{r.reference ? ` · ${r.reference}` : ''}
                              {r.paymentTotal > r.amount && <span className="cv2-fin-tag">of {fmtMoneyFull(r.paymentTotal)}</span>}
                            </span>
                            <span className="cv2-fin-amt">{fmtMoneyFull(r.amount)}<span className="cv2-fin-ext">↗</span></span>
                          </a>
                        )) : <div className="cv2-fin-empty">{qb?.invoices?.length ? 'No payments received yet' : 'No invoice linked to this training'}</div>)}
                      </div>
                      {((qb?.invoices?.length || 0) > 0 || (qb?.payments?.length || 0) > 0) && (
                        <div className="cv2-fin-src">live from QuickBooks</div>
                      )}
                    </div>
                  </LayoutCard>
                }
              />

              <LayoutCard title="Details">
                <div className="trn-detail-grid">
                  <label>Program type</label><SelectValue value={val(f, edits, 'Type of Program')} options={PROGRAM_TYPES} onChange={v => handleFieldChange('Type of Program', v)} />
                  <label>Audience</label><SelectValue value={val(f, edits, 'Audience')} options={AUDIENCE_OPTIONS} onChange={v => handleFieldChange('Audience', v)} />
                  <label>Start date</label><InlineDate value={val(f, edits, 'Start Date')} onChange={v => handleFieldChange('Start Date', v)} />
                  <label>End date</label><InlineDate value={val(f, edits, 'End Date')} onChange={v => handleFieldChange('End Date', v)} />
                  <label># Days</label><InlineValue value={val(f, edits, '# Days')} onChange={v => handleFieldChange('# Days', v)} />
                  <label># Hours</label><InlineValue value={val(f, edits, '# Hours')} onChange={v => handleFieldChange('# Hours', v)} />
                  <label>Group size</label><InlineValue value={val(f, edits, 'Group Size')} onChange={v => handleFieldChange('Group Size', v)} />
                  <label>Workshop location</label><InlineValue value={val(f, edits, 'Workshop Location')} onChange={v => handleFieldChange('Workshop Location', v)} />
                  {/* Calculated — never editable, here or on any other layout. */}
                  <label>Distance to HQ</label><span className="trn-static">{val(f, edits, 'Distance To High5') || '—'}</span>
                  <label>Drive time</label><span className="trn-static">{val(f, edits, 'Drive Time') || '—'}</span>
                </div>
              </LayoutCard>

              {/* Work Order Notes + Notes, side by side — mirrors CCS exactly.
                  'Work Order' is a Vibe-only field (no such field exists on
                  trainings_New in FileMaker; see api/_vibeStore.js) and is
                  what the PDF prints as its body — see trainingWorkOrder.js.
                  'Notes' is the general free-text field and keeps its own
                  Stamp button, same as CCS's does. */}
              <NotesPair
                left={{
                  title: 'Work Order Notes',
                  children: (
                    <>
                      <textarea
                        className="trn-notes-area"
                        value={val(f, edits, 'Work Order') || ''}
                        placeholder="Add a work order…"
                        onChange={e => handleFieldChange('Work Order', e.target.value)}
                      />
                      {/* Sits beside the buttons it affects, not on the Costs
                          tab where the figures live — a setting is easiest to
                          understand next to the thing it changes. Off by
                          default: the work order is handed to a CLIENT for
                          signature, and trainer food, lodging and mileage are
                          internal figures that should be disclosed on purpose
                          rather than by default. */}
                      <label className="cv2-wo-check" title="Print the Trainer costs from the Costs / Expenses tab on the work order">
                        <input type="checkbox"
                          checked={String(val(f, edits, 'include_trainer_costs') || '') === '1'}
                          onChange={e => handleFieldChange('include_trainer_costs', e.target.checked ? '1' : '')} />
                        Include trainer costs
                      </label>
                      <div className="cv2-wo-actions">
                        <button type="button" className="cv2-wo-btn" disabled={!!woBusy} onClick={handleGenerateWorkOrder}>
                          {woBusy ? (woStage || 'Working…') : '⤓ Download work order'}
                        </button>
                      </div>
                      {woError && <p className="cv2-wo-error">{woError}</p>}
                    </>
                  ),
                }}
                right={{
                  title: 'Notes',
                  action: <button type="button" className="trn-stamp-btn" onClick={() => stampNote('Notes')}>⏱ Stamp</button>,
                  children: (
                    <textarea
                      className="trn-notes-area"
                      value={val(f, edits, 'Notes') || ''}
                      placeholder="Add notes…"
                      onChange={e => handleFieldChange('Notes', e.target.value)}
                    />
                  ),
                }}
              />
            </div>

            <div className="trn-tabs">
              {[['info', 'Training Info'], ['costs', 'Costs / Expenses'], ['logistics', 'Logistics'], ['attachments', 'Attachments']].map(([id, label]) => (
                <button key={id} className={`trn-tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>{label}</button>
              ))}
            </div>

            <div className="trn-content">
              {tab === 'info' && (<>
              {/* Organization, Contact, Type of program, Status, and everything
                  else the Details card / hero already show above are NOT
                  repeated here — only what has no home elsewhere on the page. */}
              <Section title="Program" icon="◈">
                <div className="trn-field-grid">
                  <CheckField label="Inspection required" fieldKey="Inspection Required" f={f} edits={edits} onChange={handleFieldChange} />
                  <TextField label="Report printed" fieldKey="Report Printed" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                </div>
              </Section>
              {/* Trainers and Contact sections removed — both are now shown
                  at the top of the page (the hero's editable Trainers card
                  and Contact card), so repeating them here was duplicative. */}
              </>)}

              {tab === 'costs' && (<>
              <div className="trn-cost-cols">
                <CostTable title="Program costs" lines={PROGRAM_COSTS} f={f} edits={edits} onChange={handleFieldChange} />
                <div>
                  <CostTable title="Trainer costs" lines={TRAINER_COSTS} f={f} edits={edits} onChange={handleFieldChange}
                    totals={{ est: 'TOTAL COSTS', act: 'Act ProgTotal' }} />
                  <Section title="Travel" icon="➤">
                    <div className="trn-field-grid">
                      <TextField label="Distance to High 5" fieldKey="Distance To High5" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} />
                      <TextField label="Drive time" fieldKey="Drive Time" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} />
                      <TextField label="Mileage" fieldKey="Mileage" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                      <TextField label="Mileage quantity" fieldKey="mileage_quantity" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                      <TextField label="Mileage price" fieldKey="mileage_price" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                    </div>
                  </Section>
                </div>
              </div>
              </>)}

              {tab === 'logistics' && (<>
              <Section title="Program logistics" icon="⚐">
                <div className="trn-field-grid">
                  {LOGISTICS_FIELDS.map(l => (
                    <TextField key={l.key} label={l.label} fieldKey={l.key} f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  ))}
                  <TextField label="Logistics sent" fieldKey="sent in-house" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <CheckField label="In-house received" fieldKey="in_house_recvd" f={f} edits={edits} onChange={handleFieldChange} />
                  <TextAreaField label="Logistics notes" fieldKey="Logistics Notes" f={f} edits={edits} onChange={handleFieldChange} onStamp={stampNote} rows={6} />
                </div>
              </Section>
              </>)}

              {tab === 'attachments' && (
              <div className="trn-section trn-section-att">
                <AttachmentsPanel parentId={f._kpt__TrainingProposal_ID} parentLabel={f.zz__Display_Organization__ct} api={trainingAttachments} title="Photos" invoiceDocNumber={f._kat__QuickBooks_Invoice_ID} />
              </div>
              )}


              <RecordFooter id={f._kpt__TrainingProposal_ID} recordId={selected.recordId} fieldData={f} />
              <RecordSaveBar count={dirtyCount} saving={saving} status={saveStatus} errorMessage={saveErrorMsg} onSave={handleSave} onDiscard={handleDiscard} />
            </div>
          </>
        )}
      </main>

      {remindOpen && selected && (
        <ReminderModal
          initial={{
            // The FileMaker recordId, which is what this module's navTarget
            // resolves and what RECORD_SOURCES looks a record up by. Contacts
            // are the exception (they key on the contact id) because their
            // FileMaker table is being retired; these layouts are not.
            recordType: 'trainings',
            recordId: String(selected.recordId),
            recordLabel: f.zz__Display_Organization__ct || 'training',
            title: `Follow up on ${f.zz__Display_Organization__ct || 'training'}`,
          }}
          onClose={() => setRemindOpen(false)}
          onSaved={() => setRemindOpen(false)} />
      )}

      {orgPicker && (
        <ContactPicker
          title="Assign this training to an organization"
          filter={c => String(c.Organization) === '1'}
          filterLabel="organizations"
          onSelect={r => { trainingOrgs.assign(selected.recordId, r?.fieldData?._kpt__Contact_ID); setOrgPicker(false); }}
          onClose={() => setOrgPicker(false)}
        />
      )}

      {/* Scoped to the chosen organization's people, same two-step pick CCS
          uses — contacts carry no organization id, only the calculated name,
          so the roster is joined on that. */}
      {contactPicker && (
        <ContactPicker
          title={heroOrgName ? `Contact at ${heroOrgName}` : 'Assign a contact to this training'}
          filter={heroOrgName
            ? (c => String(c.Organization) === '0' && c.zz__Display_Organization__ct === heroOrgName)
            : undefined}
          filterLabel={heroOrgName ? `at ${heroOrgName}` : undefined}
          onSelect={handleContactChange}
          onClose={() => setContactPicker(false)}
        />
      )}
    </div>
  );
}
