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
import { RCD_LAYOUT, RCD_CACHE_VERSION, RCD_FIND_QUERY, RCD_SORT } from '../config/ccsCache'
import { ACTIVE_STAGES, PIPELINE_STAGES, PIPELINE_SHORT, statusColor, mergedStatus } from '../config/ccsStatus'
import { useKanbanBoard } from '../hooks/useKanbanBoard'
import { useKanbanOrder } from '../hooks/useKanbanOrder'
import { useOpsLeads } from '../hooks/useOpsLeads'
import './CCSKanban.css'

const LAYOUT = RCD_LAYOUT
const CACHE_VERSION = RCD_CACHE_VERSION

// Board columns = the merged active/in-flight stages (Completed / No Go / Other
// are valid statuses but not columns — a card set to one leaves the board).
// Headers use the SHORT stage labels the pipeline dots and Home funnel already
// use: at 180px a lane cannot fit "Proposed Dates, Sent Contract & DI" without
// wrapping to three lines and shoving the cards down.
const COLUMNS = ACTIVE_STAGES.map(id => ({
  id,
  label: PIPELINE_SHORT[PIPELINE_STAGES.indexOf(id)] ?? id,
  color: statusColor(id),
}))
const ACTIVE_STATUSES = new Set(ACTIVE_STAGES)

function matchesSearch(r, q) {
  if (!q) return true
  const f = r.fieldData
  const haystack = [
    f.zz__Display_Organization__ct,
    f.zz__Display_Contact__ct,
    f['Type of Project(1)'],
    f['Lead Builder'], f.Builder1, f.Builder2, f.Builder3,
    f['Work Order'],
  ].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(q.toLowerCase())
}

function KanbanCardView({ record, saving, dimmed, opsLead }) {
  const f = record.fieldData
  // Type of Project is a 3-rep FileMaker field, and a project can carry more
  // than one — 86 of 1,000 do, 8 carry three. Showing only rep 1 hid the rest.
  const types = [1, 2, 3].map(i => f[`Type of Project(${i})`]).filter(Boolean)
  return (
    <div className={`kb-card${saving ? ' kb-card--saving' : ''}${dimmed ? ' kb-card--dimmed' : ''}`}>
      <div className="kb-card-org">{f.zz__Display_Organization__ct || '—'}</div>
      <div className="kb-card-meta">
        {types.map(t => <span className="kb-card-type" key={t}>{t}</span>)}
        {f['rcd start date'] && (
          <span className="kb-card-date">{f['rcd start date']}</span>
        )}
      </div>
      {/* The ops lead, not the lead builder: the board is used to see who is
          running a job, and that is a Vibe-held assignment (useOpsLeads), not
          FileMaker's 'Lead Builder'. */}
      {opsLead && (
        <div className="kb-card-ops"><span className="kb-card-ops-ic">◇</span>{opsLead}</div>
      )}
    </div>
  )
}

// Sortable, not just draggable: within a lane, dropping a card ON another
// card reorders between them (over.id resolves to that specific card's id,
// not just "somewhere in this column") — see handleDragEnd for how that's
// distinguished from a cross-lane move.
function DraggableCard({ record, saving, onOpen, dimmed, onRemove, leadFor }) {
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
      <KanbanCardView record={record} saving={saving} dimmed={dimmed} opsLead={leadFor?.(record.recordId)} />
      {onRemove && (
        <button className="kb-card-remove" title="Remove from board"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onRemove(record) }}>✕</button>
      )}
    </div>
  )
}

