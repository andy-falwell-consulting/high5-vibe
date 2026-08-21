import { useState, useCallback, useEffect } from 'react'
import { getRecord, invalidateRecord, patchCachedRecord, addCachedRecord } from '../api/filemaker'
import { updateVibeRecord, createVibeRecord } from '../api/vibeRecords'
import { contactDetails } from '../api/contactLookup'
import { useAllRecords } from '../hooks/useAllRecords'
import { BRAND, UI } from '../config/brandColors'
import ListToolbar, { useListControls, ListBody } from './ListControls'
import RecordSaveBar from './RecordSaveBar'
import RecordFormModal from './RecordFormModal'
import './RMI.css'
import DeleteRecordButton from './DeleteRecordButton'
import RecordFooter from './RecordFooter';
import { useRecordPanel } from '../hooks/useRecordPanel';

const LAYOUT = 'RMI_New'
const CACHE_VERSION = 1

const STATUS_COLOR = {
  Active:   UI.danger,
  Resolved: UI.success,
  default:  UI.neutral,
}

const LEVEL_COLOR = {
  High:   UI.danger,
  Medium: BRAND.gold,
  Low:    UI.success,
}

// Risk-screening questions. Field keys are Question, Question_2..7.
const RISK_QUESTIONS = [
  { key: 'Question',   label: 'Is the client getting outside professional training?' },
  { key: 'Question_2', label: 'Is the client following our recommended staff training plan?' },
  { key: 'Question_3', label: 'Is the client getting their course inspected annually?' },
  { key: 'Question_4', label: 'Is the client making repairs to their course based on the inspection report?' },
  { key: 'Question_5', label: 'Did the client report an accident or incident?' },
  { key: 'Question_6', label: 'Does the client pay on time?' },
  { key: 'Question_7', label: 'Is the client vendor hopping?' },
]

// FileMaker stores line breaks as carriage returns (\r); normalize to \n.
const fmText = v => (typeof v === 'string' ? v.replace(/\r/g, '\n') : v)

const val = (f, edits, fk) => (fk in edits ? edits[fk] : f?.[fk])
const isDirty = (f, edits, fk) => fk in edits && edits[fk] !== (f?.[fk] ?? '')

function fmtDate(v) {
  if (!v) return '—'
  return String(v).split(' ')[0] || '—'
}

function TextField({ label, fieldKey, f, edits, onChange, editing, editable, mono, wide, textarea }) {
  const v = val(f, edits, fieldKey)
  const dirty = isDirty(f, edits, fieldKey)
  return (
    <div className={`rmi-field${wide ? ' wide' : ''}`}>
      <label>{label}{dirty && <span className="rmi-dirty-dot" />}</label>
      {editing && editable ? (
        textarea
          ? <textarea className="rmi-input rmi-textarea" value={v || ''} rows={5} onChange={e => onChange(fieldKey, e.target.value)} />
          : <input className="rmi-input" value={v || ''} onChange={e => onChange(fieldKey, e.target.value)} />
      ) : (
        <span className={`rmi-value${mono ? ' mono' : ''}`}>{fmText(v) || '—'}</span>
      )}
    </div>
  )
}

// A contact detail that comes from VIBE'S contact store rather than the record.
//
// PHASE C1. RMI's e-mail, work phone and mobile phone were FileMaker related
// fields — on the layout, readable, and populated on ZERO of all 119 production
// records, so all three printed "—" for every risk item ever opened. The
// relationships resolve empty over the Data API, exactly as they did for CCS
// (see api/contactLookup.js, which fixed the identical defect there).
//
// Read-only by nature: it is the contact's detail, edited on the contact.
function LookupField({ label, value, href, mono }) {
  return (
    <div className="rmi-field">
      <label>{label}</label>
      <span className={`rmi-value${mono ? ' mono' : ''}`}>
        {value ? (href ? <a href={href}>{value}</a> : value) : '—'}
      </span>
    </div>
  )
}

