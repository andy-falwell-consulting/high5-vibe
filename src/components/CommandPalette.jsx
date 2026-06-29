import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { readCacheAsync } from '../api/filemaker'
import { RCD_CACHE_VERSION } from '../config/ccsCache'

// Cross-module record sources — read from the already-prewarmed caches.
const SOURCES = [
  { module: 'contacts', layout: 'Contacts_New', cv: 2, type: 'Contact', icon: '◉', color: '#8b5cf6',
    title: f => f.zz__Display__ct, sub: f => f['cntct_ADDR::zz__Display_Single_Line_No_Zip__ct'] || f.Type || '' },
  { module: 'inspections', layout: 'Inspections_New', cv: 1, type: 'Inspection', icon: '⚑', color: '#3b82f6',
    title: f => f.Organization || f['inspt_CNTCT__site::Name_Organization'],
    sub: f => [f['inspt_CNTCT__site::Site Number'], f.Date].filter(Boolean).join(' · ') },
  { module: 'projects', layout: 'RCD_New', cv: RCD_CACHE_VERSION, type: 'Project', icon: '◈', color: '#e8722a',
    title: f => f.zz__Display_Organization__ct,
    sub: f => [f['Type of Project(1)'], f.kanban_status].filter(Boolean).join(' · ') },
  { module: 'products', layout: 'Products & Services_New', cv: 4, type: 'Product', icon: '◫', color: '#d97706',
    title: f => f.Name, sub: f => f.SKU || f.Category || '' },
]

const PER_SOURCE = 6
const clean = v => (v || '').replace(/[\r\n]+/g, ' ').trim()

export default function CommandPalette({ open, onClose, onPick, onAsk, modules, theme, onToggleTheme }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [datasets, setDatasets] = useState(null)
  const inputRef = useRef(null)

  // Load all module caches once when first opened
  useEffect(() => {
    if (!open || datasets) return
    let alive = true
    Promise.all(SOURCES.map(s => readCacheAsync(s.layout, s.cv).then(r => r?.records || []).catch(() => [])))
      .then(arr => { if (alive) setDatasets(Object.fromEntries(SOURCES.map((s, i) => [s.module, arr[i]]))) })
    return () => { alive = false }
  }, [open, datasets])

  // Reset + focus on open
  useEffect(() => {
    if (open) { setQuery(''); setActive(0); requestAnimationFrame(() => inputRef.current?.focus()) }
  }, [open])

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = []
    let idx = 0
    const withIdx = items => items.map(it => ({ ...it, idx: idx++ }))

    if (q && datasets) {
      const records = []
      for (const s of SOURCES) {
        const data = datasets[s.module] || []
        let n = 0
        for (const r of data) {
          const t = clean(s.title(r.fieldData))
          const sub = clean(s.sub(r.fieldData))
          if (t.toLowerCase().includes(q) || sub.toLowerCase().includes(q)) {
            records.push({ kind: 'record', module: s.module, recordId: r.recordId, title: t || '(untitled)', sub, type: s.type, icon: s.icon, color: s.color })
            if (++n >= PER_SOURCE) break
          }
        }
      }
      if (records.length) out.push({ label: 'Jump to record', items: withIdx(records) })
    }

    const pages = modules
      .filter(m => !q || m.label.toLowerCase().includes(q))
      .map(m => ({ kind: 'page', module: m.id, title: m.label, icon: m.icon }))
    if (pages.length) out.push({ label: 'Go to', items: withIdx(pages) })

    // Always offer the assistant — it handles anything that isn't a direct record
    // jump (invoice amounts/dates, totals, cross-system questions, free-form asks).
    const askText = query.trim()
    out.push({ label: 'Assistant', items: withIdx([{
      kind: 'ask', query: askText, icon: '✦', color: '#e8722a',
      title: askText ? `Ask the assistant: “${askText}”` : 'Ask the assistant…',
    }]) })

    const actions = []
    const themeLabel = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'
    if (!q || themeLabel.toLowerCase().includes(q) || 'theme'.includes(q))
      actions.push({ kind: 'action', id: 'theme', title: themeLabel, icon: theme === 'light' ? '☾' : '☀' })
    if (actions.length) out.push({ label: 'Actions', items: withIdx(actions) })

    return out
  }, [query, datasets, modules, theme])

  const flat = useMemo(() => sections.flatMap(s => s.items), [sections])

  const pick = useCallback((item) => {
    if (!item) return
    if (item.kind === 'record') onPick(item.module, item.recordId)
    else if (item.kind === 'page') onPick(item.module, null)
    else if (item.kind === 'ask') onAsk(item.query)
    else if (item.kind === 'action' && item.id === 'theme') { onToggleTheme(); return }
    onClose()
  }, [onPick, onAsk, onClose, onToggleTheme])

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(flat.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(flat[active]) }
  }

  if (!open) return null

  return (
    <div className="cmdk-overlay" onMouseDown={onClose}>
      <div className="cmdk-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="cmdk-input-row">
          <span className="cmdk-search-icon">⌕</span>
          <input ref={inputRef} className="cmdk-input" placeholder="Search records, or ask the assistant…"
            value={query} onChange={e => { setQuery(e.target.value); setActive(0) }} onKeyDown={onKeyDown} />
          <span className="cmdk-kbd">esc</span>
        </div>

        <div className="cmdk-results">
          {flat.length === 0 && (
            <div className="cmdk-empty">{datasets ? 'No matches' : 'Indexing records…'}</div>
          )}
          {sections.map(sec => (
            <div key={sec.label} className="cmdk-section">
              <div className="cmdk-section-label">{sec.label}</div>
              {sec.items.map(item => (
                <button key={item.idx}
                  className={`cmdk-item${item.idx === active ? ' active' : ''}`}
                  onMouseMove={() => setActive(item.idx)}
                  onClick={() => pick(item)}>
                  <span className="cmdk-item-icon" style={{ color: item.color || 'inherit' }}>{item.icon}</span>
                  <span className="cmdk-item-body">
                    <span className="cmdk-item-title">{item.title}</span>
                    {item.sub && <span className="cmdk-item-sub">{item.sub}</span>}
                  </span>
                  {item.type && <span className="cmdk-tag" style={{ color: item.color, background: item.color + '1f' }}>{item.type}</span>}
                  {item.idx === active && <span className="cmdk-enter">↵</span>}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="cmdk-footer">
          <span><span className="cmdk-fkbd">↑↓</span> navigate</span>
          <span><span className="cmdk-fkbd">↵</span> open</span>
          <span><span className="cmdk-fkbd">esc</span> close</span>
        </div>
      </div>
    </div>
  )
}
