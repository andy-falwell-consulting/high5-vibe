import { useState, useCallback, useRef, useEffect } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useAllRecords } from '../hooks/useAllRecords'
import { bustCache, patchCachedRecord } from '../api/filemaker'
import { updateVibeRecord } from '../api/vibeRecords'
import { getCurrentEnv } from '../config/fmpEnvironments'
import { TRAININGS_LAYOUT as LAYOUT, TRAININGS_CACHE_VERSION as CACHE_VERSION, TRAINER_SLOTS } from '../config/trainingsCache'
import { ACTIVE_STAGES, PIPELINE_STAGES, PIPELINE_SHORT, statusColor } from '../config/trainingStatus'
import { useTrainingsKanbanBoard } from '../hooks/useTrainingsKanbanBoard'
import { useTrainingsKanbanOrder } from '../hooks/useTrainingsKanbanOrder'
import './TrainingsKanban.css'

// Board columns = the in-flight pipeline stages (Final Invoiced / Completed /
// No Go / etc. are valid statuses but not columns — a card set to one leaves
// the board, same rule CCS's board uses). Headers use the SHORT stage labels
// the hero pipeline dots already use.
const COLUMNS = ACTIVE_STAGES.map(id => ({
  id,
  label: PIPELINE_SHORT[PIPELINE_STAGES.indexOf(id)] ?? id,
  color: statusColor(id),
}))
const ACTIVE_STATUSES = new Set(ACTIVE_STAGES)

// Trainings has no legacy-field aliasing the way CCS's mergedStatus does —
// Status is the one field, read straight.
const getStatus = r => String(r.fieldData?.Status || '').trim()

const TRAINER_KEYS = ['Lead Trainer', ...TRAINER_SLOTS]

function matchesSearch(r, q) {
  if (!q) return true
  const f = r.fieldData
  const haystack = [
    f.zz__Display_Organization__ct,
    f.zz__Display_Contact__ct,
    f['Type of Program'],
    ...TRAINER_KEYS.map(k => f[k]),
    f['Work Order'], f.Notes,
  ].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(q.toLowerCase())
}

function KanbanCardView({ record, saving, dimmed }) {
  const f = record.fieldData
  const leadTrainer = f['Lead Trainer']
  return (
    <div className={`tkb-card${saving ? ' tkb-card--saving' : ''}${dimmed ? ' tkb-card--dimmed' : ''}`}>
      <div className="tkb-card-org">{f.zz__Display_Organization__ct || '—'}</div>
      <div className="tkb-card-meta">
        {f['Type of Program'] && <span className="tkb-card-type">{f['Type of Program']}</span>}
        {f['Start Date'] && (
          <span className="tkb-card-date">{f['Start Date']}</span>
        )}
      </div>
      {/* The lead trainer — this IS a real per-record field on trainings_New
          (unlike CCS's ops lead, which is a separate Vibe-only assignment),
          so it's just read off the record, no extra hook needed. */}
      {leadTrainer && (
        <div className="tkb-card-lead"><span className="tkb-card-lead-ic">◇</span>{leadTrainer}</div>
      )}
    </div>
  )
}

// Sortable, not just draggable: within a lane, dropping a card ON another
// card reorders between them (over.id resolves to that specific card's id,
// not just "somewhere in this column") — see handleDragEnd for how that's
// distinguished from a cross-lane move.
function DraggableCard({ record, saving, onOpen, dimmed, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: record.recordId,
  })
  const didDrag = useRef(false)

  useEffect(() => {
    if (isDragging) didDrag.current = true
  }, [isDragging])

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{
        position: 'relative', opacity: isDragging ? 0.25 : 1, cursor: 'grab', touchAction: 'none', userSelect: 'none',
        transform: CSS.Transform.toString(transform), transition,
      }}
      onClick={() => {
        if (didDrag.current) { didDrag.current = false; return }
        onOpen(record)
      }}
    >
      <KanbanCardView record={record} saving={saving} dimmed={dimmed} />
      {onRemove && (
        <button className="tkb-card-remove" title="Remove from board"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onRemove(record) }}>✕</button>
      )}
    </div>
  )
}

