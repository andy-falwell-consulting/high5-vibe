import { useState, useCallback, useRef, useEffect } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useAllRecords } from '../hooks/useAllRecords'
import { updateRecord, bustCache, patchCachedRecord } from '../api/filemaker'
import { RCD_LAYOUT, RCD_CACHE_VERSION, RCD_FIND_QUERY, RCD_SORT } from '../config/ccsCache'
import './CCSKanban.css'

const LAYOUT = RCD_LAYOUT
const CACHE_VERSION = RCD_CACHE_VERSION

const COLUMNS = [
  { id: 'New Project Inquiry',          label: 'New Project Inquiry',          color: '#3b82f6' },
  { id: 'Working Proposals',            label: 'Working Proposals',            color: '#e87722' },
  { id: 'Proposals Out',                label: 'Proposals Out',                color: '#f59e0b' },
  { id: 'Sent Contract and DI',         label: 'Sent Contract and DI',         color: '#a855f7' },
  { id: 'Job Prep by Date',             label: 'Job Prep by Date',             color: '#22c55e' },
  { id: 'Done/Ready for Building',      label: 'Done/Ready for Building',      color: '#14b8a6' },
  { id: 'Commissioning Report Needed',  label: 'Commissioning Report Needed',  color: '#e8322a' },
  { id: "No Go's (litter box)",         label: "No Go's",                      color: '#475569' },
]
const ACTIVE_STATUSES = new Set(COLUMNS.map(c => c.id))

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

function KanbanCardView({ record, saving, dimmed }) {
  const f = record.fieldData
  const wo = f['Work Order']
  return (
    <div className={`kb-card${saving ? ' kb-card--saving' : ''}${dimmed ? ' kb-card--dimmed' : ''}`}>
      <div className="kb-card-org">{f.zz__Display_Organization__ct || '—'}</div>
      {f.zz__Display_Contact__ct && (
        <div className="kb-card-contact">{f.zz__Display_Contact__ct}</div>
      )}
      <div className="kb-card-meta">
        {f['Type of Project(1)'] && (
          <span className="kb-card-type">{f['Type of Project(1)']}</span>
        )}
        {f['rcd start date'] && (
          <span className="kb-card-date">{f['rcd start date']}</span>
        )}
        {f['Lead Builder'] && (
          <span className="kb-card-builder">{f['Lead Builder']}</span>
        )}
      </div>
      {wo && (
        <div className="kb-card-wo">{wo.length > 70 ? wo.slice(0, 70) + '…' : wo}</div>
      )}
    </div>
  )
}

function DraggableCard({ record, saving, onOpen, dimmed }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
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
      style={{ opacity: isDragging ? 0.25 : 1, cursor: 'grab', touchAction: 'none', userSelect: 'none' }}
      onClick={() => {
        if (didDrag.current) { didDrag.current = false; return }
        onOpen(record)
      }}
    >
      <KanbanCardView record={record} saving={saving} dimmed={dimmed} />
    </div>
  )
}

