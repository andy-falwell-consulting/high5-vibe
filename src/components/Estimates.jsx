import { useState, useEffect, useRef, useCallback } from 'react'
import { getRecord, invalidateRecord, patchCachedRecord, createRecord, addCachedRecord } from '../api/filemaker'
import { updateVibeRecord } from '../api/vibeRecords'
import { useAllRecords } from '../hooks/useAllRecords'
import ListToolbar, { useListControls, ListBody } from './ListControls'
import RecordSaveBar from './RecordSaveBar'
import RecordFormModal from './RecordFormModal'
import CreateInQBO from './CreateInQBO'
import EstimateLines from './EstimateLines'
import BomPickerModal from './BomPickerModal'
import { readCacheAsync } from '../api/filemaker'
import {
  toLine, sortLines, addLines, updateLine, deleteLine, recalcTotals,
  lineFromProduct, nextSortOrder,
} from '../api/estimateLines'
import { BRAND, UI } from '../config/brandColors'
import './Estimates.css'
import DeleteRecordButton from './DeleteRecordButton'

// FileMaker MM/DD/YYYY → QBO YYYY-MM-DD
const toIsoDate = v => { if (!v) return undefined; const [m, d, y] = String(v).split(' ')[0].split('/'); return y ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : undefined }

const LAYOUT = 'Estimates_New'
// 2: _kft__Contact_ID was added to the layout on 2026-08-17. A cached copy
// from before then has no such field, and nothing else would invalidate it.
const CACHE_VERSION = 2

const STATUS_COLOR = {
  'Draft':       UI.neutral,
  'Sent':        BRAND.blue,
  'Approved':    UI.success,
  'Declined':    BRAND.red,
  'Expired':     BRAND.gold,
  'Mandatory':   BRAND.purple,
  'Recommended': '#4FC3E8',
}

// QBO's own approval status (TxnStatus), synced back one-way by
// api/qbo-estimate-sync.js — distinct vocabulary from FMP's own `Status`
// field above, so it's shown as a separate chip, not merged into it.
const QBO_STATUS_COLOR = {
  'Pending':  BRAND.gold,
  'Accepted': UI.success,
  'Closed':   UI.neutral,
  'Rejected': BRAND.red,
}

