import { useState, useEffect, useRef, useCallback } from 'react'
import { getRecord } from '../api/filemaker'
import { useAllRecords } from '../hooks/useAllRecords'
import ListToolbar, { useListControls, ListBody } from './ListControls'
import './OELookup.css'

const LAYOUT = 'OELookup_New'
const CACHE_VERSION = 1

const TYPE_COLOR = {
  'Open Enrollment': '#4ade80',
  'Custom': '#c084fc',
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

export default function OELookup({ navTarget, onClearNav, onRecordSelect } = {}) {
  const { records, total, loading, error } = useAllRecords(LAYOUT, { cacheVersion: CACHE_VERSION })

  const controls = useListControls({
    records,
    storageKey: 'oe-lookup',
    name: f => f['Program Type'],
    searchKeys: ['Program Type', 'Program Code', 'Lead Facilitator', 'Co Trainer 1', 'Co Trainer 2', 'Custom Site:'],
    chips: [
      { id: 'oe',     label: 'Open Enrollment', match: f => f['Open Enrollment or Custom'] === 'Open Enrollment' },
      { id: 'custom', label: 'Custom',           match: f => f['Open Enrollment or Custom'] === 'Custom' },
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

  const f = selected?.fieldData ?? {}
  const oeType = f['Open Enrollment or Custom']
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
          </div>
          <ListToolbar c={controls} />
        </div>

        {loading && controls.processed.length === 0 ? (
          <div className="oe-loading">{Array.from({ length: 12 }, (_, i) => <div key={i} className="oe-skeleton" />)}</div>
        ) : error ? (
          <div className="oe-empty-state"><p>Failed to load records.</p></div>
        ) : (
          <ListBody c={controls} renderItem={r => (
            <div key={r.recordId}
              className={`oe-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
              onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId, r.fieldData?.['Program Type']); }}>
              <div className="oe-item-dot" style={{ background: TYPE_COLOR[r.fieldData?.['Open Enrollment or Custom']] ?? '#4a5568' }} />
              <div className="oe-item-text">
                <div className="oe-item-name">{r.fieldData?.['Program Type'] || '—'}</div>
                <div className="oe-item-sub">{r.fieldData?.['Program Code']} · {fmtDate(r.fieldData?.['Program Start Date'])}</div>
              </div>
            </div>
          )} />
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
                      <span className={`oe-chip ${oeType === 'Open Enrollment' ? 'oe' : 'custom'}`}>
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
    </div>
  )
}
