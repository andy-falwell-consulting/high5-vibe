import { useState, useEffect, useRef, useCallback } from 'react'
import { getRecord, updateRecord, invalidateRecord, patchCachedRecord } from '../api/filemaker'
import { useAllRecords } from '../hooks/useAllRecords'
import ListToolbar, { useListControls, ListBody } from './ListControls'
import './Estimates.css'

const LAYOUT = 'Estimates_New'
const CACHE_VERSION = 1

const STATUS_COLOR = {
  'Draft':       '#64748b',
  'Sent':        '#3b82f6',
  'Approved':    '#22c55e',
  'Declined':    '#e8322a',
  'Expired':     '#f59e0b',
  'Mandatory':   '#c084fc',
  'Recommended': '#06b6d4',
}

const TYPE_COLOR = {
  'New Build': '#c084fc',
  'Repair':    '#fb923c',
}

function fmtCurrency(val) {
  const n = parseFloat(String(val ?? '').replace(/[^0-9.-]/g, ''))
  if (isNaN(n) || val === '' || val == null) return '—'
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDate(val) {
  if (!val) return '—'
  return String(val).split(' ')[0] || '—'
}

const fv = (f, edits, key) => (key in edits ? edits[key] : f?.[key])
const isDirty = (f, edits, key) => key in edits && edits[key] !== (f?.[key] ?? '')

function Field({ label, fk, f, edits, onChange, editing, editable = true, wide, mono, textarea }) {
  const val = fv(f, edits, fk)
  const dirty = isDirty(f, edits, fk)
  return (
    <div className={`est-field${wide ? ' wide' : ''}`}>
      <label>{label}{dirty && <span className="est-dirty" />}</label>
      {editing && editable ? (
        textarea
          ? <textarea className="est-input est-textarea" value={val || ''} onChange={e => onChange(fk, e.target.value)} rows={4} />
          : <input className="est-input" value={val || ''} onChange={e => onChange(fk, e.target.value)} />
      ) : (
        <span className={`est-value${mono ? ' mono' : ''}`}>{val || '—'}</span>
      )}
    </div>
  )
}

function Section({ title, icon, children }) {
  return (
    <div className="est-section">
      <div className="est-section-header">
        <span className="est-section-icon">{icon}</span>
        <h3>{title}</h3>
      </div>
      {children}
    </div>
  )
}

export default function Estimates({ navTarget, onClearNav, onRecordSelect } = {}) {
  const { records, total, loading, error } = useAllRecords(LAYOUT, { cacheVersion: CACHE_VERSION })
  const [selected, setSelected] = useState(null)
  const [sidebarWidth, setSidebarWidth] = useState(300)
  const [editing, setEditing] = useState(false)
  const [edits, setEdits] = useState({})
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState(null)
  const dragging = useRef(false)

  const controls = useListControls({
    records,
    storageKey: 'estimates',
    name: f => f.zz__Display_Contact__ct || '',
    searchKeys: ['zz__Display_Contact__ct', 'Title', '_kpt__Estimate_ID', 'Status', 'Class'],
    chips: [
      { id: 'draft',       label: 'Draft',       match: f => f.Status === 'Draft' },
      { id: 'recommended', label: 'Recommended', match: f => f.Status === 'Recommended' },
      { id: 'mandatory',   label: 'Mandatory',   match: f => f.Status === 'Mandatory' },
      { id: 'approved',    label: 'Approved',    match: f => f.Status === 'Approved' },
    ],
    sorts: [
      { id: 'date',   label: 'Date',    value: f => f.Date ?? '' },
      { id: 'client', label: 'Client',  value: f => f.zz__Display_Contact__ct ?? '' },
      { id: 'total',  label: 'Total',   value: f => parseFloat(String(f.zz__Total__xn ?? '').replace(/[^0-9.-]/g, '')) || 0 },
      { id: 'status', label: 'Status',  value: f => f.Status ?? '' },
    ],
    defaultSort: 'date', defaultOrder: 'desc',
  })

  async function handleSelect(r) {
    setEdits({}); setEditing(false); setSaveStatus(null)
    setSelected(r)
    getRecord(LAYOUT, r.recordId).then(d => {
      const fresh = d?.response?.data?.[0]
      if (fresh) setSelected(fresh)
    }).catch(() => {})
  }

  useEffect(() => {
    if (!navTarget || navTarget.moduleId !== 'estimates') return
    const rec = controls.processed.find(r => String(r.recordId) === String(navTarget.recordId))
    if (rec) { handleSelect(rec); onClearNav?.(); return }
    let alive = true
    getRecord(LAYOUT, navTarget.recordId).then(d => {
      const r = d?.response?.data?.[0]
      if (alive && r) { handleSelect(r); onClearNav?.() }
    }).catch(() => {})
    return () => { alive = false }
  }, [navTarget]) // eslint-disable-line react-hooks/exhaustive-deps

  const onMouseDown = useCallback(e => {
    dragging.current = true
    const startX = e.clientX, startW = sidebarWidth
    const onMove = ev => { if (!dragging.current) return; setSidebarWidth(Math.max(220, Math.min(520, startW + ev.clientX - startX))) }
    const onUp = () => { dragging.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [sidebarWidth])

  const handleChange = useCallback((fk, val) => setEdits(p => ({ ...p, [fk]: val })), [])
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

  const f = selected?.fieldData ?? {}
  const p = selected?.portalData
  const lineItems = p?.estmt_ESTLI || []
  const dirtyCount = Object.keys(edits).length

  const displayTotal = parseFloat(String(f.zz__Total__xn ?? '').replace(/[^0-9.-]/g, '')) || 0
  const status = f.Status || ''
  const statusColor = STATUS_COLOR[status] ?? '#64748b'

  return (
    <div className="est-container">
      <aside className="est-sidebar" style={{ width: sidebarWidth }}>
        <div className="est-sidebar-header">
          <div>
            <div className="est-sidebar-module">Estimates</div>
            <div className="est-sidebar-count">{loading ? 'Loading…' : `${total.toLocaleString()} estimates`}</div>
          </div>
          <ListToolbar c={controls} />
        </div>

        {loading && controls.processed.length === 0 ? (
          <div className="est-loading">{Array.from({ length: 12 }, (_, i) => <div key={i} className="est-skeleton" />)}</div>
        ) : error ? (
          <div className="est-empty-state"><p>Failed to load records.</p></div>
        ) : (
          <div className="est-list-body">
          <ListBody c={controls} renderItem={r => {
            const fd = r.fieldData
            const st = fd.Status || 'Draft'
            const color = STATUS_COLOR[st] ?? '#64748b'
            const tot = parseFloat(String(fd.zz__Total__xn ?? '').replace(/[^0-9.-]/g, '')) || null
            return (
              <div key={r.recordId}
                className={`est-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId) }}>
                <div className="est-item-dot" style={{ background: color }} />
                <div className="est-item-text">
                  <div className="est-item-name">{fd.zz__Display_Contact__ct || fd.Title || '—'}</div>
                  <div className="est-item-sub">
                    {fd.Title && fd.zz__Display_Contact__ct && <span>{fd.Title}</span>}
                    {fd.Date && <span>{fmtDate(fd.Date)}</span>}
                    {tot !== null && <span>{fmtCurrency(tot)}</span>}
                  </div>
                </div>
                <span className="est-item-status" style={{ color }}>{st}</span>
              </div>
            )
          }} />
          </div>
        )}
      </aside>

      <div className="est-resize-handle" onMouseDown={onMouseDown} />

      <main className="est-main">
        {!selected ? (
          <div className="est-empty-state">
            <div className="est-empty-icon">◧</div>
            <p>Select an estimate</p>
          </div>
        ) : (
          <>
            <div className="est-topbar">
              <div className="est-topbar-left">
                <h1 className="est-title">{f.Title || f.zz__Display_Contact__ct || '—'}</h1>
                <div className="est-meta-row">
                  {status && (
                    <span className="est-chip status" style={{
                      background: statusColor + '22',
                      color: statusColor,
                      borderColor: statusColor + '44',
                    }}>{status}</span>
                  )}
                  {f.Class && (
                    <span className="est-chip type" style={{
                      background: (TYPE_COLOR[f.Class] ?? '#4a5568') + '22',
                      color: TYPE_COLOR[f.Class] ?? '#94a3b8',
                      borderColor: (TYPE_COLOR[f.Class] ?? '#4a5568') + '44',
                    }}>{f.Class}</span>
                  )}
                  {f._kpt__Estimate_ID && <span className="est-chip id">#{f._kpt__Estimate_ID}</span>}
                  {f.Date && <span className="est-chip muted">{fmtDate(f.Date)}</span>}
                </div>
              </div>
              <div className="est-topbar-right">
                {displayTotal > 0 && (
                  <div className="est-total-badge">
                    <span className="est-total-label">Total</span>
                    <span className="est-total-amount">{fmtCurrency(displayTotal)}</span>
                  </div>
                )}
                <div className="est-topbar-actions">
                  {saveStatus === 'saved' && <span className="est-save-status saved">✓ Saved</span>}
                  {saveStatus === 'error' && <span className="est-save-status error">✗ Failed</span>}
                  {!editing ? (
                    <button className="est-btn edit" onClick={() => setEditing(true)}>✎ Edit</button>
                  ) : (
                    <>
                      <button className="est-btn discard" onClick={handleDiscard} disabled={saving}>Discard</button>
                      <button className="est-btn save" onClick={handleSave} disabled={saving || dirtyCount === 0}>
                        {saving ? 'Saving…' : dirtyCount ? `Save ${dirtyCount}` : 'Save'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="est-content">

              <Section title="Client" icon="◉">
                <div className="est-field-grid">
                  <Field label="Contact / Organization" fk="zz__Display_Contact__ct" f={f} edits={edits} onChange={handleChange} editing={editing} editable={false} wide />
                  {f.Address_Block_Billing && (
                    <Field label="Billing Address" fk="Address_Block_Billing" f={f} edits={edits} onChange={handleChange} editing={editing} editable={false} wide />
                  )}
                  {f.Address_Block_Shipping && (
                    <Field label="Shipping Address" fk="Address_Block_Shipping" f={f} edits={edits} onChange={handleChange} editing={editing} editable={false} wide />
                  )}
                </div>
              </Section>

              <Section title="Estimate Details" icon="◧">
                <div className="est-field-grid">
                  <Field label="Estimate #" fk="_kpt__Estimate_ID" f={f} edits={edits} onChange={handleChange} editing={editing} editable={false} mono />
                  <Field label="Title"       fk="Title"             f={f} edits={edits} onChange={handleChange} editing={editing} />
                  <Field label="Status"      fk="Status"            f={f} edits={edits} onChange={handleChange} editing={editing} />
                  <Field label="Class"       fk="Class"             f={f} edits={edits} onChange={handleChange} editing={editing} />
                  <Field label="Date"        fk="Date"              f={f} edits={edits} onChange={handleChange} editing={editing} />
                  <Field label="Tax Name"    fk="Tax_Name"          f={f} edits={edits} onChange={handleChange} editing={editing} />
                  <Field label="Tax Rate"    fk="Tax_Rate"          f={f} edits={edits} onChange={handleChange} editing={editing} />
                  {f.Memo && (
                    <Field label="Memo"      fk="Memo"              f={f} edits={edits} onChange={handleChange} editing={editing} wide textarea />
                  )}
                </div>
              </Section>

              <Section title={`Line Items${lineItems.length ? ` (${lineItems.length})` : ''}`} icon="≡">
                {lineItems.length === 0 ? (
                  <p className="est-empty-portal">No line items on this estimate</p>
                ) : (
                  <div className="est-table-wrap">
                    <table className="est-table">
                      <thead>
                        <tr>
                          <th className="desc">Item / Description</th>
                          <th className="num">Qty</th>
                          <th className="num">Unit Price</th>
                          <th className="num">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lineItems.map((li, i) => (
                          <tr key={li.recordId || i}>
                            <td className="desc">
                              {li['estmt_ESTLI::Item_Name'] && (
                                <div className="est-li-name">{li['estmt_ESTLI::Item_Name']}</div>
                              )}
                              {li['estmt_ESTLI::Description'] && (
                                <div className="est-li-desc">{li['estmt_ESTLI::Description']}</div>
                              )}
                              {!li['estmt_ESTLI::Item_Name'] && !li['estmt_ESTLI::Description'] && '—'}
                            </td>
                            <td className="num">{li['estmt_ESTLI::Quantity'] ?? '—'}</td>
                            <td className="num">{fmtCurrency(li['estmt_ESTLI::Unit_Price'])}</td>
                            <td className="num">{fmtCurrency(li['estmt_ESTLI::Amount'])}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    <div className="est-totals">
                      {f.zz__Subtotal__xn != null && (
                        <div className="est-total-row"><span>Subtotal</span><span>{fmtCurrency(f.zz__Subtotal__xn)}</span></div>
                      )}
                      {f.zz__Tax__xn != null && (
                        <div className="est-total-row">
                          <span>Tax{f.Tax_Name ? ` (${f.Tax_Name})` : ''}{f.Tax_Rate ? ` ${f.Tax_Rate}%` : ''}</span>
                          <span>{fmtCurrency(f.zz__Tax__xn)}</span>
                        </div>
                      )}
                      <div className="est-total-row grand"><span>Total</span><span>{fmtCurrency(displayTotal)}</span></div>
                    </div>
                  </div>
                )}
              </Section>

              {f.Memo && (
                <Section title="Memo" icon="✎">
                  <div className="est-field-grid">
                    <Field label="Memo" fk="Memo" f={f} edits={edits} onChange={handleChange} editing={editing} wide textarea />
                  </div>
                </Section>
              )}

              <div className="est-record-footer">
                ID {f._kpt__Estimate_ID || '—'} · Record {selected.recordId} · Created {f.zz__Created_On?.split(' ')[0] || '—'} by {f.zz__Created_By || '—'} · Modified {f.zz__Modified_On?.split(' ')[0] || '—'} by {f.zz__Modified_By || '—'}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
