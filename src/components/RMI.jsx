import { useState, useCallback, useRef, useEffect } from 'react'
import { getRecord, updateRecord, invalidateRecord, patchCachedRecord } from '../api/filemaker'
import { useAllRecords } from '../hooks/useAllRecords'
import ListToolbar, { useListControls, ListBody } from './ListControls'
import './RMI.css'

const LAYOUT = 'RMI_New'
const CACHE_VERSION = 1

const STATUS_COLOR = {
  Active:   '#e8322a',
  Resolved: '#22c55e',
  default:  '#64748b',
}

const LEVEL_COLOR = {
  High:   '#e8322a',
  Medium: '#f59e0b',
  Low:    '#22c55e',
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
  const [navWidth, setNavWidth] = useState(300)
  const [editing, setEditing] = useState(false)
  const [edits, setEdits] = useState({})
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState(null)
  const isResizing = useRef(false)

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
    setEdits({}); setEditing(false); setSaveStatus(null)
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
  const handleDiscard = () => { setEdits({}); setEditing(false); setSaveStatus(null) }

  async function handleSave() {
    const n = Object.keys(edits).length
    if (!n) { setEditing(false); return }
    setSaving(true); setSaveStatus(null)
    try {
      await updateRecord(LAYOUT, selected.recordId, edits)
      patchCachedRecord(LAYOUT, CACHE_VERSION, selected.recordId, edits)
      invalidateRecord(LAYOUT, selected.recordId)
      setSelected(prev => ({ ...prev, fieldData: { ...prev.fieldData, ...edits } }))
      setEdits({}); setEditing(false); setSaveStatus('saved')
      setTimeout(() => setSaveStatus(null), 2000)
    } catch { setSaveStatus('error') }
    finally { setSaving(false) }
  }

  const startResize = useCallback((e) => {
    e.preventDefault()
    isResizing.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const startX = e.clientX
    const startW = navWidth
    const onMove = (e) => {
      if (!isResizing.current) return
      setNavWidth(Math.min(520, Math.max(220, startW + (e.clientX - startX))))
    }
    const onUp = () => {
      isResizing.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [navWidth])

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
          </div>
          <ListToolbar c={list} unit="inquiries" />
        </div>

        {loading && records.length === 0 ? (
          <div className="rmi-loading">{[...Array(10)].map((_, i) => <div key={i} className="rmi-skeleton" />)}</div>
        ) : error ? (
          <div className="rmi-empty-state"><p>Failed to load records.</p></div>
        ) : (
          <div className="rmi-list">
            <ListBody c={list} renderItem={r => {
              const fd = r.fieldData
              const status = fd.Status || ''
              const color = STATUS_COLOR[status] || STATUS_COLOR.default
              const risk = fd.Level_of_Risk
              return (
                <div key={r.recordId}
                  className={`rmi-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                  onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId) }}>
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

      <div className="rmi-resize-handle" onMouseDown={startResize} />

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
                {saveStatus === 'saved' && <span className="rmi-status saved">✓ Saved</span>}
                {saveStatus === 'error' && <span className="rmi-status error">✗ Failed</span>}
                {!editing ? (
                  <button className="rmi-btn-edit" onClick={() => setEditing(true)}>✎ Edit</button>
                ) : (
                  <>
                    <button className="rmi-btn-discard" onClick={handleDiscard} disabled={saving}>Discard</button>
                    <button className="rmi-btn-save" onClick={handleSave} disabled={saving || dirtyCount === 0}>
                      {saving ? 'Saving…' : dirtyCount ? `Save ${dirtyCount} change${dirtyCount > 1 ? 's' : ''}` : 'Save'}
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="rmi-content">
              <Section title="Overview" icon="◈">
                <div className="rmi-field-grid">
                  <TextField label="Organization" fieldKey="zz__Display_Organization__ct" f={f} edits={edits} onChange={handleChange} editing={editing} editable={false} />
                  <TextField label="Contact" fieldKey="zz__Display_Contact__ct" f={f} edits={edits} onChange={handleChange} editing={editing} editable={false} />
                  <TextField label="Site" fieldKey="rmi_CNTCT__site::zz__Display__ct" f={f} edits={edits} onChange={handleChange} editing={editing} editable={false} />
                  <TextField label="Site Number" fieldKey="rmi_CNTCT__site::Site Number" f={f} edits={edits} onChange={handleChange} editing={editing} editable={false} mono />
                  <TextField label="Email" fieldKey="rmi_cntct_INADR__emailIndividual::zz__Address__ct" f={f} edits={edits} onChange={handleChange} editing={editing} editable={false} />
                  <TextField label="Work Phone" fieldKey="rmi_cntct_PHONE__workIndividual::Number" f={f} edits={edits} onChange={handleChange} editing={editing} editable={false} />
                  <TextField label="Mobile Phone" fieldKey="rmi_cntct_PHONE__mobileIndividual::Number" f={f} edits={edits} onChange={handleChange} editing={editing} editable={false} />
                  <TextField label="RMI #" fieldKey="_kpt__RMI_ID" f={f} edits={edits} onChange={handleChange} editing={editing} editable={false} mono />
                </div>
              </Section>

              <Section title="Risk Assessment" icon="⚠">
                <div className="rmi-field-grid">
                  <TextField label="Status" fieldKey="Status" f={f} edits={edits} onChange={handleChange} editing={editing} editable />
                  <LevelField label="Level of Risk" fieldKey="Level_of_Risk" f={f} edits={edits} onChange={handleChange} editing={editing} />
                  <LevelField label="Level of Concern" fieldKey="Level_of_Concern" f={f} edits={edits} onChange={handleChange} editing={editing} />
                  <TextField label="Assigned To" fieldKey="Assigned_To" f={f} edits={edits} onChange={handleChange} editing={editing} editable />
                  <TextField label="Staff" fieldKey="Staff" f={f} edits={edits} onChange={handleChange} editing={editing} editable />
                  <TextField label="Entry Date" fieldKey="Entry_Date" f={f} edits={edits} onChange={handleChange} editing={editing} editable />
                  <TextField label="Date Assigned" fieldKey="Date_Assigned" f={f} edits={edits} onChange={handleChange} editing={editing} editable />
                </div>
              </Section>

              <Section title="Concern" icon="❗">
                <div className="rmi-field-grid">
                  <TextField label="Note of Concern" fieldKey="Note_Concern" f={f} edits={edits} onChange={handleChange} editing={editing} editable wide textarea />
                </div>
              </Section>

              <Section title="Risk Questions" icon="☑">
                <div className="rmi-q-grid">
                  {RISK_QUESTIONS.map(q => (
                    <QuestionRow key={q.key} label={q.label} fieldKey={q.key} f={f} edits={edits} onChange={handleChange} editing={editing} />
                  ))}
                </div>
                {(val(f, edits, 'Question_Text_8') || editing) && (
                  <div className="rmi-field-grid bordered">
                    <TextField label="Additional Notes" fieldKey="Question_Text_8" f={f} edits={edits} onChange={handleChange} editing={editing} editable wide textarea />
                  </div>
                )}
              </Section>

              <Section title="Follow-Up Log" icon="✎">
                <div className="rmi-field-grid">
                  <TextField label="Follow-Up Notes" fieldKey="Note_Follow_Up" f={f} edits={edits} onChange={handleChange} editing={editing} editable wide textarea />
                </div>
              </Section>

              <div className="rmi-record-footer">
                ID {f._kpt__RMI_ID || '—'} · Record {selected.recordId} · Created {f.zz__Created_On?.split(' ')[0] || '—'} by {f.zz__Created_By || '—'} · Modified {f.zz__Modified_On?.split(' ')[0] || '—'} by {f.zz__Modified_By || '—'}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