function LevelField({ label, fieldKey, f, edits, onChange, editing }) {
  const v = val(f, edits, fieldKey)
  const dirty = isDirty(f, edits, fieldKey)
  const color = LEVEL_COLOR[v] || '#64748b'
  return (
    <div className="rmi-field">
      <label>{label}{dirty && <span className="rmi-dirty-dot" />}</label>
      {editing ? (
        <select className="rmi-input" value={v || ''} onChange={e => onChange(fieldKey, e.target.value)}>
          <option value="">—</option>
          <option value="High">High</option>
          <option value="Medium">Medium</option>
          <option value="Low">Low</option>
        </select>
      ) : (
        v ? <span className="rmi-level-badge" style={{ background: color + '22', color, borderColor: color + '44' }}>{v}</span>
          : <span className="rmi-value">—</span>
      )}
    </div>
  )
}

function QuestionRow({ label, fieldKey, f, edits, onChange, editing }) {
  const v = val(f, edits, fieldKey)
  const dirty = isDirty(f, edits, fieldKey)
  const tone = v === 'Yes' ? 'yes' : v === 'No' ? 'no' : v === '?' ? 'maybe' : 'none'
  return (
    <div className={`rmi-q-row${dirty ? ' dirty' : ''}`}>
      <span className="rmi-q-label">{label}</span>
      {editing ? (
        <select className="rmi-q-select" value={v || ''} onChange={e => onChange(fieldKey, e.target.value)}>
          <option value="">—</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
          <option value="?">?</option>
        </select>
      ) : (
        <span className={`rmi-q-badge ${tone}`}>{v || '—'}</span>
      )}
    </div>
  )
}

function Section({ title, icon, children }) {
  return (
    <div className="rmi-section">
      <div className="rmi-section-header">
        <span className="rmi-section-icon">{icon}</span>
        <h3>{title}</h3>
      </div>
      {children}
    </div>
  )
}

