import { useState, useCallback, useRef, useEffect } from 'react';
import { getRecord, prefetchRecord, updateRecord, invalidateRecord, patchCachedRecord } from '../api/filemaker';
import { useAllRecords } from '../hooks/useAllRecords';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import RecordSaveBar from './RecordSaveBar';
import AttachmentsPanel from './AttachmentsPanel';
import { trainingAttachments } from '../api/trainingAttachments';
import './Trainings.css';

const LAYOUT = 'trainings_New';
const CACHE_VERSION = 1;

const STATUS_COLOR = {
  'Final Invoiced': '#22c55e',
  'Ready to Bill':  '#e87722',
  'No Go':          '#64748b',
  default:          '#64748b',
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
const STATUS_OPTIONS = ['Inquiry', 'Follow-up Needed', 'Proposed', 'Approved/Needs to be D-Invoiced & TC', 'Waiting on $ & Signed TC', 'Confirmed/Scheduled', 'Completed', 'Final Invoiced', 'No Go', 'Keene EOL/C&S', 'Out Reach', 'Other'];
const AUDIENCE_OPTIONS = ['Corporate', 'Adult', 'College', 'Youth Public', 'Youth Private', 'EOL'];
const PROGRAM_TYPES = ['Adventure Basics: Level 1 Training', 'Adventure Facilitaton Training', 'Beyond Basics: Level 2 Training', 'CATSEL - custom', 'Certification Exam - custom', 'CIT Training', 'Climbing Wall/Tower & Belay Skills Training', 'Corporate Program', 'Curriculum Writing', 'Consultation', 'Dialogue', 'EOL/SEL', 'EOL Sports', 'Game Bag Training', 'Gathering Again (Games & Lows)', 'Gathering Again 2 (High Elements)', 'High Elements and Belay Skills Training', 'Leadership Development', 'Low Elements Course Training', 'Low Traverse Wall Training', 'Managing an Adventure Program', 'Mastermind/Adventure Circuit', 'New Student Orientation ', 'Portable Adventure', 'Program Review', 'Team-building', 'Team Development', 'Technical Skills Refresher', 'Technical Skills Training', 'Technical Skills Verification', 'Therapeutic', 'Virtual Team-building', 'Virtual Team Development', 'Virtual Training', 'Keynote', 'Playnote', 'Other'];
const TRAINER_OPTIONS = ['Phil Brown', 'Lisa Hunt', 'Kyra Richardson', 'Elyse Norton', 'Cam Miller', 'Chris Damboise', 'Rich Keegan', 'Joshua Fisher', 'Alison Jackson-Frasier', 'Lisa Howard', 'Sadie Graham', 'Andrew  Wood', 'Olivia Howry', 'Hanne Bailey', 'Sam Copland', 'Stefanie Frazee', 'Jeff Frigon', 'Chris Ortiz', 'Ryan McCormick', 'Anne Louise Wagner', 'Chris Sanchez', 'Ky Schroeher', 'Jim Grout', 'Jiin Cruz', 'Sarah Morse', 'Phoebe Connolly', 'Ana Devlin Gauthier', 'Julia Stifler', 'Becky Proulx', 'Ron Vercellone', 'Amanda Klein', 'Mark Flynn', 'Beth Sayers', 'Nate Folan', 'Hutch Hutchinson', 'Stephanie Globus-Hoenig', 'Emily Kehoe', 'Tim Abraham', 'Ian Doak', 'Todd Brown', 'Jamie Thibodeau', 'Geoff Ward', "Constance O'Brien", 'Morgan Wiseman', 'Other'];
const TRAINER_SLOTS = ['Trainers', 'trainers2', 'trainers3', 'trainers4', 'trainers5', 'trainers6', 'trainers7', 'trainers8', 'trainers9'];

const num = v => Number(v || 0);
const money = v => '$' + num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// FileMaker stores line breaks as \r, which pre-wrap won't break on.
const fmText = v => (typeof v === 'string' ? v.replace(/\r/g, '\n') : v);

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

// Dropdown bound to a FileMaker value list. Keeps an off-list stored value
// visible/selectable so opening a record never silently changes it.
function SelectField({ label, fieldKey, f, edits, onChange, options, wide }) {
  const v = val(f, edits, fieldKey);
  const dirty = isDirty(f, edits, fieldKey);
  const opts = v && !options.includes(v) ? [v, ...options] : options;
  return (
    <div className={`trn-field${wide ? ' wide' : ''}`}>
      <label>{label}{dirty && <span className="trn-dirty-dot" />}</label>
      <select className="trn-input trn-select" value={v || ''} onChange={e => onChange(fieldKey, e.target.value)}>
        <option value="">—</option>
        {opts.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
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

export default function Trainings({ navTarget, onClearNav, onRecordSelect } = {}) {
  const { records, total } = useAllRecords(LAYOUT, { cacheVersion: CACHE_VERSION });
  const [selected, setSelected] = useState(null);
  const [navWidth, setNavWidth] = useState(300);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [tab, setTab] = useState('info');
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
  const handleDiscard = () => { setEdits({}); setSaveStatus(null); };

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

  async function handleSave() {
    const dirtyCount = Object.keys(edits).length;
    if (!dirtyCount) { return; }
    setSaving(true); setSaveStatus(null);
    try {
      await updateRecord(LAYOUT, selected.recordId, edits);
      patchCachedRecord(LAYOUT, CACHE_VERSION, selected.recordId, edits);
      invalidateRecord(LAYOUT, selected.recordId);
      setSelected(prev => ({ ...prev, fieldData: { ...prev.fieldData, ...edits } }));
      setEdits({}); setSaveStatus('saved');
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
  const statusColor = STATUS_COLOR[status] || STATUS_COLOR.default;


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
              <div className="trn-topbar-left">
                <div>
                  <h1 className="trn-title">{f.zz__Display_Organization__ct || '—'}</h1>
                  <div className="trn-meta-row">
                    {status && <span className="trn-chip status" style={{ background: statusColor + '22', color: statusColor, borderColor: statusColor + '44' }}>{status}</span>}
                    {f['Type of Program'] && <span className="trn-chip type">{f['Type of Program']}</span>}
                    {f['Start Date'] && <span className="trn-chip muted">{f['Start Date']}{f['End Date'] && f['End Date'] !== f['Start Date'] ? ` – ${f['End Date']}` : ''}</span>}
                  </div>
                </div>
              </div>
            </div>

            <div className="trn-tabs">
              {[['info', 'Training Info'], ['costs', 'Costs / Expenses'], ['logistics', 'Logistics'], ['attachments', 'Attachments'], ['extra', 'Extra']].map(([id, label]) => (
                <button key={id} className={`trn-tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>{label}</button>
              ))}
            </div>

            <div className="trn-content">
              {tab === 'info' && (<>
              <Section title="Program" icon="◈">
                <div className="trn-field-grid">
                  <TextField label="Organization" fieldKey="zz__Display_Organization__ct" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} />
                  <TextField label="Contact" fieldKey="zz__Display_Contact__ct" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} />
                  <SelectField label="Type of program" fieldKey="Type of Program" f={f} edits={edits} onChange={handleFieldChange} options={PROGRAM_TYPES} />
                  <SelectField label="Status" fieldKey="Status" f={f} edits={edits} onChange={handleFieldChange} options={STATUS_OPTIONS} />
                  <TextField label="Start date" fieldKey="Start Date" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <TextField label="End date" fieldKey="End Date" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <TextField label="# Days" fieldKey="# Days" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <TextField label="# Hours" fieldKey="# Hours" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <SelectField label="Audience" fieldKey="Audience" f={f} edits={edits} onChange={handleFieldChange} options={AUDIENCE_OPTIONS} />
                  <TextField label="Group size" fieldKey="Group Size" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <TextField label="Workshop location" fieldKey="Workshop Location" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <CheckField label="Inspection required" fieldKey="Inspection Required" f={f} edits={edits} onChange={handleFieldChange} />
                  <TextField label="Report printed" fieldKey="Report Printed" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <TextField label="Location address" fieldKey="Location Address" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable wide />
                  <TextAreaField label="Description of training" fieldKey="Description of Training" f={f} edits={edits} onChange={handleFieldChange} rows={3} />
                  <TextAreaField label="Notes" fieldKey="Notes" f={f} edits={edits} onChange={handleFieldChange} onStamp={stampNote} rows={7} />
                </div>
              </Section>

              <Section title="Trainers" icon="◉">
                <div className="trn-field-grid">
                  <SelectField label="Lead trainer" fieldKey="Lead Trainer" f={f} edits={edits} onChange={handleFieldChange} options={TRAINER_OPTIONS} />
                  {TRAINER_SLOTS.map((fk, i) => (
                    <SelectField key={fk} label={`Trainer ${i + 1}`} fieldKey={fk} f={f} edits={edits} onChange={handleFieldChange} options={TRAINER_OPTIONS} />
                  ))}
                </div>
              </Section>

              <Section title="Contact" icon="◉">
                <div className="trn-field-grid">
                  <TextField label="Contact" fieldKey="zz__Display_Contact__ct" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} />
                  <TextField label="Phone" fieldKey="trnpp_cntct_PHONE::Number" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} mono />
                  <TextField label="Mobile" fieldKey="trnpp_cntct_PHONE_mobile::Number" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} mono />
                  <TextField label="Email" fieldKey="trnpp_cntct_INADR__email::zz__Address__ct" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} />
                  <TextField label="Billing address" fieldKey="Address_Block_Billing" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} wide />
                </div>
              </Section>
              </>)}

              {tab === 'costs' && (<>
              <div className="trn-cost-cols">
                <CostTable title="Program costs" lines={PROGRAM_COSTS} f={f} edits={edits} onChange={handleFieldChange} />
                <div>
                  <CostTable title="Trainer costs" lines={TRAINER_COSTS} f={f} edits={edits} onChange={handleFieldChange}
                    totals={{ est: 'TOTAL COSTS', act: 'Act ProgTotal' }} />
                  <Section title="Travel" icon="➤">
                    <div className="trn-field-grid">
                      <TextField label="Distance to High 5" fieldKey="Distance To High5" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                      <TextField label="Drive time" fieldKey="Drive Time" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
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
                <AttachmentsPanel parentId={f._kpt__TrainingProposal_ID} api={trainingAttachments} title="Photos" invoiceDocNumber={f._kat__QuickBooks_Invoice_ID} />
              </div>
              )}

              {tab === 'extra' && (<>
              <Section title="Record" icon="⚙">
                <div className="trn-field-grid">
                  <TextField label="Trainings #" fieldKey="_kpt__TrainingProposal_ID" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} mono />
                  <TextField label="QB invoice #" fieldKey="_kat__QuickBooks_Invoice_ID" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable mono />
                  <TextField label="QB deposit/estimate #" fieldKey="_kat__QuickBooks_Estimate_ID" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable mono />
                  <TextField label="Site number" fieldKey="trnpp_CNTCT__site::Site Number" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} mono />
                  <div className="trn-field"><label>Created</label><span className="trn-value">{f.zz__Created_On || '—'} by {f.zz__Created_By || '—'}</span></div>
                  <div className="trn-field"><label>Modified</label><span className="trn-value">{f.zz__Modified_On || '—'} by {f.zz__Modified_By || '—'}</span></div>
                </div>
              </Section>

              <Section title="Sales / pipeline" icon="◔">
                <div className="trn-field-grid">
                  <TextField label="Proposed" fieldKey="Proposed" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <CheckField label="Proposed received" fieldKey="proposed_recvd" f={f} edits={edits} onChange={handleFieldChange} />
                  <TextField label="Confirmed" fieldKey="Confirmed" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <CheckField label="Confirmed received" fieldKey="confirmed_recvd" f={f} edits={edits} onChange={handleFieldChange} />
                  <TextField label="Final sent" fieldKey="Final Sent" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <TextField label="Email sent" fieldKey="email_sent_date" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <TextField label="Deposit #" fieldKey="deposit_number" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <CheckField label="PO received" fieldKey="po_received" f={f} edits={edits} onChange={handleFieldChange} />
                </div>
              </Section>
              </>)}

              <div className="trn-record-footer">
                ID {f._kpt__TrainingProposal_ID} · Record {selected.recordId} · Created {f.zz__Created_On?.split(' ')[0]} by {f.zz__Created_By} · Modified {f.zz__Modified_On?.split(' ')[0] || '—'} by {f.zz__Modified_By}
              </div>
              <RecordSaveBar count={dirtyCount} saving={saving} status={saveStatus} onSave={handleSave} onDiscard={handleDiscard} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
