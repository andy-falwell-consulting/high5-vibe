import { useState, useEffect } from 'react'
import { getRecord, addCachedRecord } from '../api/filemaker'
import { createVibeRecord } from '../api/vibeRecords'
import { getCurrentEnv } from '../config/fmpEnvironments'
import RecordFormModal from './RecordFormModal'
import { canonicalEnrollment, ENROLLMENT_OPTIONS, OPEN_ENROLLMENT } from '../config/oeEnrollment'
import { useAllRecords } from '../hooks/useAllRecords'
import ListToolbar, { useListControls, ListBody } from './ListControls'
import './OELookup.css'
import DeleteRecordButton from './DeleteRecordButton'
import ReminderModal from './ReminderModal'
import RecordFooter from './RecordFooter';
import { useRecordPanel } from '../hooks/useRecordPanel';

const LAYOUT = 'OELookup_New'
const CACHE_VERSION = 1

// Look the colour up by the CANONICAL value, not the raw one — 44 records are
// stored as "OPEN ENROLLMENT", "Open Enrollment " or "Open Enrollement" and
// used to fall through to the neutral grey as if they had no type at all.
// A class rather than an inline colour: .h5-dot--* resolves to the category
// -solid token, which is what keeps the two kinds apart in dark mode. An inline
// hex cannot switch with the theme.
const dotClass = raw => {
  const v = canonicalEnrollment(raw)
  return v === OPEN_ENROLLMENT ? 'h5-dot--blue' : v === 'Custom' ? 'h5-dot--purple' : ''
}

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
    <div className="h5-callout h5-callout--warning oe-code-preview">
      No existing program uses that type, so there is no code prefix to follow.
      Enter one above (e.g. <code>AB</code>) and the first code will be
      <code>{` AB-${info.year}-1`}</code>.
    </div>
  )
  return (
    <div className="h5-callout h5-callout--info oe-code-preview">
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
  const [remindOpen, setRemindOpen] = useState(false)
  const [showNew, setShowNew] = useState(false)
  // Width, drag and memory come from useRecordPanel — see the hook for what
  // the twelve hand-rolled copies had drifted into.
  const { width: sidebarWidth, onPointerDown: startPanelResize } = useRecordPanel('oe-lookup', 300);

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
    <div className="h5-module oe-container">
      {/* Sidebar */}
      <aside className="h5-sidebar" style={{ width: sidebarWidth }}>
        <div className="h5-sidebar__head">
          <div className="oe-sidebar-title">
            <div>
              <div className="oe-sidebar-module">OE Lookup</div>
              <div className="oe-sidebar-count">{loading ? 'Loading…' : `${total.toLocaleString()} programs`}</div>
            </div>
            <button className="h5-btn h5-btn--primary h5-btn--sm" onClick={() => setShowNew(true)}>＋ New</button>
          </div>
          <ListToolbar c={controls} />
        </div>

        {loading && controls.processed.length === 0 ? (
          <div className="oe-loading">{Array.from({ length: 12 }, (_, i) => <div key={i} className="h5-skeleton h5-skeleton--row" />)}</div>
        ) : error ? (
          <div className="h5-empty h5-empty--error"><div className="h5-empty__icon">×</div><p className="h5-empty__title">Failed to load</p><p className="h5-empty__body">The program list could not be read.</p></div>
        ) : (
          // ListBody returns a bare ARRAY with no wrapper, so the scrolling
          // container comes from here — otherwise the sidebar clips the list at
          // the fold with no way to reach the rest.
          <div className="h5-sidebar__list h5-scroll">
            <ListBody c={controls} activeId={selected?.recordId} renderItem={r => (
            <div key={r.recordId}
              className={`h5-list-item${selected?.recordId === r.recordId ? ' h5-list-item--active' : ''}`}
              onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId, r.fieldData?.['Program Type']); }}>
              <span className={`h5-dot ${dotClass(r.fieldData?.['Open Enrollment or Custom'])}`} />
              <div className="h5-list-item__body">
                <div className="h5-list-item__title">{r.fieldData?.['Program Type'] || '—'}</div>
                <div className="h5-list-item__sub">{r.fieldData?.['Program Code']} · {fmtDate(r.fieldData?.['Program Start Date'])}</div>
              </div>
            </div>
            )} />
          </div>
        )}
      </aside>

      <div className="h5-resize" onPointerDown={startPanelResize} />

      {/* Main */}
      <main className="h5-detail">
        {!selected ? (
          <div className="h5-empty">
            <div className="h5-empty__icon">◎</div>
            <p className="h5-empty__title">Select a program</p>
            <p className="h5-empty__body">Choose one from the list to see its details.</p>
          </div>
        ) : (
          <>
            {/* Top bar */}
            <div className="h5-page-header">
              {/* __row is what makes this a ROW. .h5-page-header on its own is
                  just a padded block, so an actions div inside it stacks under
                  the title at full width instead of sitting top-right. Both OE
                  pages were missing this wrapper, which is the whole difference
                  from every other record page. */}
              <div className="h5-page-header__row">
              <div className="oe-topbar-left">
                <div>
                  <h1 className="h5-page-header__title">{val(f, 'Program Type')}</h1>
                  <div className="h5-page-header__meta">
                    <span className="h5-badge h5-badge--blue">{val(f, 'Program Code')}</span>
                    {oeType && (
                      <span className={`h5-badge ${oeType === OPEN_ENROLLMENT ? 'h5-badge--blue' : 'h5-badge--purple'}`}>
                        {oeType}
                      </span>
                    )}
                    {f['Program Start Date'] && (
                      <span className="h5-badge">
                        {fmtDate(f['Program Start Date'])} – {fmtDate(f['Program End Date'])}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="h5-page-header__actions">
                <button className="h5-btn h5-btn--quiet h5-btn--sm" onClick={() => setRemindOpen(true)}>⏰ Remind</button>
                <DeleteRecordButton
                  layout={LAYOUT} cacheVersion={CACHE_VERSION}
                  recordId={selected.recordId}
                  name={val(f, 'Program Type')}
                  onDeleted={() => setSelected(null)}
                />
              </div>
              </div>
            </div>

            {/* Content */}
            <div className="h5-detail__body h5-scroll">

              {/* Program */}
              <div className="h5-card h5-card--flush oe-section">
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
              <div className="h5-card h5-card--flush oe-section">
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
              <div className="h5-card h5-card--flush oe-section">
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
                <div className="h5-card h5-card--flush oe-section">
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

              <RecordFooter id={val(f, 'Program Code')} recordId={selected.recordId} fieldData={f} />
            </div>
          </>
        )}
      </main>

      {remindOpen && selected && (
        <ReminderModal
          initial={{
            recordType: 'oe-lookup',
            recordId: selected.recordId,
            recordLabel: val(f, 'Program Type') || val(f, 'Program Code'),
            title: `Follow up on ${val(f, 'Program Type') || val(f, 'Program Code')}`,
          }}
          onClose={() => setRemindOpen(false)}
          onSaved={() => setRemindOpen(false)} />
      )}

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