// Project cost is NOT a FileMaker field — RCD_New carries no populated money
// field (the two that exist, cntct_PMT/cntct_INVO, resolve through globally
// filtered portals and come back empty over the Data API). The figure lives in
// QuickBooks, so it is fetched per card open from the same endpoint the
// Workspace uses. null = no usable estimate linked, which is also what shows
// when every linked estimate belongs to a different customer.
// `loading` is DERIVED from whether the settled result belongs to the record
// being shown, rather than stored and reset at the top of the effect. The
// component instance is reused when the board opens a different card, so a
// synchronous reset there would both trip react-hooks/set-state-in-effect and
// cascade an extra render; comparing ids covers the switch for free.
function useProjectCost(recordId) {
  const [result, setResult] = useState({ id: null, value: null, failed: false })

  useEffect(() => {
    let alive = true
    fetch(`/api/ccs-estimate?db=${encodeURIComponent(getCurrentEnv().db)}&recordId=${recordId}`,
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

const kbMoney = v => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

function KanbanDetail({ record, onClose, onNavigateTo, opsLead }) {
  const f = record.fieldData
  const cost = useProjectCost(record.recordId)

  // Same 3-rep field as the card face — a project can hold up to three types.
  const types = [1, 2, 3].map(i => f[`Type of Project(${i})`]).filter(Boolean)

  const builders = [
    f['Lead Builder'] && { label: 'Lead', name: f['Lead Builder'] },
    f.Builder1 && { label: 'Builder 1', name: f.Builder1 },
    f.Builder2 && { label: 'Builder 2', name: f.Builder2 },
    f.Builder3 && { label: 'Builder 3', name: f.Builder3 },
  ].filter(Boolean)

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="kb-overlay" onClick={onClose}>
      <div className="kb-detail" onClick={e => e.stopPropagation()}>
        <button className="kb-detail-close" onClick={onClose} aria-label="Close">✕</button>
        {/* 'ccs-v2' is the Workspace — phases, financials, QuickBooks, and the
            Notes and Work Order text this panel no longer repeats. See
            CHILD_TO_VIEW in ProjectsWorkspace.jsx. */}
        <button className="kb-detail-nav-btn" onClick={() => { onNavigateTo?.('ccs-v2', record.recordId); onClose(); }}>Open in CCS ◈</button>

        <div className="kb-detail-org">{f.zz__Display_Organization__ct || '—'}</div>
        {f.zz__Display_Contact__ct && (
          <div className="kb-detail-contact">{f.zz__Display_Contact__ct}</div>
        )}

        {/* Status and swimlane are not repeated here: the card was opened from
            the lane that states both, so restating them spent the top of the
            panel on what the reader had just clicked through. */}
        <div className="kb-detail-badges">
          {types.map(t => <span className="kb-detail-badge" key={t}>{t}</span>)}
          {f['rcd start date'] && (
            <span className="kb-detail-badge kb-detail-badge--date">{f['rcd start date']}</span>
          )}
        </div>

        <div className="kb-detail-section">
          <div className="kb-detail-label">Operations lead</div>
          {/* Vibe-only field held in Redis (api/ops-lead.js), not FileMaker.
              Read-only here to keep this panel a summary — it is edited on the
              CCS record itself. */}
          <div className="kb-detail-ops">{opsLead || <span className="kb-detail-ops-none">Unassigned</span>}</div>
        </div>

        <div className="kb-detail-section">
          <div className="kb-detail-label">Project cost</div>
          <div className="kb-detail-cost">
            {cost.loading
              ? <span className="kb-detail-cost-loading">Checking QuickBooks…</span>
              : cost.failed
                ? <span className="kb-detail-cost-none">Couldn’t reach QuickBooks</span>
                : cost.value == null
                  ? <span className="kb-detail-cost-none">No linked estimate</span>
                  : <><span className="kb-detail-cost-num">{kbMoney(cost.value)}</span>
                      <span className="kb-detail-cost-src">live from QuickBooks</span></>}
          </div>
        </div>

        {builders.length > 0 && (
          <div className="kb-detail-section">
            <div className="kb-detail-label">Team</div>
            <div className="kb-detail-builders">
              {builders.map(b => (
                <div key={b.label} className="kb-detail-builder">
                  <span className="kb-detail-builder-role">{b.label}</span>
                  <span className="kb-detail-builder-name">{b.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Notes and Work Order notes are both long free text and pushed the
            rest of the panel off screen. They are on the CCS record, one click
            away via "Open in CCS". */}

        <div className="kb-detail-timestamps">
          {f.zz__Created_On && (
            <div className="kb-detail-ts">
              <span className="kb-detail-ts-label">Created</span>
              <span className="kb-detail-ts-val">{f.zz__Created_On}</span>
            </div>
          )}
          {f.zz__Modified_On && (
            <div className="kb-detail-ts">
              <span className="kb-detail-ts-label">Modified</span>
              <span className="kb-detail-ts-val">{f.zz__Modified_On}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function KanbanColumn({ column, records, saving, onOpen, collapsed, onToggleCollapse, search, onRemove, leadFor }) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: column.id })
  const { attributes, listeners, setNodeRef: setSortRef, transform, transition, isDragging: isColDragging } = useSortable({
    id: `col::${column.id}`,
  })
  const matchCount = search ? records.filter(r => matchesSearch(r, search)).length : records.length

  return (
    <div
      ref={setSortRef}
      className={`kb-col${isOver ? ' kb-col--over' : ''}${collapsed ? ' kb-col--collapsed' : ''}${isColDragging ? ' kb-col--dragging' : ''}`}
      style={{
        '--col-color': column.color,
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <div className="kb-col-header">
        <div
          className="kb-col-drag-handle"
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
        <span className="kb-col-label" onClick={onToggleCollapse} title={collapsed ? 'Expand' : 'Collapse'}>
          {column.label}
        </span>
        <div className="kb-col-header-right" onClick={onToggleCollapse} title={collapsed ? 'Expand' : 'Collapse'}>
          <span className="kb-col-count">{search ? `${matchCount}/` : ''}{records.length}</span>
          <span className="kb-col-chevron">{collapsed ? '›' : '‹'}</span>
        </div>
      </div>
      {!collapsed && (
        <div className="kb-col-body" ref={setDropRef}>
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
                  leadFor={leadFor}
                />
              )
            })}
          </SortableContext>
          {records.length === 0 && (
            <div className="kb-col-empty">Drop here</div>
          )}
        </div>
      )}
    </div>
  )
}

// Searchable picker to add active-status projects onto the board. Candidates
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
    <div className="kb-add-overlay" onClick={onClose}>
      <div className="kb-add-panel" onClick={e => e.stopPropagation()}>
        <div className="kb-add-head">
          <span>Add projects to the board</span>
          <button className="kb-add-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <input className="kb-add-search" autoFocus placeholder="Search active projects…" value={q} onChange={e => setQ(e.target.value)} />
        <div className="kb-add-list">
          {list.length === 0 && <div className="kb-add-empty">{needle ? 'No matching active projects.' : 'No active projects left to add.'}</div>}
          {list.map(r => (
            <button key={r.recordId} className="kb-add-row"
              onClick={() => { setAdded(p => new Set(p).add(String(r.recordId))); onAdd(r) }}>
              <span className="kb-add-row-main">
                <span className="kb-add-row-org">{r.fieldData.zz__Display_Organization__ct || '—'}</span>
                <span className="kb-add-row-sub">{mergedStatus(r.fieldData)}{r.fieldData['rcd start date'] ? ` · ${r.fieldData['rcd start date']}` : ''}</span>
              </span>
              <span className="kb-add-row-plus">＋</span>
            </button>
          ))}
        </div>
        <div className="kb-add-foot">{added.size > 0 ? `${added.size} added` : `${candidates.length} available`}</div>
      </div>
    </div>
  )
}

export default function CCSKanban({ navTarget, onNavigateTo, onClearNav }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState(() => {
    try { return JSON.parse(localStorage.getItem('kb_collapsed') || '{}') } catch { return {} }
  })
  const [columnOrder, setColumnOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('kb_col_order') || 'null')
      if (Array.isArray(saved) && saved.length === COLUMNS.length) return saved
    } catch {}
    return COLUMNS.map(c => c.id)
  })
  const orderedColumns = columnOrder.map(id => COLUMNS.find(c => c.id === id)).filter(Boolean)

  const { records, loading, fetching } = useAllRecords(LAYOUT, {
    cacheVersion: CACHE_VERSION,
    findQuery: RCD_FIND_QUERY,
    sort: RCD_SORT,
    refreshKey,
  })
  const board = useKanbanBoard()
  const order = useKanbanOrder()
  const opsLead = useOpsLeads(getCurrentEnv().db)
  const [showAdd, setShowAdd] = useState(false)

  // Stale-while-refreshing: show last complete fetch while a new one is in flight.
  // lastCompleteRef seeds from the cache-hydrated `records` so there is zero flash on load.
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
    if (navTarget?.moduleId !== 'ccs-kanban' || !navTarget.recordId) return;
    const record = displayRecords.find(r => String(r.recordId) === String(navTarget.recordId));
    if (record) { setDetailRecord(record); onClearNav?.(); }
  }, [navTarget, displayRecords])

  function toggleCollapse(colId) {
    setCollapsed(prev => {
      const next = { ...prev, [colId]: !prev[colId] }
      localStorage.setItem('kb_collapsed', JSON.stringify(next))
      return next
    })
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  // Auto-scroll the board while a card is held near its left or right edge.
  //
  // The board scrolls horizontally but dnd-kit's built-in auto-scroll does not
  // engage on this container — measured: holding a dragged card against the
  // right edge for 1.6s left scrollLeft at 0 with 572px still off screen, so any
  // lane outside the viewport was impossible to drop onto. Narrower columns (see
  // CCSKanban.css) mean six lanes usually fit; this covers the windows where
  // they do not.
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

  // The card's lane is simply the record's status. There is no optimistic
  // override any more.
  //
  // There used to be one, because a drag wrote to FileMaker and the replica
  // could take five minutes to agree — so the card had to be pinned to the
  // dropped lane in the meantime, and untangling when to STOP pinning it took
  // three attempts (v1.0.275, v1.0.277, v1.0.283). Writing to Vibe removes the
  // problem rather than managing it: the write lands in ~50ms, patchCachedRecord
  // updates the list immediately, and nothing downstream can revert it.
  const getStatus = useCallback((r) => mergedStatus(r.fieldData), [])

  // Board membership is curated by the team (a shared Redis set), AND the card's
  // merged status must be an active stage — so a job the team added drops off
  // once it's Completed / No Go.
  const kanbanRecords = displayRecords
  const active = kanbanRecords.filter(r => board.ids.has(String(r.recordId)) && ACTIVE_STATUSES.has(getStatus(r)))

  const byColumn = {}
  for (const col of COLUMNS) byColumn[col.id] = []
  for (const r of active) {
    const s = getStatus(r)
    if (byColumn[s]) byColumn[s].push(r)
  }
  // Apply the team's manual order (Redis, shared): stored recordIds sort
  // first in their saved sequence; anything not yet placed (new to the
  // board, never manually dragged) falls back to the default order at the end.
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
        localStorage.setItem('kb_col_order', JSON.stringify(next))
        return next
      })
      return
    }

    // Card move / reorder. `over.id` is either a column (dropped on empty
    // space — via the column's own useDroppable) or another card (dropped
    // directly on it — via that card's useSortable), which is how we tell a
    // same-lane reorder from a cross-lane status change.
    const overIsColumn = String(over.id).startsWith('col::') || ACTIVE_STATUSES.has(String(over.id))
    const targetColumn = overIsColumn
      ? (String(over.id).startsWith('col::') ? String(over.id).slice(5) : String(over.id))
      : cardColumnOf[over.id]
    if (!targetColumn || !ACTIVE_STATUSES.has(targetColumn)) return

    const record = kanbanRecords.find(r => r.recordId === active.id)
    if (!record) return
    const sourceColumn = cardColumnOf[active.id] ?? mergedStatus(record.fieldData)

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

    const previous = mergedStatus(record.fieldData)
    setSaving(p => ({ ...p, [active.id]: true }))
    // Patch the cache first so the card moves at once; the write is fast enough
    // that a failure rolling it back is barely visible, and nothing else can
    // overwrite it in the meantime.
    patchCachedRecord(LAYOUT, CACHE_VERSION, active.id, { Status: targetColumn })

    try {
      await updateVibeRecord(LAYOUT, active.id, { Status: targetColumn })
    } catch (err) {
      patchCachedRecord(LAYOUT, CACHE_VERSION, active.id, { Status: previous })
      // A card that silently slides back is what made this read as "drag doesn't
      // work" rather than "the save was refused". Say which.
      setSaveError({
        org: record.fieldData.zz__Display_Organization__ct || 'That project',
        why: err?.message || 'Save failed',
      })
    } finally {
      setSaving(p => { const n = { ...p }; delete n[active.id]; return n })
    }
  }, [kanbanRecords, byColumn, cardColumnOf, order])

  const totalActive = active.length
  const searchMatchCount = search ? active.filter(r => matchesSearch(r, search)).length : totalActive

  return (
    <div className="kb-root">
      <div className="kb-topbar">
        <button
          className={`kb-refresh${refreshing || fetching ? ' kb-refresh--spinning' : ''}`}
          onClick={handleRefresh}
          title="Refresh"
          aria-label="Refresh kanban"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12.5 7A5.5 5.5 0 1 1 7 1.5a5.5 5.5 0 0 1 4.5 2.33" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            <path d="M11.5 1.5v2.5H9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <span className="kb-title">CCS Kanban</span>
        {fetching && !refreshing && <span className="kb-loading">Loading…</span>}
        {!loading && (
          <span className="kb-count">
            {search ? `${searchMatchCount} of ` : ''}{totalActive} active
          </span>
        )}
        <div className="kb-search-wrap">
          <svg className="kb-search-icon" width="13" height="13" viewBox="0 0 13 13" fill="none">
            <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M9 9l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          <input
            className="kb-search"
            type="text"
            placeholder="Filter cards…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="kb-search-clear" onClick={() => setSearch('')} aria-label="Clear search">✕</button>
          )}
        </div>
        <button className="kb-add-btn" onClick={() => setShowAdd(true)} title="Add projects to the board">＋ Add projects</button>
      </div>
      {saveError && (
        <div className="kb-save-error" role="alert">
          <span className="kb-save-error-ic">⚠</span>
          <span><strong>{saveError.org}</strong> stayed where it was — {saveError.why}</span>
          <button className="kb-save-error-x" onClick={() => setSaveError(null)} aria-label="Dismiss">✕</button>
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
        // Re-measure droppables continuously. Default measuring happens once at
        // drag start, so a lane scrolled into view mid-drag would keep its old
        // (off-screen) rect and reject the drop — undoing the auto-scroll above.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      >
        <SortableContext items={orderedColumns.map(c => `col::${c.id}`)} strategy={horizontalListSortingStrategy}>
          <div className="kb-board" ref={boardRef}>
            {orderedColumns.map(col => (
              <KanbanColumn
                leadFor={opsLead.leadFor}
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
          opsLead={opsLead.leadFor(detailRecord.recordId)}
          record={detailRecord}
          onClose={() => setDetailRecord(null)}
          onNavigateTo={onNavigateTo}
        />
      )}
    </div>
  )
}