const TYPE_COLOR = {
  'New Build': BRAND.purple,
  'Repair':    BRAND.gold,
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
  const [edits, setEdits] = useState({})
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState(null)
  const [saveErrorMsg, setSaveErrorMsg] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const dragging = useRef(false)

  // ── Line-item editing ──
  // Staged like field `edits`: nothing is written until Save, so Discard really
  // discards. Adds land in `newLines`, edits in `lineEdits`, removals in
  // `deletedIds` (reversible until saved).
  const [lineEdits, setLineEdits] = useState({})
  const [newLines, setNewLines] = useState([])
  const [deletedIds, setDeletedIds] = useState(() => new Set())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [products, setProducts] = useState([])
  const tempId = useRef(0)

  const resetLines = useCallback(() => {
    setLineEdits({}); setNewLines([]); setDeletedIds(new Set())
  }, [])

  // Products for the picker come from the cache App.jsx already prewarms.
  useEffect(() => {
    let alive = true
    readCacheAsync('Products & Services_New', 5)
      .then(r => { if (alive) setProducts(r?.records || []) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

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
    setEdits({}); setSaveStatus(null)
    resetLines()
    setSelected(r)
    getRecord(LAYOUT, r.recordId).then(d => {
      const fresh = d?.response?.data?.[0]
      if (fresh) setSelected(fresh)
    }).catch(() => {})
  }

  // Editing a line marks it dirty so the save bar and the live total react.
  const onLineEdit = useCallback((id, field, value) => {
    if (String(id).startsWith('new:')) {
      setNewLines(rows => rows.map(r => (r._tempId === id ? { ...r, [field]: value } : r)))
      return
    }
    setLineEdits(p => ({ ...p, [id]: { ...(p[id] || {}), [field]: value } }))
  }, [])

  const onLineDelete = useCallback(id => {
    if (String(id).startsWith('new:')) { setNewLines(rows => rows.filter(r => r._tempId !== id)); return }
    setDeletedIds(prev => new Set(prev).add(String(id)))
  }, [])

  const onLineUndelete = useCallback(id => {
    setDeletedIds(prev => { const next = new Set(prev); next.delete(String(id)); return next })
  }, [])

  // Unit price always comes from the catalogue — no per-line override.
  const onPickProduct = useCallback(({ item, quantity }) => {
    setNewLines(rows => {
      const existing = (selected?.portalData?.[ 'estmt_ESTLI' ] || []).map(toLine)
      const order = nextSortOrder([...existing, ...rows]) + rows.length
      return [...rows, { ...lineFromProduct(item, Number(quantity) || 1, order), _tempId: `new:${++tempId.current}` }]
    })
    setPickerOpen(false)
  }, [selected])

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

  // ── Create a new estimate ──
  const createFields = [
    { key: '_kft__Contact_ID', label: 'Contact / Organization', type: 'contact', required: true },
    { key: 'Title',  label: 'Title', type: 'text' },
    { key: 'Date',   label: 'Date', type: 'date', default: new Date().toLocaleDateString('en-US') },
    { key: 'Status', label: 'Status', type: 'select', options: Object.keys(STATUS_COLOR), default: 'Draft' },
    { key: 'Class',  label: 'Class', type: 'text' },
  ]

  async function handleCreate(fieldData) {
    const res = await createRecord(LAYOUT, fieldData)
    const newId = res?.response?.recordId
    if (!newId) throw new Error(res?.messages?.[0]?.message || 'Could not create the record')
    getRecord(LAYOUT, newId).then(d => {
      const rec = d?.response?.data?.[0]
      if (rec) { addCachedRecord(LAYOUT, CACHE_VERSION, rec); handleSelect(rec); onRecordSelect?.(rec.recordId, rec.fieldData?.zz__Display_Contact__ct || rec.fieldData?.Title) }
    }).catch(() => {})
  }

  const onMouseDown = useCallback(e => {
    dragging.current = true
    const startX = e.clientX, startW = sidebarWidth
    const onMove = ev => { if (!dragging.current) return; setSidebarWidth(Math.max(220, Math.min(520, startW + ev.clientX - startX))) }
    const onUp = () => { dragging.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [sidebarWidth])

  const handleChange = useCallback((fk, val) => setEdits(p => ({ ...p, [fk]: val })), [])
  const handleDiscard = () => { setEdits({}); resetLines(); setSaveStatus(null); setSaveErrorMsg(null) }

  async function handleSave() {
    const lineChanges = Object.keys(lineEdits).length + newLines.length + deletedIds.size
    if (!Object.keys(edits).length && !lineChanges) { return }
    setSaving(true); setSaveStatus(null); setSaveErrorMsg(null)
    try {
      if (lineChanges) {
        for (const id of deletedIds) await deleteLine(selected.recordId, id)
        for (const [id, changes] of Object.entries(lineEdits)) {
          if (deletedIds.has(String(id))) continue           // deleted beats edited
          const base = savedLines.find(l => String(l.recordId) === String(id))
          await updateLine(selected.recordId, id, { ...base, ...changes })
        }
        if (newLines.length) await addLines(selected.recordId, newLines)

        // The stored totals are script-maintained and reject direct writes, so
        // this is the only way to keep them honest. Throws on script failure
        // rather than leaving a silently stale total behind.
        const fresh = await recalcTotals(selected.recordId)
        if (fresh) setSelected(fresh)
        resetLines()
      }
      if (Object.keys(edits).length) {
        // Estimates_New is Vibe-owned (api/_vibeStore.js) for field edits —
        // same pattern as the other Vibe-owned layouts. Line items
        // (updateLine/addLines/deleteLine above) and the totals recalc still
        // go to FileMaker: the stored totals are script-maintained
        // (RECALC_SCRIPT in api/estimateLines.js) and can't be reproduced in
        // Vibe without Vibe computing them itself, which hasn't been built.
        await updateVibeRecord(LAYOUT, selected.recordId, edits)
        patchCachedRecord(LAYOUT, CACHE_VERSION, selected.recordId, edits)
        setSelected(prev => ({ ...prev, fieldData: { ...prev.fieldData, ...edits } }))
      }
      invalidateRecord(LAYOUT, selected.recordId)
      setEdits({}); setSaveStatus('saved')
      setTimeout(() => setSaveStatus(null), 2000)
    } catch (e) { setSaveStatus('error'); setSaveErrorMsg(e?.message || null); }
    finally { setSaving(false) }
  }

  const f = selected?.fieldData ?? {}
  const p = selected?.portalData
  const lineItems = p?.estmt_ESTLI || []

  // Saved rows in display order (the portal returns them backwards), with any
  // staged edits applied and removals marked, followed by lines added this session.
  const savedLines = sortLines(lineItems.map(toLine))
  const workingLines = [
    ...savedLines.map(l => {
      const staged = lineEdits[l.recordId]
      return { ...l, ...(staged || {}), _dirty: !!staged, _deleted: deletedIds.has(String(l.recordId)) }
    }),
    ...newLines,
  ]

  const lineChangeCount = Object.keys(lineEdits).length + newLines.length + deletedIds.size
  const dirtyCount = Object.keys(edits).length + lineChangeCount

  const displayTotal = parseFloat(String(f.zz__Total__xn ?? '').replace(/[^0-9.-]/g, '')) || 0
  const status = f.Status || ''
  const statusColor = STATUS_COLOR[status] ?? '#64748b'

  return (
    <div className="est-container">
      <aside className="est-sidebar" style={{ width: sidebarWidth }}>
        <div className="est-sidebar-header">
          <div className="est-sidebar-title">
            <div>
              <div className="est-sidebar-module">Estimates</div>
              <div className="est-sidebar-count">{loading ? 'Loading…' : `${total.toLocaleString()} estimates`}</div>
            </div>
            <button className="est-new-btn" onClick={() => setShowNew(true)} title="New estimate">＋ New</button>
          </div>
          <ListToolbar c={controls} />
        </div>

        {loading && controls.processed.length === 0 ? (
          <div className="est-loading">{Array.from({ length: 12 }, (_, i) => <div key={i} className="est-skeleton" />)}</div>
        ) : error ? (
          <div className="est-empty-state"><p>Failed to load records.</p></div>
        ) : (
          <div className="est-list-body">
          <ListBody c={controls} activeId={selected?.recordId} renderItem={r => {
            const fd = r.fieldData
            const st = fd.Status || 'Draft'
            const color = STATUS_COLOR[st] ?? '#64748b'
            const tot = parseFloat(String(fd.zz__Total__xn ?? '').replace(/[^0-9.-]/g, '')) || null
            return (
              <div key={r.recordId}
                className={`est-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId, r.fieldData?.zz__Display_Contact__ct) }}>
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
                  {f.qbo_estimate_id && f.qbo_estimate_status && (
                    <span className="est-chip qbo-status" title="QBO's approval status, synced from QuickBooks" style={{
                      background: (QBO_STATUS_COLOR[f.qbo_estimate_status] ?? '#64748b') + '22',
                      color: QBO_STATUS_COLOR[f.qbo_estimate_status] ?? '#94a3b8',
                      borderColor: (QBO_STATUS_COLOR[f.qbo_estimate_status] ?? '#64748b') + '44',
                    }}>QBO: {f.qbo_estimate_status}</span>
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
                <CreateInQBO
                  type="estimate"
                  env="production"
                  existingId={f.qbo_estimate_id || null}
                  draft={{
                    customerName: f.zz__Display_Contact__ct,
                    txnDate: toIsoDate(f.Date),
                    memo: f.Memo || undefined,
                    lines: lineItems
                      .filter(li => li['estmt_ESTLI::Item_Name'] || li['estmt_ESTLI::Description'])
                      .map(li => ({
                        productName: li['estmt_ESTLI::Item_Name'] || '',
                        description: li['estmt_ESTLI::Description'] || '',
                        qty: li['estmt_ESTLI::Quantity'],
                        unitPrice: li['estmt_ESTLI::Unit_Price'],
                        amount: li['estmt_ESTLI::Amount'],
                      })),
                  }}
                  onCreated={(qboId) => {
                    updateVibeRecord(LAYOUT, selected.recordId, { qbo_estimate_id: String(qboId) })
                      .then(() => { patchCachedRecord(LAYOUT, CACHE_VERSION, selected.recordId, { qbo_estimate_id: String(qboId) }); })
                      .catch(() => {})
                    setSelected(s => ({ ...s, fieldData: { ...s.fieldData, qbo_estimate_id: String(qboId) } }))
                  }}
                />
              </div>
              <div className="est-topbar-actions">
                <DeleteRecordButton
                  layout={LAYOUT} cacheVersion={CACHE_VERSION}
                  recordId={selected.recordId}
                  name={f.Title || f.zz__Display_Contact__ct}
                  onDeleted={() => setSelected(null)}
                />
              </div>
            </div>

            <div className="est-content">

              <Section title="Client" icon="◉">
                <div className="est-field-grid">
                  <Field label="Contact / Organization" fk="zz__Display_Contact__ct" f={f} edits={edits} onChange={handleChange} editing={true} editable={false} wide />
                  {f.Address_Block_Billing && (
                    <Field label="Billing Address" fk="Address_Block_Billing" f={f} edits={edits} onChange={handleChange} editing={true} editable={false} wide />
                  )}
                  {f.Address_Block_Shipping && (
                    <Field label="Shipping Address" fk="Address_Block_Shipping" f={f} edits={edits} onChange={handleChange} editing={true} editable={false} wide />
                  )}
                </div>
              </Section>

              <Section title="Estimate Details" icon="◧">
                <div className="est-field-grid">
                  <Field label="Estimate #" fk="_kpt__Estimate_ID" f={f} edits={edits} onChange={handleChange} editing={true} editable={false} mono />
                  <Field label="Title"       fk="Title"             f={f} edits={edits} onChange={handleChange} editing={true} />
                  <Field label="Status"      fk="Status"            f={f} edits={edits} onChange={handleChange} editing={true} />
                  <Field label="Class"       fk="Class"             f={f} edits={edits} onChange={handleChange} editing={true} />
                  <Field label="Date"        fk="Date"              f={f} edits={edits} onChange={handleChange} editing={true} />
                  {f.Memo && (
                    <Field label="Memo"      fk="Memo"              f={f} edits={edits} onChange={handleChange} editing={true} wide textarea />
                  )}
                </div>
              </Section>

              <Section title="Line Items" icon="≡">
                <EstimateLines
                  lines={workingLines}
                  onEdit={onLineEdit}
                  onDelete={onLineDelete}
                  onUndelete={onLineUndelete}
                  onAddClick={() => setPickerOpen(true)}
                  storedSubtotal={f.zz__Subtotal__xn}
                  storedTax={f.zz__Tax__xn}
                  storedTotal={displayTotal}
                  taxName={f.Tax_Name}
                  taxRate={f.Tax_Rate}
                  pushedToQbo={!!f.qbo_estimate_id}
                />
              </Section>

              {f.Memo && (
                <Section title="Memo" icon="✎">
                  <div className="est-field-grid">
                    <Field label="Memo" fk="Memo" f={f} edits={edits} onChange={handleChange} editing={true} wide textarea />
                  </div>
                </Section>
              )}

              <div className="est-record-footer">
                ID {f._kpt__Estimate_ID || '—'} · Record {selected.recordId} · Created {f.zz__Created_On?.split(' ')[0] || '—'} by {f.zz__Created_By || '—'} · Modified {f.zz__Modified_On?.split(' ')[0] || '—'} by {f.zz__Modified_By || '—'}
              </div>
              <RecordSaveBar count={dirtyCount} saving={saving} status={saveStatus} errorMessage={saveErrorMsg} onSave={handleSave} onDiscard={handleDiscard} />
            </div>
          </>
        )}
      </main>

      {showNew && (
        <RecordFormModal
          title="New Estimate"
          fields={createFields}
          submitLabel="Create estimate"
          onCreate={handleCreate}
          onClose={() => setShowNew(false)}
        />
      )}

      {pickerOpen && (
        <BomPickerModal
          allRecords={products}
          title="Add line item"
          showCost={false}
          onAdd={onPickProduct}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}
