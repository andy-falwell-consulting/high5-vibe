import { useState, useCallback, useRef, useEffect } from 'react';
import { getRecord, prefetchRecord, updateRecord, invalidateRecord, patchCachedRecord } from '../api/filemaker';
import { useAllRecords } from '../hooks/useAllRecords';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import RecordSaveBar from './RecordSaveBar';
import AttachmentsPanel from './AttachmentsPanel';
import { trainingAttachments } from '../api/trainingAttachments';
import './TandD.css';

const LAYOUT = 'trainings_New'; // TEMP placeholder — net-new module; swap to the real T&D layout once created in FileMaker
const CACHE_VERSION = 1;
// This page is view-only — records (fields + attachments) cannot be edited.
// Flip to false to re-enable inline editing + the save bar.
const RECORDS_LOCKED = true;

const STATUS_COLOR = {
  'Final Invoiced': '#22c55e',
  'Ready to Bill':  '#e87722',
  'No Go':          '#64748b',
  default:          '#64748b',
};

// Proposed vs. actual cost lines. Each row is shown only when at least one side
// has a value; the totals row always shows.
const COST_LINES = [
  { label: 'Staffing',            prop: 'Prog Staffing Cost',            act: 'Act Prog Staffing' },
  { label: 'Planning',            prop: 'Prog Planning Time',            act: 'Act Prog Planning' },
  { label: 'Travel days',         prop: 'Prog Travel Days',              act: 'Act Prog Travel Days' },
  { label: 'Training materials',  prop: 'Prog Training Materials',       act: 'Act Prog Materials' },
  { label: 'Shipping',            prop: 'Prog Shipping',                 act: 'Act Prog Shipping' },
  { label: 'Equipment',           prop: 'Prog Equipment',                act: 'Act Prog Equipment' },
  { label: 'Food',                prop: 'Prog Food',                     act: 'Act Prog Food' },
  { label: 'Lodging',             prop: 'Prog Lodging',                  act: 'Act Prog Lodging' },
  { label: 'Client food/lodging', prop: 'Prog Participant Food Lodging', act: 'Act Prog Client Food Lodging' },
  { label: 'Lodging — dorms',     prop: 'Prog Participant Lodging Dorms', act: 'Act Prog Client Lodging Dorms' },
  { label: 'Lodging — cabins',    prop: 'Prog Participant Lodging Cabins', act: 'Act Prog Client Lodging Cabins' },
  { label: 'Lodging — yurt',      prop: 'Prog Participant Lodging Yurt', act: 'Act Prog Client Lodging Yurt' },
  { label: 'Airfare',             prop: 'Prog Airfare',                  act: 'Act Prog Airfare' },
  { label: 'Car rental',          prop: 'Prog Car Rental',               act: 'Act Prog Car Rental' },
  { label: 'Misc travel',         prop: 'Prog Misc Travel',              act: 'Act Prog Misc Travel' },
  { label: 'Mileage',             prop: 'Prog Mileage',                  act: null },
  { label: 'Rental — tent',       prop: 'Prog Rental Fee Tent',          act: null },
  { label: 'Rental — tables/chairs', prop: 'Prog Rental Fee Tables Chairs', act: null },
  { label: 'Rental — porta-potty', prop: 'Prog Rental Fee PortaPotty',   act: null },
  { label: 'Rental — other',      prop: 'Prog Rental Fee Other',         act: null },
  { label: 'NY state surcharge',  prop: 'ny_state_surcharge',            act: null },
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
    <div className={`tnd-field${wide ? ' wide' : ''}`}>
      <label>{label}{dirty && <span className="tnd-dirty-dot" />}</label>
      {editing && editable ? (
        <input className="tnd-input" value={v || ''} onChange={e => onChange(fieldKey, e.target.value)} />
      ) : (
        <span className={`tnd-value${mono ? ' mono' : ''}`}>{fmText(v) || '—'}</span>
      )}
    </div>
  );
}

