import { useState, useEffect, useMemo, useRef } from 'react'
import { readCacheAsync } from '../api/filemaker'
import { RECORD_SOURCES } from '../config/recordSources'
import './RecordPicker.css'

const PER_SOURCE = 20
const MAX_UNFILTERED = 40
const clean = v => (v || '').replace(/[\r\n]+/g, ' ').trim()

// Multi-type record search, used to attach a reminder to any contact,
// project, inspection, estimate, etc. Reads from the same prewarmed caches
// as CommandPalette via the shared RECORD_SOURCES config.
export default function RecordPicker({ onSelect, onClose, title = 'Attach a record' }) {
  const [datasets, setDatasets] = useState(null)
  const [q, setQ] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    let alive = true
    Promise.all(RECORD_SOURCES.map(s => readCacheAsync(s.layout, s.cv).then(r => r?.records || []).catch(() => [])))
      .then(arr => { if (alive) setDatasets(Object.fromEntries(RECORD_SOURCES.map((s, i) => [s.module, arr[i]]))) })
    return () => { alive = false }
  }, [])

  useEffect(() => { requestAnimationFrame(() => inputRef.current?.focus()) }, [])
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const results = useMemo(() => {
    if (!datasets) return []
    const term = q.trim().toLowerCase()
    const out = []
    for (const s of RECORD_SOURCES) {
      const data = datasets[s.module] || []
      let n = 0
      for (const r of data) {
        const t = clean(s.title(r.fieldData))
        const sub = clean(s.sub(r.fieldData))
        if (!term || t.toLowerCase().includes(term) || sub.toLowerCase().includes(term)) {
          out.push({ module: s.module, recordId: r.recordId, title: t || '(untitled)', sub, type: s.type, icon: s.icon, color: s.color })
          if (++n >= PER_SOURCE) break
        }
      }
      if (!term && out.length >= MAX_UNFILTERED) break
    }
    return out.slice(0, 80)
  }, [datasets, q])

  return (
    <div className="rp-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="rp-panel" onMouseDown={e => e.stopPropagation()}>
        <div className="rp-header">
          <h3>{title}</h3>
          <button className="rp-close" onClick={onClose}>✕</button>
        </div>
        <div className="rp-search">
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search contacts, projects, inspections…" />
        </div>
        <div className="rp-list">
          {!datasets ? (
            <div className="rp-empty">Loading…</div>
          ) : results.length === 0 ? (
            <div className="rp-empty">No matches</div>
          ) : (
            results.map(r => (
              <button key={`${r.module}:${r.recordId}`} className="rp-item" onClick={() => onSelect(r)}>
                <span className="rp-item-body">
                  <span className="rp-item-name">{r.title}</span>
                  {r.sub && <span className="rp-item-sub">{r.sub}</span>}
                </span>
                <span className="rp-tag" style={{ color: r.color, background: r.color + '1f' }}>{r.type}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