export default function RMI({ navTarget, onClearNav, onRecordSelect } = {}) {
  const { records, total, loading, error } = useAllRecords(LAYOUT, { cacheVersion: CACHE_VERSION })
  const [selected, setSelected] = useState(null)
  // Width, drag and memory come from useRecordPanel — see the hook for what
  // the twelve hand-rolled copies had drifted into.
  const { width: navWidth, onPointerDown: startPanelResize } = useRecordPanel('rmi', 300);
  const [edits, setEdits] = useState({})
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState(null)
  const [saveErrorMsg, setSaveErrorMsg] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const [contactInfo, setContactInfo] = useState(null)

  // The selected record's contact, from Vibe — see LookupField above for why.
  // Keyed on the contact id so a stale reply for a previously selected record
  // cannot paint over the current one.
  const contactFk = String(selected?.fieldData?._kft__Contact_ID || '').trim()
  useEffect(() => {
    // No clearing when there is no contact: `ci` below is guarded on the id, so
    // a reply for a previously selected record can never render against this
    // one, and clearing here would be a synchronous setState in an effect.
    if (!contactFk) return undefined
    let alive = true
    contactDetails(contactFk, { firstEmail: true })
      .then(d => { if (alive) setContactInfo({ id: contactFk, ...d }) })
      .catch(() => { if (alive) setContactInfo({ id: contactFk }) })
    return () => { alive = false }
  }, [contactFk])
  const ci = contactInfo?.id === contactFk ? contactInfo : null

  const orgName = f => f.zz__Display_Organization__ct || f.zz__Display_Contact__ct || ''

  const list = useListControls({
    records,
    storageKey: 'rmi_sort',
    name: orgName,
    searchKeys: ['zz__Display_Organization__ct', 'zz__Display_Contact__ct', '_kpt__RMI_ID', 'Assigned_To', 'Staff', 'Note_Concern'],
    chips: [
      { id: 'active',   label: 'Active',     color: STATUS_COLOR.Active,   match: f => f.Status === 'Active' },
      { id: 'resolved', label: 'Resolved',   color: STATUS_COLOR.Resolved, match: f => f.Status === 'Resolved' },
      { id: 'highrisk', label: 'High risk',  color: LEVEL_COLOR.High,      match: f => f.Level_of_Risk === 'High' },
    ],
    sorts: [
      { id: 'entry',    label: 'Entry date', value: f => f.Entry_Date ?? '' },
      { id: 'alpha',    label: 'Org', alpha: true, value: f => orgName(f).trim().toLowerCase() || '￿' },
      { id: 'risk',     label: 'Risk', value: f => ({ High: 3, Medium: 2, Low: 1 }[f.Level_of_Risk] || 0) },
      { id: 'assigned', label: 'Assigned', value: f => f.Date_Assigned ?? '' },
    ],
    defaultSort: 'entry', defaultOrder: 'desc',
  })

  async function handleSelect(r) {
    setEdits({}); setSaveStatus(null)
    setSelected(r)
    getRecord(LAYOUT, r.recordId).then(detail => {
      const fresh = detail?.response?.data?.[0]
      if (fresh) setSelected(prev => prev?.recordId === r.recordId ? fresh : prev)
    }).catch(() => {})
  }

  useEffect(() => {
    if (navTarget?.moduleId !== 'rmi' || !navTarget.recordId) return
    const rec = records.find(r => String(r.recordId) === String(navTarget.recordId))
    if (rec) { handleSelect(rec); onClearNav?.(); return }
    let alive = true
    getRecord(LAYOUT, navTarget.recordId).then(d => {
      const r = d?.response?.data?.[0]
      if (alive && r) { handleSelect(r); onClearNav?.() }
    }).catch(() => {})
    return () => { alive = false }
  }, [navTarget, records]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = useCallback((fk, v) => setEdits(p => ({ ...p, [fk]: v })), [])
  const handleDiscard = () => { setEdits({}); setSaveStatus(null); setSaveErrorMsg(null) }

  async function handleSave() {
    const n = Object.keys(edits).length
    if (!n) { return }
    setSaving(true); setSaveStatus(null); setSaveErrorMsg(null)
    try {
      // RMI_New is Vibe-owned (api/_vibeStore.js), so edits go to the overlay
      // rather than back to FileMaker — see RCD_New/Inspections_New/
      // trainings_New for the same pattern.
      await updateVibeRecord(LAYOUT, selected.recordId, edits)
      patchCachedRecord(LAYOUT, CACHE_VERSION, selected.recordId, edits)
      invalidateRecord(LAYOUT, selected.recordId)
      setSelected(prev => ({ ...prev, fieldData: { ...prev.fieldData, ...edits } }))
      setEdits({}); setSaveStatus('saved')
      setTimeout(() => setSaveStatus(null), 2000)
    } catch (e) { setSaveStatus('error'); setSaveErrorMsg(e?.message || null); }
    finally { setSaving(false) }
  }

  // ── Create a new RMI ──
  const createFields = [
    { key: '_kft__Contact_ID', label: 'Contact / Organization', type: 'contact', required: true },
    { key: 'Status',           label: 'Status',           type: 'select', options: ['Active', 'Resolved'], default: 'Active', required: true },
    { key: 'Level_of_Risk',    label: 'Level of Risk',    type: 'select', options: ['High', 'Medium', 'Low'] },
    { key: 'Level_of_Concern', label: 'Level of Concern', type: 'select', options: ['High', 'Medium', 'Low'] },
    { key: 'Assigned_To',      label: 'Assigned To',      type: 'text' },
    { key: 'Staff',            label: 'Staff',            type: 'text' },
    { key: 'Entry_Date',       label: 'Entry Date',       type: 'date', default: new Date().toLocaleDateString('en-US') },
    { key: 'Note_Concern',     label: 'Note of Concern',  type: 'textarea', wide: true },
  ]

  async function handleCreate(fieldData) {
    // Born in Vibe, not FileMaker — see Inspections.jsx's identical pattern.
    // The minted `V-` id IS the record id and the value of _kpt__RMI_ID, so
    // there is no read-back to discover the key, and no per-user FileMaker
    // session required.
    const made = await createVibeRecord(LAYOUT, fieldData)
    const newId = made?.recordId
    if (!newId) throw new Error('Could not create the record')
    const rec = { recordId: newId, fieldData: made.fieldData, portalData: {} }
    addCachedRecord(LAYOUT, CACHE_VERSION, rec)
    handleSelect(rec)
    onRecordSelect?.(rec.recordId, orgName(rec.fieldData))
  }

  const f = selected?.fieldData
  const dirtyCount = Object.keys(edits).length

  return (
    <div className="rmi-container">
      <aside className="rmi-sidebar" style={{ width: navWidth }}>
        <div className="rmi-sidebar-header">
          <div className="rmi-sidebar-title">
            <div>
              <div className="rmi-sidebar-module">Risk Management</div>
              <div className="rmi-sidebar-count">{total ? `${total.toLocaleString()} inquiries` : 'Loading…'}</div>
            </div>
            <button className="rmi-new-btn" onClick={() => setShowNew(true)} title="New inquiry">＋ New</button>
          </div>
          <ListToolbar c={list} unit="inquiries" />
        </div>

        {loading && records.length === 0 ? (
          <div className="rmi-loading">{[...Array(10)].map((_, i) => <div key={i} className="rmi-skeleton" />)}</div>
        ) : error ? (
          <div className="rmi-empty-state"><p>Failed to load records.</p></div>
        ) : (
          <div className="rmi-list">
            <ListBody c={list} activeId={selected?.recordId} renderItem={r => {
              const fd = r.fieldData
              const status = fd.Status || ''
              const color = STATUS_COLOR[status] || STATUS_COLOR.default
              const risk = fd.Level_of_Risk
              return (
                <div key={r.recordId}
                  className={`rmi-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                  onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId, orgName(r.fieldData)) }}>
                  <span className="rmi-item-dot" style={{ background: color }} />
                  <div className="rmi-item-text">
                    <div className="rmi-item-name">{orgName(fd) || '—'}</div>
                    <div className="rmi-item-sub">
                      {fd.zz__Display_Contact__ct && <span>{fd.zz__Display_Contact__ct}</span>}
                      {fd.Entry_Date && <span>{fmtDate(fd.Entry_Date)}</span>}
                    </div>
                  </div>
                  {risk && <span className="rmi-item-risk" style={{ color: LEVEL_COLOR[risk] || '#64748b' }}>{risk}</span>}
                </div>
              )
            }} />
          </div>
        )}
      </aside>

      <div className="rmi-resize-handle" onPointerDown={startPanelResize} />

      <main className="rmi-main">
        {!selected && (
          <div className="rmi-empty-state">
            <div className="rmi-empty-icon">⚠</div>
            <p>Select an inquiry</p>
          </div>
        )}

        {selected && f && (
          <>
            <div className="rmi-topbar">
              <div className="rmi-topbar-left">
                <h1 className="rmi-title">{orgName(f) || '—'}</h1>
                <div className="rmi-meta-row">
                  {(() => {
                    const status = (edits.Status ?? f.Status) || ''
                    const color = STATUS_COLOR[status] || STATUS_COLOR.default
                    return status ? <span className="rmi-chip status" style={{ background: color + '22', color, borderColor: color + '44' }}>{status}</span> : null
                  })()}
                  {(() => {
                    const risk = edits.Level_of_Risk ?? f.Level_of_Risk
                    const color = LEVEL_COLOR[risk] || '#64748b'
                    return risk ? <span className="rmi-chip" style={{ background: color + '22', color, borderColor: color + '44' }}>Risk: {risk}</span> : null
                  })()}
                  {f.zz__Display_Contact__ct && <span className="rmi-chip muted">{f.zz__Display_Contact__ct}</span>}
                  {f._kpt__RMI_ID && <span className="rmi-chip id">#{f._kpt__RMI_ID}</span>}
                </div>
              </div>
              <div className="rmi-topbar-actions">
                <DeleteRecordButton
                  layout={LAYOUT} cacheVersion={CACHE_VERSION}
                  recordId={selected.recordId}
                  name={orgName(f)}
                  onDeleted={() => setSelected(null)}
                />
              </div>
            </div>

            <div className="rmi-content">
              <Section title="Overview" icon="◈">
                <div className="rmi-field-grid">
                  <TextField label="Organization" fieldKey="zz__Display_Organization__ct" f={f} edits={edits} onChange={handleChange} editing={true} editable={false} />
                  <TextField label="Contact" fieldKey="zz__Display_Contact__ct" f={f} edits={edits} onChange={handleChange} editing={true} editable={false} />
                  <TextField label="Site" fieldKey="rmi_CNTCT__site::zz__Display__ct" f={f} edits={edits} onChange={handleChange} editing={true} editable={false} />
                  <TextField label="Site Number" fieldKey="rmi_CNTCT__site::Site Number" f={f} edits={edits} onChange={handleChange} editing={true} editable={false} mono />
                  <LookupField label="Email" value={ci?.email} href={ci?.email ? `mailto:${ci.email}` : null} />
                  <LookupField label="Work Phone" value={ci?.workPhone} href={ci?.workHref} mono />
                  <LookupField label="Mobile Phone" value={ci?.cellPhone} href={ci?.cellHref} mono />
                  <TextField label="RMI #" fieldKey="_kpt__RMI_ID" f={f} edits={edits} onChange={handleChange} editing={true} editable={false} mono />
                </div>
              </Section>

              <Section title="Risk Assessment" icon="⚠">
                <div className="rmi-field-grid">
                  <TextField label="Status" fieldKey="Status" f={f} edits={edits} onChange={handleChange} editing={true} editable />
                  <LevelField label="Level of Risk" fieldKey="Level_of_Risk" f={f} edits={edits} onChange={handleChange} editing={true} />
                  <LevelField label="Level of Concern" fieldKey="Level_of_Concern" f={f} edits={edits} onChange={handleChange} editing={true} />
                  <TextField label="Assigned To" fieldKey="Assigned_To" f={f} edits={edits} onChange={handleChange} editing={true} editable />
                  <TextField label="Staff" fieldKey="Staff" f={f} edits={edits} onChange={handleChange} editing={true} editable />
                  <TextField label="Entry Date" fieldKey="Entry_Date" f={f} edits={edits} onChange={handleChange} editing={true} editable />
                  <TextField label="Date Assigned" fieldKey="Date_Assigned" f={f} edits={edits} onChange={handleChange} editing={true} editable />
                </div>
              </Section>

              <Section title="Concern" icon="❗">
                <div className="rmi-field-grid">
                  <TextField label="Note of Concern" fieldKey="Note_Concern" f={f} edits={edits} onChange={handleChange} editing={true} editable wide textarea />
                </div>
              </Section>

              <Section title="Risk Questions" icon="☑">
                <div className="rmi-q-grid">
                  {RISK_QUESTIONS.map(q => (
                    <QuestionRow key={q.key} label={q.label} fieldKey={q.key} f={f} edits={edits} onChange={handleChange} editing={true} />
                  ))}
                </div>
                {(val(f, edits, 'Question_Text_8') || true) && (
                  <div className="rmi-field-grid bordered">
                    <TextField label="Additional Notes" fieldKey="Question_Text_8" f={f} edits={edits} onChange={handleChange} editing={true} editable wide textarea />
                  </div>
                )}
              </Section>

              <Section title="Follow-Up Log" icon="✎">
                <div className="rmi-field-grid">
                  <TextField label="Follow-Up Notes" fieldKey="Note_Follow_Up" f={f} edits={edits} onChange={handleChange} editing={true} editable wide textarea />
                </div>
              </Section>

              <RecordFooter id={f._kpt__RMI_ID} recordId={selected.recordId} fieldData={f} />
              <RecordSaveBar count={dirtyCount} saving={saving} status={saveStatus} errorMessage={saveErrorMsg} onSave={handleSave} onDiscard={handleDiscard} />
            </div>
          </>
        )}
      </main>

      {showNew && (
        <RecordFormModal
          title="New Risk Management Inquiry"
          fields={createFields}
          submitLabel="Create inquiry"
          onCreate={handleCreate}
          onClose={() => setShowNew(false)}
        />
      )}
    </div>
  )
}
