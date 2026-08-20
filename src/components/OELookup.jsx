import { useState, useEffect, useRef, useCallback } from 'react'
import { getRecord, addCachedRecord } from '../api/filemaker'
import { createVibeRecord } from '../api/vibeRecords'
import { getCurrentEnv } from '../config/fmpEnvironments'
import RecordFormModal from './RecordFormModal'
import { canonicalEnrollment, ENROLLMENT_OPTIONS, OPEN_ENROLLMENT } from '../config/oeEnrollment'
import { BRAND } from '../config/brandColors'
import { useAllRecords } from '../hooks/useAllRecords'
import ListToolbar, { useListControls, ListBody } from './ListControls'
import './OELookup.css'
import DeleteRecordButton from './DeleteRecordButton'

const LAYOUT = 'OELookup_New'
const CACHE_VERSION = 1

const TYPE_COLOR = {
  'Open Enrollment': BRAND.blue,
  'Custom': BRAND.purple,
}

// Look the colour up by the CANONICAL value, not the raw one — 44 records are
// stored as "OPEN ENROLLMENT", "Open Enrollment " or "Open Enrollement" and
// used to fall through to the neutral grey as if they had no type at all.
const typeColor = raw => TYPE_COLOR[canonicalEnrollment(raw)] ?? '#4a5568'

function fmtDate(val) {
  if (!val) return '—'
  // Strip time portion if present
  const d = String(val).split(' ')[0]
  return d || '—'
}