function KanbanDetail({ record, onClose, currentStatus, onNavigateTo }) {
  const f = record.fieldData

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

  const col = COLUMNS.find(c => c.id === currentStatus)

  return (
    <div className="kb-overlay" onClick={onClose}>
      <div className="kb-detail" onClick={e => e.stopPropagation()}>
        <button className="kb-detail-close" onClick={onClose} aria-label="Close">✕</button>
        <button className="kb-detail-nav-btn" onClick={() => { onNavigateTo?.('ccs', record.recordId); onClose(); }}>Open in CCS ◈</button>

        <div className="kb-detail-org">{f.zz__Display_Organization__ct || '—'}</div>
        {f.zz__Display_Contact__ct && (
          <div className="kb-detail-contact">{f.zz__Display_Contact__ct}</div>
        )}

        <div className="kb-detail-badges">
          {f['Type of Project(1)'] && (
            <span className="kb-detail-badge">{f['Type of Project(1)']}</span>
          )}
          {f['rcd start date'] && (
            <span className="kb-detail-badge kb-detail-badge--date">{f['rcd start date']}</span>
          )}
          {f.Status && (
            <span className="kb-detail-badge kb-detail-badge--status">{f.Status}</span>
          )}
          {col && (
            <span className="kb-detail-badge kb-detail-badge--kanban" style={{ '--badge-color': col.color }}>
              {col.label}
            </span>
          )}
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

        {f['Work Order'] && (
          <div className="kb-detail-section">
            <div className="kb-detail-label">Work Order Notes</div>
            <div className="kb-detail-wo">{f['Work Order']}</div>
          </div>
        )}

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

function KanbanColumn({ column, records, saving, onOpen, collapsed, onToggleCollapse, search }) {
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
          {records.map(r => {
            const matches = matchesSearch(r, search)
            return (
              <DraggableCard
                key={r.recordId}
                record={r}
                saving={saving[r.recordId]}
                onOpen={onOpen}
                dimmed={search && !matches}
              />
            )
          })}
          {records.length === 0 && (
            <div className="kb-col-empty">Drop here</div>
          )}
        </div>
      )}
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

  // Stale-while-refreshing: show last complete fetch while a new one is in flight.
  // lastCompleteRef seeds from the cache-hydrated `records` so there is zero flash on load.
  const lastCompleteRef = useRef(records)
  if (!fetching) lastCompleteRef.current = records
  const displayRecords = fetching && lastCompleteRef.current.length > 0
    ? lastCompleteRef.current
    : records

  const [localStatus, setLocalStatus] = useState({})
  const [saving, setSaving] = useState({})
  const [activeId, setActiveId] = useState(null)
  const [detailRecord, setDetailRecord] = useState(null)
  const localStatusRef = useRef({})

  function handleRefresh() {
    if (refreshing || fetching) return
    bustCache(LAYOUT, CACHE_VERSION)
    setLocalStatus({})
    localStatusRef.current = {}
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

  const getStatus = useCallback((r) => {
    return localStatusRef.current[r.recordId] ?? r.fieldData.kanban_status
  }, [])

  // Filter to only kanban records, then by active status. RCD_New has no
  // add_to_kanban flag, so board membership = has a kanban_status.
  const kanbanRecords = displayRecords.filter(r => !!String(r.fieldData.kanban_status || '').trim())
  const active = kanbanRecords.filter(r => ACTIVE_STATUSES.has(getStatus(r)))

  const byColumn = {}
  for (const col of COLUMNS) byColumn[col.id] = []
  for (const r of active) {
    const s = getStatus(r)
    if (byColumn[s]) byColumn[s].push(r)
  }

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

    // Card move
    const newStatus = String(over.id).startsWith('col::') ? String(over.id).slice(5) : over.id
    if (!ACTIVE_STATUSES.has(newStatus)) return
    const record = kanbanRecords.find(r => r.recordId === active.id)
    if (!record) return
    const oldStatus = localStatusRef.current[active.id] ?? record.fieldData.kanban_status
    if (oldStatus === newStatus) return

    localStatusRef.current[active.id] = newStatus
    setLocalStatus(p => ({ ...p, [active.id]: newStatus }))
    setSaving(p => ({ ...p, [active.id]: true }))

    try {
      await updateRecord(LAYOUT, active.id, { kanban_status: newStatus })
      patchCachedRecord(LAYOUT, CACHE_VERSION, active.id, { kanban_status: newStatus })
    } catch {
      localStatusRef.current[active.id] = oldStatus
      setLocalStatus(p => ({ ...p, [active.id]: oldStatus }))
    } finally {
      setSaving(p => { const n = { ...p }; delete n[active.id]; return n })
    }
  }, [kanbanRecords])

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
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={orderedColumns.map(c => `col::${c.id}`)} strategy={horizontalListSortingStrategy}>
          <div className="kb-board">
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
          currentStatus={localStatusRef.current[detailRecord.recordId] ?? detailRecord.fieldData.kanban_status}
          onClose={() => setDetailRecord(null)}
          onNavigateTo={onNavigateTo}
        />
      )}
    </div>
  )
}