function Section({ title, icon, children }) {
  return (
    <div className="tnd-section">
      <div className="tnd-section-header">
        <span className="tnd-section-icon">{icon}</span>
        <h3>{title}</h3>
      </div>
      {children}
    </div>
  );
}

export default function TandD({ navTarget, onClearNav, onRecordSelect } = {}) {
  const { records, total } = useAllRecords(LAYOUT, { cacheVersion: CACHE_VERSION });
  const [selected, setSelected] = useState(null);
  const [navWidth, setNavWidth] = useState(300);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const isResizing = useRef(false);

  const orgName = f => f.zz__Display_Organization__ct || '';

  const list = useListControls({
    records,
    storageKey: 'tnd_sort',
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
    if (navTarget?.moduleId !== 'tnd' || !navTarget.recordId) return;
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

  const otherTrainers = f
    ? ['Trainers', 'trainers2', 'trainers3', 'trainers4', 'trainers5', 'trainers6', 'trainers7', 'trainers8', 'trainers9']
        .map(k => f[k]).filter(t => t && String(t).trim()).join(', ')
    : '';

  const costRows = f ? COST_LINES.filter(c => num(f[c.prop]) || (c.act && num(f[c.act]))) : [];

  return (
    <div className="tnd-container">
      <aside className="tnd-sidebar" style={{ width: navWidth }}>
        <div className="tnd-sidebar-header">
          <div className="tnd-sidebar-title">
            <div>
              <div className="tnd-sidebar-module">Team Development</div>
              <div className="tnd-sidebar-count">{total ? `${total.toLocaleString()} programs` : 'Loading…'}</div>
            </div>
          </div>
          <ListToolbar c={list} unit="programs" />
        </div>

        {records.length === 0 ? (
          <div className="tnd-loading">{[...Array(8)].map((_, i) => <div key={i} className="tnd-skeleton" />)}</div>
        ) : (
          <div className="tnd-list">
            <ListBody c={list} renderItem={r => {
              const color = STATUS_COLOR[r.fieldData.Status] || STATUS_COLOR.default;
              return (
                <div key={r.recordId}
                  className={`tnd-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                  onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId, r.fieldData?.zz__Display_Organization__ct); }}
                  // onMouseEnter={() => prefetchRecord(LAYOUT, r.recordId)}
                >
                  <span className="tnd-item-dot" style={{ background: color }} />
                  <div className="tnd-item-text">
                    <div className="tnd-item-name">{r.fieldData.zz__Display_Organization__ct || '—'}</div>
                    <div className="tnd-item-sub">
                      {[r.fieldData['Type of Program'], r.fieldData['Start Date']].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                </div>
              );
            }} />
          </div>
        )}
      </aside>

      <div className="tnd-resize-handle" onMouseDown={startResize} />

      <main className="tnd-main">
        {!selected && (
          <div className="tnd-empty-state">
            <div className="tnd-empty-icon">◳</div>
            <p>Select a program</p>
          </div>
        )}

        {selected && f && (
          <>
            <div className="tnd-topbar">
              <div className="tnd-topbar-left">
                <div>
                  <h1 className="tnd-title">{f.zz__Display_Organization__ct || '—'}</h1>
                  <div className="tnd-meta-row">
                    {status && <span className="tnd-chip status" style={{ background: statusColor + '22', color: statusColor, borderColor: statusColor + '44' }}>{status}</span>}
                    {f['Type of Program'] && <span className="tnd-chip type">{f['Type of Program']}</span>}
                    {f['Start Date'] && <span className="tnd-chip muted">{f['Start Date']}{f['End Date'] && f['End Date'] !== f['Start Date'] ? ` – ${f['End Date']}` : ''}</span>}
                  </div>
                </div>
              </div>
            </div>

            <div className="tnd-content">
              <Section title="Program" icon="◈">
                <div className="tnd-field-grid">
                  <TextField label="Organization" fieldKey="zz__Display_Organization__ct" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable={false} />
                  <TextField label="Contact" fieldKey="zz__Display_Contact__ct" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable={false} />
                  <TextField label="Type of program" fieldKey="Type of Program" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="Status" fieldKey="Status" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="Start date" fieldKey="Start Date" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="End date" fieldKey="End Date" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="# Days" fieldKey="# Days" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="# Hours" fieldKey="# Hours" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="Audience" fieldKey="Audience" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="Group size" fieldKey="Group Size" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="Lead trainer" fieldKey="Lead Trainer" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="Workshop location" fieldKey="Workshop Location" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="Inspection required" fieldKey="Inspection Required" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  {otherTrainers && <div className="tnd-field wide"><label>Additional trainers</label><span className="tnd-value">{otherTrainers}</span></div>}
                  <TextField label="Location address" fieldKey="Location Address" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable wide />
                  <TextField label="Description of training" fieldKey="Description of Training" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable wide />
                </div>
              </Section>

              <Section title="Contact" icon="◉">
                <div className="tnd-field-grid">
                  <TextField label="Contact" fieldKey="zz__Display_Contact__ct" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable={false} />
                  <TextField label="Phone" fieldKey="trnpp_cntct_PHONE::Number" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable={false} mono />
                  <TextField label="Mobile" fieldKey="trnpp_cntct_PHONE_mobile::Number" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable={false} mono />
                  <TextField label="Email" fieldKey="trnpp_cntct_INADR__email::zz__Address__ct" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable={false} />
                  <TextField label="Billing address" fieldKey="Address_Block_Billing" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable={false} wide />
                </div>
              </Section>

              <Section title="Financials" icon="≡">
                <div className="tnd-table-wrap">
                  <table className="tnd-table">
                    <thead>
                      <tr><th>Line item</th><th className="num">Proposed</th><th className="num">Actual</th></tr>
                    </thead>
                    <tbody>
                      {costRows.length === 0 && <tr><td colSpan={3} className="tnd-empty-cell">No cost lines recorded</td></tr>}
                      {costRows.map(c => (
                        <tr key={c.label}>
                          <td>{c.label}</td>
                          <td className="num">{num(f[c.prop]) ? money(f[c.prop]) : '—'}</td>
                          <td className="num">{c.act && num(f[c.act]) ? money(f[c.act]) : '—'}</td>
                        </tr>
                      ))}
                      <tr className="total">
                        <td>Total</td>
                        <td className="num">{money(f['TOTAL COSTS'])}</td>
                        <td className="num">{money(f['Act ProgTotal'])}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Section>

              <Section title="Logistics" icon="⚐">
                <div className="tnd-field-grid">
                  {LOGISTICS_FIELDS.map(l => (
                    <TextField key={l.key} label={l.label} fieldKey={l.key} f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  ))}
                  <TextField label="Logistics notes" fieldKey="Logistics Notes" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable wide />
                </div>
              </Section>

              <Section title="Sales / pipeline" icon="◔">
                <div className="tnd-field-grid">
                  <TextField label="Proposed" fieldKey="Proposed" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="Confirmed" fieldKey="Confirmed" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="Final sent" fieldKey="Final Sent" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="Sent in-house" fieldKey="sent in-house" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="Email sent" fieldKey="email_sent_date" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="Deposit #" fieldKey="deposit_number" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable />
                  <TextField label="QB estimate ID" fieldKey="_kat__QuickBooks_Estimate_ID" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable={false} mono />
                  <TextField label="QB invoice ID" fieldKey="_kat__QuickBooks_Invoice_ID" f={f} edits={edits} onChange={handleFieldChange} editing={!RECORDS_LOCKED} editable={false} mono />
                </div>
              </Section>

              <div className="tnd-section tnd-section-att">
                <AttachmentsPanel parentId={f._kpt__TrainingProposal_ID} api={trainingAttachments} title="Photos" invoiceDocNumber={f._kat__QuickBooks_Invoice_ID} readOnly={RECORDS_LOCKED} />
              </div>

              <div className="tnd-record-footer">
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