function fmtCurrency(val) {
  const n = parseFloat(String(val).replace(/[^0-9.]/g, ''))
  if (isNaN(n)) return '—'
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function val(f, key) {
  const v = f?.[key]
  return (v === null || v === undefined || v === '') ? '—' : String(v)
}


// Shows the Program Code that WILL be assigned, without consuming it.
//
// Deliberately a separate read-only GET from the POST that issues the code: a
// preview that consumed a number would burn one on every keystroke and on every
// form the user opened and abandoned. Debounced because the lookup scans the
// replica to find the prefix for a Program Type.
function CodePreview({ programType, prefix, startDate }) {
  const [info, setInfo] = useState(null)
  useEffect(() => {
    const type = String(programType ?? '').trim()
    const px = String(prefix ?? '').trim()
    const sd = String(startDate ?? '').trim()
    let alive = true
    // Everything, including clearing, happens inside the timeout — a synchronous
    // setState in an effect body triggers a cascading render.
    const t = setTimeout(() => {
      if (!type && !px) { setInfo(null); return }
      const qs = new URLSearchParams({ db: getCurrentEnv().db })
      if (px) qs.set('prefix', px)
      else qs.set('programType', type)
      if (sd) qs.set('startDate', sd)
      fetch(`/api/program-code?${qs}`, { credentials: 'include' })
        .then(r => r.json())
        .then(j => { if (alive) setInfo(j) })
        .catch(() => { if (alive) setInfo(null) })
    }, 400)
    return () => { alive = false; clearTimeout(t) }
  }, [programType, prefix, startDate])

  if (!info) return null
  if (info.newType) return (
    <div className="oe-code-preview warn">
      No existing program uses that type, so there is no code prefix to follow.
      Enter one above (e.g. <code>AB</code>) and the first code will be
      <code>{` AB-${info.year}-1`}</code>.
    </div>
  )
  return (
    <div className="oe-code-preview">
      Program Code will be <strong>{info.preview}</strong>
      <span className="oe-code-note">
        {' '}— the {info.year} series for {info.prefix}. Assigned on save, so it cannot
        collide with anyone else&apos;s.
      </span>
    </div>
  )
}

export default function OELookup({ navTarget, onClearNav, onRecordSelect } = {}) {
  const { records, total, loading, error } = useAllRecords(LAYOUT, { cacheVersion: CACHE_VERSION })

  const controls = useListControls({
    records,
    storageKey: 'oe-lookup',
    name: f => f['Program Type'],
    searchKeys: ['Program Type', 'Program Code', 'Lead Facilitator', 'Co Trainer 1', 'Co Trainer 2', 'Custom Site:'],
    chips: [
      // Measured 2026-08-19: exact-equality matching missed 44 of 1,117
      // open-enrollment programs, because the field is free text with no value
      // list and holds five spellings of two concepts.
      { id: 'oe',     label: 'Open Enrollment', match: f => canonicalEnrollment(f['Open Enrollment or Custom']) === OPEN_ENROLLMENT },
      { id: 'custom', label: 'Custom',           match: f => canonicalEnrollment(f['Open Enrollment or Custom']) === 'Custom' },
    ],
    sorts: [
      { id: 'date',  label: 'Start date', value: f => f['Program Start Date'] ?? '' },
      { id: 'type',  label: 'Program type', value: f => f['Program Type'] ?? '' },
      { id: 'lead',  label: 'Lead facilitator', value: f => f['Lead Facilitator'] ?? '' },
      { id: 'code',  label: 'Program code', value: f => f['Program Code'] ?? '' },
    ],
    defaultSort: 'date', defaultOrder: 'desc',
  })

  const [selected, setSelected] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(300)
  const dragging = useRef(false)

  async function handleSelect(r) {
    setSelected(r)
    getRecord(LAYOUT, r.recordId).then(detail => {
      const fresh = detail?.response?.data?.[0]
      if (fresh) setSelected(fresh)
    }).catch(() => {})
  }

  // Deep-link / navTarget
  useEffect(() => {
    if (!navTarget || navTarget.moduleId !== 'oe-lookup') return
    const rec = controls.processed.find(r => String(r.recordId) === String(navTarget.recordId))
    if (rec) { handleSelect(rec); onClearNav?.(); return }
    let alive = true
    getRecord(LAYOUT, navTarget.recordId).then(d => {
      const r = d?.response?.data?.[0]
      if (alive && r) { handleSelect(r); onClearNav?.(); }
    }).catch(() => {})
    return () => { alive = false }
  }, [navTarget])

  // Resize handle
  const onMouseDown = useCallback(e => {
    dragging.current = true
    const startX = e.clientX
    const startW = sidebarWidth
    const onMove = ev => {
      if (!dragging.current) return
      setSidebarWidth(Math.max(220, Math.min(520, startW + ev.clientX - startX)))
    }
    const onUp = () => { dragging.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [sidebarWidth])

  // ── Create a new program ──
  //
  // `__prefix` is NOT a FileMaker field. It only matters when the Program Type
  // is one nobody has used before, so there is no existing code to take a
  // prefix from; handleCreate strips it before writing.
  const createFields = [
    { key: 'Program Type',              label: 'Program Type', type: 'text', required: true, wide: true,
      placeholder: 'e.g. Adventure Basics' },
    { key: '__prefix',                  label: 'Code prefix (only for a brand-new program type)', type: 'text',
      placeholder: 'e.g. AB' },
    { key: 'Open Enrollment or Custom', label: 'Open Enrollment or Custom', type: 'select',
      options: ENROLLMENT_OPTIONS, default: OPEN_ENROLLMENT, required: true },
    { key: 'Program Start Date',        label: 'Start date', type: 'date' },
    { key: 'Program End Date',          label: 'End date',   type: 'date' },
    { key: 'Program Start Time',        label: 'Start time', type: 'text', placeholder: 'e.g. 9:00 AM' },
    { key: 'Program End Time',          label: 'End time',   type: 'text', placeholder: 'e.g. 4:00 PM' },
    { key: 'Hours',                     label: 'Hours',      type: 'text' },
    { key: 'Lead Facilitator',          label: 'Lead facilitator', type: 'text' },
    { key: 'Co Trainer 1',              label: 'Co-trainer 1', type: 'text' },
    { key: 'Co Trainer 2',              label: 'Co-trainer 2', type: 'text' },
    { key: 'Custom Site:',              label: 'Custom site',  type: 'text' },
    { key: 'Tuition',                   label: 'Tuition', type: 'number', step: '0.01' },
    { key: 'Food',                      label: 'Food',    type: 'number', step: '0.01' },
    { key: 'Lodging',                   label: 'Lodging', type: 'number', step: '0.01' },
    { key: "Facilitator's Notes",       label: "Facilitator's notes", type: 'textarea', wide: true },
  ]

  async function handleCreate(fieldData) {
    const { __prefix, ...fields } = fieldData

    // Take the number FIRST. If this fails the record is never created, which
    // is the right way round — a program with no code is worse than no program.
    const res = await fetch(`/api/program-code?db=${encodeURIComponent(getCurrentEnv().db)}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(__prefix ? { prefix: __prefix } : { programType: fields['Program Type'] }),
        // The sequence restarts each calendar year and is scoped to the
        // PROGRAM's year, not today's — 37 programs starting in 2027 already
        // exist, and one entered now belongs in the 2027 series.
        startDate: fields['Program Start Date'] || '',
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.code) {
      throw new Error(body.error === 'no prefix for that Program Type — supply one'
        ? 'That Program Type is new, so there is no code prefix to follow. Enter one in "Code prefix".'
        : (body.error || 'Could not assign a Program Code.'))
    }

    // Write the canonical spelling, so the five-variant mess stops growing.
    const made = await createVibeRecord(LAYOUT, {
      ...fields,
      'Program Code': body.code,
      'Open Enrollment or Custom': canonicalEnrollment(fields['Open Enrollment or Custom']),
    })
    const newId = made?.recordId
    if (!newId) throw new Error('Could not create the record')
    const rec = { recordId: newId, fieldData: made.fieldData, portalData: {} }
    addCachedRecord(LAYOUT, CACHE_VERSION, rec)
    handleSelect(rec)
    onRecordSelect?.(rec.recordId, rec.fieldData?.['Program Type'])
  }

  const f = selected?.fieldData ?? {}
  const oeType = canonicalEnrollment(f['Open Enrollment or Custom'])
  const tuition = parseFloat(String(f['Tuition'] ?? '').replace(/[^0-9.]/g, '')) || 0
  const food    = parseFloat(String(f['Food']    ?? '').replace(/[^0-9.]/g, '')) || 0
  const lodging = parseFloat(String(f['Lodging'] ?? '').replace(/[^0-9.]/g, '')) || 0
  const totalCost = tuition + food + lodging

  return (
    <div className="oe-container">
      {/* Sidebar */}
      <aside className="oe-sidebar" style={{ width: sidebarWidth }}>
        <div className="oe-sidebar-header">
          <div className="oe-sidebar-title">
            <div>
              <div className="oe-sidebar-module">OE Lookup</div>
              <div className="oe-sidebar-count">{loading ? 'Loading…' : `${total.toLocaleString()} programs`}</div>
            </div>
            <button className="oe-new-btn" onClick={() => setShowNew(true)}>＋ New</button>
          </div>
          <ListToolbar c={controls} />
        </div>

        {loading && controls.processed.length === 0 ? (
          <div className="oe-loading">{Array.from({ length: 12 }, (_, i) => <div key={i} className="oe-skeleton" />)}</div>
        ) : error ? (
          <div className="oe-empty-state"><p>Failed to load records.</p></div>
        ) : (
          // ListBody returns a bare ARRAY with no wrapper, so the scrolling
          // container comes from here — otherwise the sidebar clips the list at
          // the fold with no way to reach the rest.
          <div className="oe-list">
            <ListBody c={controls} activeId={selected?.recordId} renderItem={r => (
            <div key={r.recordId}
              className={`oe-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
              onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId, r.fieldData?.['Program Type']); }}>
              <div className="oe-item-dot" style={{ background: typeColor(r.fieldData?.['Open Enrollment or Custom']) }} />
              <div className="oe-item-text">
                <div className="oe-item-name">{r.fieldData?.['Program Type'] || '—'}</div>
                <div className="oe-item-sub">{r.fieldData?.['Program Code']} · {fmtDate(r.fieldData?.['Program Start Date'])}</div>
              </div>
            </div>
            )} />
          </div>
        )}
      </aside>

      <div className="oe-resize-handle" onMouseDown={onMouseDown} />

      {/* Main */}
      <main className="oe-main">
        {!selected ? (
          <div className="oe-empty-state">
            <div className="oe-empty-icon">◎</div>
            <p>Select a program</p>
          </div>
        ) : (
          <>
            {/* Top bar */}
            <div className="oe-topbar">
              <div className="oe-topbar-left">
                <div>
                  <h1 className="oe-title">{val(f, 'Program Type')}</h1>
                  <div className="oe-meta-row">
                    <span className="oe-chip type">{val(f, 'Program Code')}</span>
                    {oeType && (
                      <span className={`oe-chip ${oeType === OPEN_ENROLLMENT ? 'oe' : 'custom'}`}>
                        {oeType}
                      </span>
                    )}
                    {f['Program Start Date'] && (
                      <span className="oe-chip muted">
                        {fmtDate(f['Program Start Date'])} – {fmtDate(f['Program End Date'])}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="oe-topbar-actions">
                <DeleteRecordButton
                  layout={LAYOUT} cacheVersion={CACHE_VERSION}
                  recordId={selected.recordId}
                  name={val(f, 'Program Type')}
                  onDeleted={() => setSelected(null)}
                />
              </div>
            </div>

            {/* Content */}
            <div className="oe-content">

              {/* Program */}
              <div className="oe-section">
                <div className="oe-section-header">
                  <span className="oe-section-icon">◎</span>
                  <h3>Program</h3>
                </div>
                <div className="oe-field-grid">
                  <div className="oe-field">
                    <label>Program Code</label>
                    <div className="oe-value">{val(f, 'Program Code')}</div>
                  </div>
                  <div className="oe-field">
                    <label>Program Type</label>
                    <div className="oe-value">{val(f, 'Program Type')}</div>
                  </div>
                  <div className="oe-field">
                    <label>OE / Custom</label>
                    <div className="oe-value">{val(f, 'Open Enrollment or Custom')}</div>
                  </div>
                  <div className="oe-field">
                    <label>Site</label>
                    <div className="oe-value">{val(f, 'Custom Site:')}</div>
                  </div>
                  <div className="oe-field">
                    <label>Start Date</label>
                    <div className="oe-value">{fmtDate(f['Program Start Date'])}</div>
                  </div>
                  <div className="oe-field">
                    <label>Start Time</label>
                    <div className="oe-value">{val(f, 'Program Start Time')}</div>
                  </div>
                  <div className="oe-field">
                    <label>End Date</label>
                    <div className="oe-value">{fmtDate(f['Program End Date'])}</div>
                  </div>
                  <div className="oe-field">
                    <label>End Time</label>
                    <div className="oe-value">{val(f, 'Program End Time')}</div>
                  </div>
                  <div className="oe-field">
                    <label>Hours</label>
                    <div className="oe-value">{val(f, 'Hours')}</div>
                  </div>
                </div>
              </div>

              {/* Staff */}
              <div className="oe-section">
                <div className="oe-section-header">
                  <span className="oe-section-icon">◉</span>
                  <h3>Staff</h3>
                </div>
                <div className="oe-field-grid">
                  <div className="oe-field">
                    <label>Lead Facilitator</label>
                    <div className="oe-value">{val(f, 'Lead Facilitator')}</div>
                  </div>
                  <div className="oe-field">
                    <label>Co Trainer 1</label>
                    <div className="oe-value">{val(f, 'Co Trainer 1')}</div>
                  </div>
                  <div className="oe-field">
                    <label>Co Trainer 2</label>
                    <div className="oe-value">{val(f, 'Co Trainer 2')}</div>
                  </div>
                </div>
              </div>

              {/* Financials */}
              <div className="oe-section">
                <div className="oe-section-header">
                  <span className="oe-section-icon">$</span>
                  <h3>Financials</h3>
                </div>
                <div className="oe-fin-grid">
                  <div className="oe-fin-cell">
                    <label>Tuition</label>
                    <div className="oe-fin-amount">{fmtCurrency(f['Tuition'])}</div>
                  </div>
                  <div className="oe-fin-cell">
                    <label>Food</label>
                    <div className="oe-fin-amount">{fmtCurrency(f['Food'])}</div>
                  </div>
                  <div className="oe-fin-cell">
                    <label>Lodging</label>
                    <div className="oe-fin-amount">{fmtCurrency(f['Lodging'])}</div>
                  </div>
                  <div className="oe-fin-cell total">
                    <label>Total</label>
                    <div className="oe-fin-amount">{fmtCurrency(totalCost)}</div>
                  </div>
                </div>
              </div>

              {/* Notes */}
              {f["Facilitator's Notes"] && (
                <div className="oe-section">
                  <div className="oe-section-header">
                    <span className="oe-section-icon">✎</span>
                    <h3>Facilitator's Notes</h3>
                  </div>
                  <div className="oe-field-grid">
                    <div className="oe-field wide">
                      <div className="oe-value">{f["Facilitator's Notes"]}</div>
                    </div>
                  </div>
                </div>
              )}

              <div className="oe-record-footer">ID {val(f, 'Program Code')} · Record {selected.recordId} · Created {f.zz__Created_On?.split(' ')[0] || '—'} by {f.zz__Created_By || '—'} · Modified {f.zz__Modified_On?.split(' ')[0] || '—'} by {f.zz__Modified_By || '—'}</div>
            </div>
          </>
        )}
      </main>

      {showNew && (
        <RecordFormModal
          title="New OE program"
          fields={createFields}
          submitLabel="Create program"
          onCreate={handleCreate}
          onClose={() => setShowNew(false)}>
          {values => (
            <CodePreview programType={values['Program Type']} prefix={values.__prefix}
              startDate={values['Program Start Date']} />
          )}
        </RecordFormModal>
      )}
    </div>
  )
}