// Training cost is not a FileMaker field — it lives in QuickBooks, fetched
// per card open from the same endpoint the Workspace uses (source=trainings
// reads the single-value QB reference fields rather than RCD's repeating
// ones — see api/ccs-estimate.js). null = no usable estimate linked.
function useTrainingCost(recordId) {
  const [result, setResult] = useState({ id: null, value: null, failed: false })

  useEffect(() => {
    let alive = true
    fetch(`/api/ccs-estimate?db=${encodeURIComponent(getCurrentEnv().db)}&recordId=${recordId}&source=trainings`,
      { credentials: 'include' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(j => { if (alive) setResult({ id: recordId, value: j?.totals?.estimated ?? null, failed: false }) })
      .catch(() => { if (alive) setResult({ id: recordId, value: null, failed: true }) })
    return () => { alive = false }
  }, [recordId])

  const loading = result.id !== recordId
  return {
    loading,
    value: loading ? null : result.value,
    failed: loading ? false : result.failed,
  }
}

const tkbMoney = v => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

function KanbanDetail({ record, onClose, onNavigateTo }) {
  const f = record.fieldData
  const cost = useTrainingCost(record.recordId)

  const trainers = TRAINER_KEYS
    .map(k => f[k] && { label: k === 'Lead Trainer' ? 'Lead' : k, name: f[k] })
    .filter(Boolean)

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="tkb-overlay" onClick={onClose}>
      <div className="tkb-detail" onClick={e => e.stopPropagation()}>
        <button className="tkb-detail-close" onClick={onClose} aria-label="Close">✕</button>
        {/* 'trainings' is the Workspace — pipeline, financials, QuickBooks,
            and the Notes and Work Order text this panel doesn't repeat. See
            CHILD_TO_VIEW in TrainingsWorkspace.jsx. */}
        <button className="tkb-detail-nav-btn" onClick={() => { onNavigateTo?.('trainings', record.recordId); onClose(); }}>Open in Trainings ◳</button>

        <div className="tkb-detail-org">{f.zz__Display_Organization__ct || '—'}</div>
        {f.zz__Display_Contact__ct && (
          <div className="tkb-detail-contact">{f.zz__Display_Contact__ct}</div>
        )}

        {/* Status and lane are not repeated here: the card was opened from
            the lane that states both. */}
        <div className="tkb-detail-badges">
          {f['Type of Program'] && <span className="tkb-detail-badge">{f['Type of Program']}</span>}
          {f['Start Date'] && (
            <span className="tkb-detail-badge tkb-detail-badge--date">{f['Start Date']}</span>
          )}
        </div>

        <div className="tkb-detail-section">
          <div className="tkb-detail-label">Training cost</div>
          <div className="tkb-detail-cost">
            {cost.loading
              ? <span className="tkb-detail-cost-loading">Checking QuickBooks…</span>
              : cost.failed
                ? <span className="tkb-detail-cost-none">Couldn’t reach QuickBooks</span>
                : cost.value == null
                  ? <span className="tkb-detail-cost-none">No linked estimate</span>
                  : <><span className="tkb-detail-cost-num">{tkbMoney(cost.value)}</span>
                      <span className="tkb-detail-cost-src">live from QuickBooks</span></>}
          </div>
        </div>

        {trainers.length > 0 && (
          <div className="tkb-detail-section">
            <div className="tkb-detail-label">Trainers</div>
            <div className="tkb-detail-builders">
              {trainers.map(t => (
                <div key={t.label} className="tkb-detail-builder">
                  <span className="tkb-detail-builder-role">{t.label}</span>
                  <span className="tkb-detail-builder-name">{t.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Notes and Work Order Notes are both long free text and pushed the
            rest of the panel off screen. They are on the Trainings record,
            one click away via "Open in Trainings". */}

        <div className="tkb-detail-timestamps">
          {f.zz__Created_On && (
            <div className="tkb-detail-ts">
              <span className="tkb-detail-ts-label">Created</span>
              <span className="tkb-detail-ts-val">{f.zz__Created_On}</span>
            </div>
          )}
          {f.zz__Modified_On && (
            <div className="tkb-detail-ts">
              <span className="tkb-detail-ts-label">Modified</span>
              <span className="tkb-detail-ts-val">{f.zz__Modified_On}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function KanbanColumn({ column, records, saving, onOpen, collapsed, onToggleCollapse, search, onRemove }) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: column.id })
  const { attributes, listeners, setNodeRef: setSortRef, transform, transition, isDragging: isColDragging } = useSortable({
    id: `col::${column.id}`,
  })
  const matchCount = search ? records.filter(r => matchesSearch(r, search)).length : records.length

  return (
    <div
      ref={setSortRef}
      className={`tkb-col${isOver ? ' tkb-col--over' : ''}${collapsed ? ' tkb-col--collapsed' : ''}${isColDragging ? ' tkb-col--dragging' : ''}`}
      style={{
        '--col-color': column.color,
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <div className="tkb-col-header">
        <div
          className="tkb-col-drag-handle"
          {...listeners}
          {...attributes}
          title="Drag to reorder"
        >
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
            <circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/>
            <circle cx="2" cy="7" r="1.5"/><circle cx="8" cy="7" r="1.5"/>
            <circle cx="2" cy="12" r="1.5"/><circle cx="8" cy="12" r="1.5"/>
          </svg>
        </div>
        <span className="tkb-col-label" onClick={onToggleCollapse} title={collapsed ? 'Expand' : 'Collapse'}>
          {column.label}
        </span>
        <div className="tkb-col-header-right" onClick={onToggleCollapse} title={collapsed ? 'Expand' : 'Collapse'}>
          <span className="tkb-col-count">{search ? `${matchCount}/` : ''}{records.length}</span>
          <span className="tkb-col-chevron">{collapsed ? '›' : '‹'}</span>
        </div>
      </div>
      {!collapsed && (
        <div className="tkb-col-body" ref={setDropRef}>
          <SortableContext items={records.map(r => r.recordId)} strategy={verticalListSortingStrategy}>
            {records.map(r => {
              const matches = matchesSearch(r, search)
              return (
                <DraggableCard
                  key={r.recordId}
                  record={r}
                  saving={saving[r.recordId]}
                  onOpen={onOpen}
                  dimmed={search && !matches}
                  onRemove={onRemove}
                />
              )
            })}
          </SortableContext>
          {records.length === 0 && (
            <div className="tkb-col-empty">Drop here</div>
          )}
        </div>
      )}
    </div>
  )
}

// Searchable picker to add active-status trainings onto the board. Candidates
// are active-stage records not already on the board; clicking one adds it (it
// then drops out of the list). Stays open for bulk adding.
function AddToBoardPanel({ candidates, onAdd, onClose }) {
  const [q, setQ] = useState('')
  const [added, setAdded] = useState(() => new Set())
  const needle = q.trim().toLowerCase()
  const list = candidates
    .filter(r => !added.has(String(r.recordId)))
    .filter(r => !needle || matchesSearch(r, needle))
    .sort((a, b) => (a.fieldData.zz__Display_Organization__ct || '').localeCompare(b.fieldData.zz__Display_Organization__ct || ''))
    .slice(0, 200)

  return (
    <div className="tkb-add-overlay" onClick={onClose}>
      <div className="tkb-add-panel" onClick={e => e.stopPropagation()}>
        <div className="tkb-add-head">
          <span>Add trainings to the board</span>
          <button className="tkb-add-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <input className="tkb-add-search" autoFocus placeholder="Search active trainings…" value={q} onChange={e => setQ(e.target.value)} />
        <div className="tkb-add-list">
          {list.length === 0 && <div className="tkb-add-empty">{needle ? 'No matching active trainings.' : 'No active trainings left to add.'}</div>}
          {list.map(r => (
            <button key={r.recordId} className="tkb-add-row"
              onClick={() => { setAdded(p => new Set(p).add(String(r.recordId))); onAdd(r) }}>
              <span className="tkb-add-row-main">
                <span className="tkb-add-row-org">{r.fieldData.zz__Display_Organization__ct || '—'}</span>
                <span className="tkb-add-row-sub">{getStatus(r)}{r.fieldData['Start Date'] ? ` · ${r.fieldData['Start Date']}` : ''}</span>
              </span>
              <span className="tkb-add-row-plus">＋</span>
            </button>
          ))}
        </div>
        <div className="tkb-add-foot">{added.size > 0 ? `${added.size} added` : `${candidates.length} available`}</div>
      </div>
    </div>
  )
}

export default function TrainingsKanban({ navTarget, onNavigateTo, onClearNav }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState(() => {
    try { return JSON.parse(localStorage.getItem('tkb_collapsed') || '{}') } catch { return {} }
  })
  const [columnOrder, setColumnOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('tkb_col_order') || 'null')
      if (Array.isArray(saved) && saved.length === COLUMNS.length) return saved
    } catch {}
    return COLUMNS.map(c => c.id)
  })
  const orderedColumns = columnOrder.map(id => COLUMNS.find(c => c.id === id)).filter(Boolean)

  const { records, loading, fetching } = useAllRecords(LAYOUT, {
    cacheVersion: CACHE_VERSION,
    refreshKey,
  })
  const board = useTrainingsKanbanBoard()
  const order = useTrainingsKanbanOrder()
  const [showAdd, setShowAdd] = useState(false)

  // Stale-while-refreshing: show last complete fetch while a new one is in flight.
  const lastCompleteRef = useRef(records)
  if (!fetching) lastCompleteRef.current = records
  const displayRecords = fetching && lastCompleteRef.current.length > 0
    ? lastCompleteRef.current
    : records

  const [saving, setSaving] = useState({})
  const [activeId, setActiveId] = useState(null)
  const [detailRecord, setDetailRecord] = useState(null)
  const [saveError, setSaveError] = useState(null) // { org, why } — a refused move

  function handleRefresh() {
    if (refreshing || fetching) return
    bustCache(LAYOUT, CACHE_VERSION)
    setRefreshing(true)
    setRefreshKey(k => k + 1)
  }

  useEffect(() => {
    if (!fetching) setRefreshing(false)
  }, [fetching])

  useEffect(() => {
    if (navTarget?.moduleId !== 'trainings-kanban' || !navTarget.recordId) return;
    const record = displayRecords.find(r => String(r.recordId) === String(navTarget.recordId));
    if (record) { setDetailRecord(record); onClearNav?.(); }
  }, [navTarget, displayRecords])

  function toggleCollapse(colId) {
    setCollapsed(prev => {
      const next = { ...prev, [colId]: !prev[colId] }
      localStorage.setItem('tkb_collapsed', JSON.stringify(next))
      return next
    })
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  // Auto-scroll the board while a card is held near its left or right edge —
  // dnd-kit's built-in auto-scroll doesn't engage on this container. See the
  // identical effect in CCSKanban.jsx for the measurement that established
  // this is needed.
  const boardRef = useRef(null)
  const scrollDir = useRef(0)

  useEffect(() => {
    if (!activeId) return
    const EDGE_PX = 80, STEP_PX = 16
    const onMove = e => {
      const el = boardRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      scrollDir.current = e.clientX > r.right - EDGE_PX ? 1
        : e.clientX < r.left + EDGE_PX ? -1 : 0
    }
    let raf = 0
    const tick = () => {
      const el = boardRef.current
      if (el && scrollDir.current) el.scrollLeft += scrollDir.current * STEP_PX
      raf = requestAnimationFrame(tick)
    }
    window.addEventListener('pointermove', onMove)
    raf = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('pointermove', onMove)
      cancelAnimationFrame(raf)
      scrollDir.current = 0
    }
  }, [activeId])

  // The card's lane is simply the record's status — no optimistic override.
  // Writing straight to Vibe (updateVibeRecord) lands in ~50ms, so
  // patchCachedRecord's immediate cache update is all the card needs; see
  // CCSKanban.jsx's comment for the three-bugs history of the alternative.
  const kanbanRecords = displayRecords

  // Board membership is curated by the team (a shared Redis set), AND the
  // card's status must be an active stage — so a training the team added
  // drops off once it's Final Invoiced / No Go.
  const active = kanbanRecords.filter(r => board.ids.has(String(r.recordId)) && ACTIVE_STATUSES.has(getStatus(r)))

  const byColumn = {}
  for (const col of COLUMNS) byColumn[col.id] = []
  for (const r of active) {
    const s = getStatus(r)
    if (byColumn[s]) byColumn[s].push(r)
  }
  // Apply the team's manual order (Redis, shared): stored recordIds sort
  // first in their saved sequence; anything not yet placed falls back to the
  // default order at the end.
  for (const col of COLUMNS) {
    const savedOrder = order.orders[col.id]
    if (!savedOrder?.length) continue
    const idx = new Map(savedOrder.map((id, i) => [id, i]))
    const known = byColumn[col.id].filter(r => idx.has(r.recordId)).sort((a, b) => idx.get(a.recordId) - idx.get(b.recordId))
    const unknown = byColumn[col.id].filter(r => !idx.has(r.recordId))
    byColumn[col.id] = [...known, ...unknown]
  }
  const cardColumnOf = {}
  for (const col of COLUMNS) for (const r of byColumn[col.id]) cardColumnOf[r.recordId] = col.id

  const activeRecord = activeId ? kanbanRecords.find(r => r.recordId === activeId) : null

  const handleDragStart = ({ active }) => setActiveId(active.id)

  const handleDragEnd = useCallback(async ({ active, over }) => {
    setActiveId(null)
    if (!over) return

    // Column reorder
    if (String(active.id).startsWith('col::')) {
      const fromId = String(active.id).slice(5)
      const toId = String(over.id).startsWith('col::') ? String(over.id).slice(5) : null
      if (!toId || fromId === toId) return
      setColumnOrder(prev => {
        const oldIdx = prev.indexOf(fromId)
        const newIdx = prev.indexOf(toId)
        const next = arrayMove(prev, oldIdx, newIdx)
        localStorage.setItem('tkb_col_order', JSON.stringify(next))
        return next
      })
      return
    }

    // Card move / reorder. `over.id` is either a column (dropped on empty
    // space) or another card (dropped directly on it), which is how a
    // same-lane reorder is told apart from a cross-lane status change.
    const overIsColumn = String(over.id).startsWith('col::') || ACTIVE_STATUSES.has(String(over.id))
    const targetColumn = overIsColumn
      ? (String(over.id).startsWith('col::') ? String(over.id).slice(5) : String(over.id))
      : cardColumnOf[over.id]
    if (!targetColumn || !ACTIVE_STATUSES.has(targetColumn)) return

    const record = kanbanRecords.find(r => r.recordId === active.id)
    if (!record) return
    const sourceColumn = cardColumnOf[active.id] ?? getStatus(record)

    // Compute + persist the target lane's new order (shared, Redis).
    const targetIds = (byColumn[targetColumn] || []).map(r => r.recordId)
    let newTargetOrder
    if (sourceColumn === targetColumn) {
      const oldIdx = targetIds.indexOf(active.id)
      const newIdx = overIsColumn ? targetIds.length - 1 : targetIds.indexOf(String(over.id))
      if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return
      newTargetOrder = arrayMove(targetIds, oldIdx, newIdx)
    } else {
      const insertAt = overIsColumn ? targetIds.length : targetIds.indexOf(String(over.id))
      newTargetOrder = [...targetIds]
      newTargetOrder.splice(insertAt === -1 ? newTargetOrder.length : insertAt, 0, active.id)
    }
    order.setColumnOrder(targetColumn, newTargetOrder)

    if (sourceColumn === targetColumn) return // pure reorder — no status change

    const previous = getStatus(record)
    setSaving(p => ({ ...p, [active.id]: true }))
    patchCachedRecord(LAYOUT, CACHE_VERSION, active.id, { Status: targetColumn })

    try {
      await updateVibeRecord(LAYOUT, active.id, { Status: targetColumn })
    } catch (err) {
      patchCachedRecord(LAYOUT, CACHE_VERSION, active.id, { Status: previous })
      setSaveError({
        org: record.fieldData.zz__Display_Organization__ct || 'That training',
        why: err?.message || 'Save failed',
      })
    } finally {
      setSaving(p => { const n = { ...p }; delete n[active.id]; return n })
    }
  }, [kanbanRecords, byColumn, cardColumnOf, order])

  const totalActive = active.length
  const searchMatchCount = search ? active.filter(r => matchesSearch(r, search)).length : totalActive

  return (
    <div className="tkb-root">
      <div className="tkb-topbar">
        <button
          className={`tkb-refresh${refreshing || fetching ? ' tkb-refresh--spinning' : ''}`}
          onClick={handleRefresh}
          title="Refresh"
          aria-label="Refresh kanban"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12.5 7A5.5 5.5 0 1 1 7 1.5a5.5 5.5 0 0 1 4.5 2.33" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            <path d="M11.5 1.5v2.5H9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <span className="tkb-title">Trainings Kanban</span>
        {fetching && !refreshing && <span className="tkb-loading">Loading…</span>}
        {!loading && (
          <span className="tkb-count">
            {search ? `${searchMatchCount} of ` : ''}{totalActive} active
          </span>
        )}
        <div className="tkb-search-wrap">
          <svg className="tkb-search-icon" width="13" height="13" viewBox="0 0 13 13" fill="none">
            <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M9 9l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          <input
            className="tkb-search"
            type="text"
            placeholder="Filter cards…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="tkb-search-clear" onClick={() => setSearch('')} aria-label="Clear search">✕</button>
          )}
        </div>
        <button className="tkb-add-btn" onClick={() => setShowAdd(true)} title="Add trainings to the board">＋ Add trainings</button>
      </div>
      {saveError && (
        <div className="tkb-save-error" role="alert">
          <span className="tkb-save-error-ic">⚠</span>
          <span><strong>{saveError.org}</strong> stayed where it was — {saveError.why}</span>
          <button className="tkb-save-error-x" onClick={() => setSaveError(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
      {showAdd && (
        <AddToBoardPanel
          candidates={displayRecords.filter(r => ACTIVE_STATUSES.has(getStatus(r)) && !board.ids.has(String(r.recordId)))}
          onAdd={r => board.toggle(r.recordId, true)}
          onClose={() => setShowAdd(false)}
        />
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      >
        <SortableContext items={orderedColumns.map(c => `col::${c.id}`)} strategy={horizontalListSortingStrategy}>
          <div className="tkb-board" ref={boardRef}>
            {orderedColumns.map(col => (
              <KanbanColumn
                key={col.id}
                column={col}
                records={byColumn[col.id] || []}
                saving={saving}
                onOpen={setDetailRecord}
                collapsed={!!collapsed[col.id]}
                onToggleCollapse={() => toggleCollapse(col.id)}
                search={search}
                onRemove={r => board.toggle(r.recordId, false)}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeRecord && <KanbanCardView record={activeRecord} />}
        </DragOverlay>
      </DndContext>
      {detailRecord && (
        <KanbanDetail
          record={detailRecord}
          onClose={() => setDetailRecord(null)}
          onNavigateTo={onNavigateTo}
        />
      )}
    </div>
  )
}
