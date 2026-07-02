import { useState, useMemo, useRef, useEffect } from 'react'
import './ListControls.css'

// Reusable filter-chips + consolidated-sort + type-to-filter controls for
// module list sidebars. Each module supplies a small config; the hook owns
// the filter/sort/typed state and returns processed items (+ A–Z sections).
export function useListControls({ records, storageKey, name, searchKeys = [], chips = [], sorts, defaultSort, defaultOrder = 'asc', fields = r => r.fieldData, extraFilter }) {
  const [typed, setTyped] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [chipId, setChipId] = useState('all')
  const [sortId, setSortIdRaw] = useState(() => localStorage.getItem(`${storageKey}_field`) || defaultSort)
  const [order, setOrderRaw] = useState(() => localStorage.getItem(`${storageKey}_order`) || defaultOrder)

  const setSortId = v => { setSortIdRaw(v); localStorage.setItem(`${storageKey}_field`, v) }
  const setOrder = v => { setOrderRaw(v); localStorage.setItem(`${storageKey}_order`, v) }

  const sort = sorts.find(s => s.id === sortId) || sorts[0]
  const activeChip = chips.find(c => c.id === chipId)

  const processed = useMemo(() => {
    let arr = records
    if (activeChip?.match) arr = arr.filter(r => activeChip.match(fields(r)))
    if (extraFilter) arr = arr.filter(r => extraFilter(fields(r)))
    const q = typed.trim().toLowerCase()
    if (q) arr = arr.filter(r => { const f = fields(r); return searchKeys.some(k => String(f[k] ?? '').toLowerCase().includes(q)) })
    const val = sort.value
    arr = [...arr].sort((a, b) => {
      const va = val(fields(a)), vb = val(fields(b))
      const cmp = va < vb ? -1 : va > vb ? 1 : 0
      return order === 'asc' ? cmp : -cmp
    })
    return arr
  }, [records, chipId, typed, sortId, order, extraFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  const sections = useMemo(() => {
    if (!sort.alpha) return null
    const out = []; let cur = null
    for (const r of processed) {
      const ch = (name(fields(r)) || '').trim()[0]
      const letter = ch && /[a-z]/i.test(ch) ? ch.toUpperCase() : '#'
      if (!cur || cur.letter !== letter) { cur = { letter, items: [] }; out.push(cur) }
      cur.items.push(r)
    }
    return out
  }, [processed, sortId]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    typed, setTyped, filterOpen, setFilterOpen,
    chipId, setChipId, sortId, setSortId, order, setOrder,
    sort, sorts, chips, processed, sections,
    count: processed.length, total: records.length,
  }
}

export default function ListToolbar({ c, unit = 'items' }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const menuRef = useRef(null)

  // Type-to-filter: when this (visible) sidebar's module is on screen and the
  // user types a printable key outside any field, reveal the filter and seed it.
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      if (editable) return
      if (!rootRef.current || rootRef.current.offsetParent === null) return // hidden module
      if (e.key.length === 1 && /\S/.test(e.key)) {
        c.setFilterOpen(true)
        c.setTyped(prev => prev + e.key)
        requestAnimationFrame(() => inputRef.current?.focus())
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [c])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const closeFilter = () => { c.setFilterOpen(false); c.setTyped('') }

  return (
    <div className="lc-toolbar" ref={rootRef}>
      {c.chips.length > 1 && (
        <div className="lc-chips">
          {c.chips.map(chip => (
            <button key={chip.id} className={`lc-chip${c.chipId === chip.id ? ' active' : ''}`} onClick={() => c.setChipId(chip.id)}>
              {chip.color && <span className="lc-dot" style={{ background: chip.color }} />}
              {chip.label}
            </button>
          ))}
        </div>
      )}

      <div className="lc-row">
        <div className="lc-sort" ref={menuRef}>
          <button className="lc-sort-btn" onClick={() => setMenuOpen(o => !o)}>
            <span className="lc-sort-ic">⇅</span>{c.sort.label}
            <span className="lc-sort-dir">{c.order === 'asc' ? '↑' : '↓'}</span>
          </button>
          {menuOpen && (
            <div className="lc-menu">
              {c.sorts.map(s => (
                <button key={s.id} className={`lc-menu-item${c.sortId === s.id ? ' active' : ''}`} onClick={() => { c.setSortId(s.id); setMenuOpen(false) }}>
                  {s.label}{c.sortId === s.id && <span>✓</span>}
                </button>
              ))}
              <div className="lc-menu-sep" />
              <button className="lc-menu-item" onClick={() => c.setOrder(c.order === 'asc' ? 'desc' : 'asc')}>
                {c.order === 'asc' ? 'Ascending ↑' : 'Descending ↓'}
              </button>
            </div>
          )}
        </div>

        <div className="lc-right">
          <span className="lc-count">{c.count === c.total ? `${c.total.toLocaleString()}` : `${c.count.toLocaleString()} of ${c.total.toLocaleString()}`}</span>
          <button className={`lc-filter-btn${c.filterOpen ? ' active' : ''}`} onClick={() => c.filterOpen ? closeFilter() : c.setFilterOpen(true)} title="Filter this list">⌕</button>
        </div>
      </div>

      {c.filterOpen && (
        <div className="lc-filter-bar">
          <span className="lc-filter-ic">⌕</span>
          <input ref={inputRef} className="lc-filter-input" autoFocus placeholder={`Filter ${unit}…`} value={c.typed}
            onChange={e => c.setTyped(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') closeFilter() }} />
          <button className="lc-filter-x" onClick={closeFilter}>✕</button>
        </div>
      )}
    </div>
  )
}

// Walk up from a node to the nearest actually-scrollable ancestor.
function scrollParent(node) {
  let el = node?.parentElement
  while (el) {
    const oy = getComputedStyle(el).overflowY
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el
    el = el.parentElement
  }
  return null
}

// Helper: render a flat list or A–Z sections with sticky letter headers.
// Letters and items are emitted as siblings, so the parent should be a
// scrolling <div> (sticky headers work; items are plain <div>s).
//
// `activeId` (optional): when the selected record changes — e.g. a deep-link or
// global-search jump — bring its row into view so the user can see where the
// record sits in the list. Only scrolls when the row is offscreen, and only
// once per selection, so it never fights manual scrolling.
export function ListBody({ c, renderItem, activeId }) {
  const anchorRef = useRef(null)
  const scrolledFor = useRef(null)
  useEffect(() => {
    if (activeId == null) { scrolledFor.current = null; return }
    if (scrolledFor.current === activeId) return
    const root = anchorRef.current?.parentElement
    const el = root?.querySelector('.active')
    if (!root || !el) return // not rendered yet (loading/filtered) — retry on next processed change
    scrolledFor.current = activeId
    const scroller = scrollParent(el) || root
    const sr = scroller.getBoundingClientRect(), er = el.getBoundingClientRect()
    if (er.top < sr.top || er.bottom > sr.bottom) {
      scroller.scrollTop += (er.top - sr.top) - (scroller.clientHeight - er.height) / 2
    }
  }, [activeId, c.processed])

  const items = c.sections
    ? c.sections.flatMap(sec => [
        <div className="lc-letter" key={`L:${sec.letter}`}>{sec.letter}</div>,
        ...sec.items.map(renderItem),
      ])
    : c.processed.map(renderItem)
  return [<span key="__lc_anchor" ref={anchorRef} aria-hidden="true" style={{ display: 'none' }} />, ...items]
}
