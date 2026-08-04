import { useState, useMemo, useEffect, useRef } from 'react'
import { useAllRecords } from '../hooks/useAllRecords'
import './ContactPicker.css'

const LAYOUT = 'Contacts_New'
const CACHE_VERSION = 2

// Searchable Contacts picker. Calls onSelect(contactRecord) with the raw record
// ({ recordId, fieldData }); the caller extracts whatever key it needs (usually
// _kpt__Contact_ID for a foreign key). Reuses the already-cached Contacts data.
// `filter` narrows the list to a subset (organizations only, or one org's
// people). It is always escapable — an empty subset would otherwise be a dead
// end, and rosters legitimately come back empty (a brand-new organization has
// no staff yet).
export default function ContactPicker({ onSelect, onClose, title = 'Select a contact', filter, filterLabel }) {
  const { records, loading } = useAllRecords(LAYOUT, { cacheVersion: CACHE_VERSION })
  const [q, setQ] = useState('')
  const [showAll, setShowAll] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const scoped = useMemo(
    () => (filter && !showAll ? records.filter(r => filter(r.fieldData || {})) : records),
    [records, filter, showAll]
  )

  const results = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return scoped.slice(0, 60)
    const keys = ['zz__Display__ct', 'Name_Organization', 'zz__Display_Organization__ct', 'Site Number']
    return scoped
      .filter(r => keys.some(k => String(r.fieldData?.[k] ?? '').toLowerCase().includes(term)))
      .slice(0, 60)
  }, [scoped, q])

  return (
    <div className="cp-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="cp-panel">
        <div className="cp-header">
          <h3>{title}</h3>
          <button className="cp-close" onClick={onClose}>✕</button>
        </div>
        <div className="cp-search">
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, organization, site #…" />
        </div>
        <div className="cp-list">
          {loading && records.length === 0 ? (
            <div className="cp-empty">Loading contacts…</div>
          ) : results.length === 0 ? (
            <div className="cp-empty">No matches</div>
          ) : (
            results.map(r => {
              const f = r.fieldData
              const name = f.zz__Display__ct || f.Name_Organization || '—'
              const sub = [f['Site Number'], f.Status].filter(Boolean).join(' · ')
              return (
                <button key={r.recordId} className="cp-item" onClick={() => onSelect(r)}>
                  <span className="cp-item-name">{name}</span>
                  {sub && <span className="cp-item-sub">{sub}</span>}
                </button>
              )
            })
          )}
        </div>
        {filter && (
          <button className="cp-scope" onClick={() => setShowAll(v => !v)}>
            {showAll
              ? '↩ Back to the shorter list'
              : `⌕ Search all ${records.length.toLocaleString()} contacts`}
          </button>
        )}
        <div className="cp-foot">
          {q.trim()
            ? `${results.length} shown`
            : filter && !showAll
              ? `${scoped.length.toLocaleString()} ${filterLabel || 'match'}`
              : `${records.length.toLocaleString()} contacts`}
        </div>
      </div>
    </div>
  )
}
