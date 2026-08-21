import { useState, useEffect, useRef, useCallback } from 'react'
import { getRecord, invalidateRecord, patchCachedRecord, addCachedRecord } from '../api/filemaker'
import { updateVibeRecord, createVibeRecord } from '../api/vibeRecords'
import { displayFieldsForContact } from '../api/contactDisplay'
import { useAllRecords } from '../hooks/useAllRecords'
import ListToolbar, { useListControls, ListBody } from './ListControls'
import RecordSaveBar from './RecordSaveBar'
import RecordFormModal from './RecordFormModal'
import CreateInQBO from './CreateInQBO'
import EstimateLines from './EstimateLines'
import BomPickerModal from './BomPickerModal'
import { readCacheAsync } from '../api/filemaker'
import {
  sortLines, addLines, updateLine, deleteLine, replaceLines,
  lineFromProduct, nextSortOrder, listLines, subtotalOf,
  portalRowToLine as portalToLine, allTotals,
} from '../api/estimateLinesVibe'
import { BRAND, UI } from '../config/brandColors'
import './Estimates.css'
import DeleteRecordButton from './DeleteRecordButton'
import ReminderModal from './ReminderModal'
import RecordFooter from './RecordFooter';
import { useRecordPanel } from '../hooks/useRecordPanel';

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
  const [remindOpen, setRemindOpen] = useState(false)
  // Width, drag and memory come from useRecordPanel — see the hook for what
  // the twelve hand-rolled copies had drifted into.
  const { width: sidebarWidth, onPointerDown: startPanelResize } = useRecordPanel('estimates', 300);
  const [edits, setEdits] = useState({})
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState(null)
  const [saveErrorMsg, setSaveErrorMsg] = useState(null)
  const [showNew, setShowNew] = useState(false)

  // ── Line-item editing ──
  // Staged like field `edits`: nothing is written until Save, so Discard really
  // discards. Adds land in `newLines`, edits in `lineEdits`, removals in
  // `deletedIds` (reversible until saved).
  const [lineEdits, setLineEdits] = useState({})
  const [newLines, setNewLines] = useState([])
  const [deletedIds, setDeletedIds] = useState(() => new Set())

  // The selected estimate's line items, from Vibe (PHASE B1).
  //
  // Keyed on the estimate's own `_kpt__Estimate_ID`, not FileMaker's recordId —
  // that is what the Vibe store keys on, and a recordId is a FileMaker internal
  // that dies with it. `migrated: false` means Vibe has never seen this estimate
  // and the FileMaker portal rows are used instead, which is the only way an
  // environment the migration cannot reach still shows its lines.
  const [vibeLines, setVibeLines] = useState({ lines: [], totals: null, migrated: false })

  // Every estimate's computed total, for the LIST. Without it the sidebar shows
  // FileMaker's cached figure while the open record shows the computed one, and
  // the same estimate reads as two different numbers on one screen.
  const [listTotals, setListTotals] = useState({})
  useEffect(() => {
    let alive = true
    allTotals().then(t => { if (alive) setListTotals(t) })
    return () => { alive = false }
  }, [])
  const totalFor = useCallback(fd => {
    const id = String(fd?._kpt__Estimate_ID || '')
    const computed = listTotals[id]
    return computed != null ? computed
      : (parseFloat(String(fd?.zz__Total__xn ?? '').replace(/[^0-9.-]/g, '')) || 0)
  }, [listTotals])
  const estimateId = String(selected?.fieldData?._kpt__Estimate_ID || '').trim()

  const refreshLines = useCallback(async () => {
    if (!estimateId) return
    const got = await listLines(estimateId)
    setVibeLines({ ...got, id: estimateId })
  }, [estimateId])

  useEffect(() => {
    if (!estimateId) return undefined
    let alive = true
    listLines(estimateId).then(got => { if (alive) setVibeLines({ ...got, id: estimateId }) })
    return () => { alive = false }
  }, [estimateId])
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
      { id: 'total',  label: 'Total',   value: f => totalFor(f) },
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
      // Same precedence as the displayed lines — numbering from the portal on a
      // migrated estimate would restart at 1 and collide with Vibe's rows.
      const existing = vibeLines.migrated
        ? vibeLines.lines
        : (selected?.portalData?.['estmt_ESTLI'] || []).map(portalToLine)
      const order = nextSortOrder([...existing, ...rows]) + rows.length
      return [...rows, { ...lineFromProduct(item, Number(quantity) || 1, order), _tempId: `new:${++tempId.current}` }]
    })
    setPickerOpen(false)
  }, [selected, vibeLines.migrated, vibeLines.lines])

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
    // Born in Vibe, like every other record this app creates. QuickAddFromContact
    // has created estimates this way since A1; this module's own "+ New" was the
    // last one still going through FileMaker — the same split that was found and
    // closed for Inspections.
    //
    // The names and billing address block are resolved from the contact, exactly
    // as the quick-add does, so an estimate created here is indistinguishable
    // from one created there.
    const { fields: display } = await displayFieldsForContact(LAYOUT, fieldData._kft__Contact_ID)
    const made = await createVibeRecord(LAYOUT, { ...display, ...fieldData })
    const newId = made?.recordId
    if (!newId) throw new Error('Could not create the record')
    const rec = { recordId: newId, fieldData: made.fieldData, portalData: {} }
    addCachedRecord(LAYOUT, CACHE_VERSION, rec)
    handleSelect(rec)
    onRecordSelect?.(newId, rec.fieldData?.zz__Display_Contact__ct || rec.fieldData?.Title)
  }

  const handleChange = useCallback((fk, val) => setEdits(p => ({ ...p, [fk]: val })), [])
  const handleDiscard = () => { setEdits({}); resetLines(); setSaveStatus(null); setSaveErrorMsg(null) }

  async function handleSave() {
    const lineChanges = Object.keys(lineEdits).length + newLines.length + deletedIds.size
    if (!Object.keys(edits).length && !lineChanges) { return }
    setSaving(true); setSaveStatus(null); setSaveErrorMsg(null)
    try {
      if (lineChanges) {
        // Lines live in Vibe (PHASE B1). There is no recalcTotals any more: the
        // totals are computed from the lines on every read, so they cannot go
        // stale — which the stored ones already had, on ~7% of production
        // estimates and almost always understated.
        //
        // An estimate the migration never reached is SEEDED from its portal
        // rows first. Without that, editing one line on such an estimate would
        // leave Vibe holding only that line and silently drop the rest.
        if (!vibeLines.migrated) await replaceLines(estimateId, savedLines)

        for (const id of deletedIds) await deleteLine(estimateId, id)
        for (const [id, changes] of Object.entries(lineEdits)) {
          if (deletedIds.has(String(id))) continue           // deleted beats edited
          const base = savedLines.find(l => String(l.recordId) === String(id))
          await updateLine(estimateId, id, { ...base, ...changes })
        }
        if (newLines.length) await addLines(estimateId, newLines)

        await refreshLines()
        resetLines()
      }
      if (Object.keys(edits).length) {
        // Estimates_New is Vibe-owned (api/_vibeStore.js) for field edits, and
        // as of B1 its line items are too — so nothing on this record goes to
        // FileMaker any more.
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
  // Vibe's lines when it has them; FileMaker's portal rows only for an estimate
  // the migration never reached. `vibeLines.id === estimateId` guards against a
  // reply for a previously selected estimate painting over this one.
  const linesReady = vibeLines.id === estimateId
  const savedLines = (linesReady && vibeLines.migrated)
    ? sortLines(vibeLines.lines)
    : sortLines(lineItems.map(portalToLine))
  const workingLines = [
    ...savedLines.map(l => {
      const staged = lineEdits[l.recordId]
      return { ...l, ...(staged || {}), _dirty: !!staged, _deleted: deletedIds.has(String(l.recordId)) }
    }),
    ...newLines,
  ]

  const lineChangeCount = Object.keys(lineEdits).length + newLines.length + deletedIds.size
  const dirtyCount = Object.keys(edits).length + lineChangeCount

  // COMPUTED from the lines, not read from the record. The stored
  // zz__Total__xn is a cache FileMaker's recalc script maintained, and it is
  // wrong on ~7% of production estimates — almost always too low, because a
  // line was added and the script did not fire. Measured 2026-08-19: 43 of 591
  // estimates disagreed, 42 of them understated, by up to $1,050.
  const storedTotal = parseFloat(String(f.zz__Total__xn ?? '').replace(/[^0-9.-]/g, '')) || 0
  const computedTotal = subtotalOf(savedLines.filter(l => !deletedIds.has(String(l.recordId))))
  const displayTotal = savedLines.length ? computedTotal : storedTotal
  // Flagged rather than silently corrected: the figure on screen changes for
  // those estimates, and whoever quoted from the old one deserves to see that.
  const totalMismatch = savedLines.length && Math.abs(computedTotal - storedTotal) > 0.02
    ? { stored: storedTotal, computed: computedTotal }
    : null
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
            const tot = totalFor(fd) || null
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

      <div className="est-resize-handle" onPointerDown={startPanelResize} />

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
                {totalMismatch && (
                  <div
                    className="est-total-flag"
                    title={`This estimate's line items add up to ${fmtCurrency(totalMismatch.computed)}. `
                      + `FileMaker's stored total says ${fmtCurrency(totalMismatch.stored)}, which stopped `
                      + `updating when a line was changed without its recalculation running. `
                      + `The figure shown is the one the lines actually come to.`}
                  >
                    ⚠ was {fmtCurrency(totalMismatch.stored)} in FileMaker
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
                <button className="h5-btn h5-btn--quiet h5-btn--sm" onClick={() => setRemindOpen(true)}>⏰ Remind</button>
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

              <RecordFooter id={f._kpt__Estimate_ID} recordId={selected.recordId} fieldData={f} />
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
            recordType: 'estimates',
            recordId: String(selected.recordId),
            recordLabel: f.Title || f.zz__Display_Contact__ct || 'estimate',
            title: `Follow up on ${f.Title || f.zz__Display_Contact__ct || 'estimate'}`,
          }}
          onClose={() => setRemindOpen(false)}
          onSaved={() => setRemindOpen(false)} />
      )}

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
