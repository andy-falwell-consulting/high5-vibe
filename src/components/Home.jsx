import { useState, useEffect } from 'react'
import { readCacheAsync } from '../api/filemaker'
import { RCD_CACHE_VERSION } from '../config/ccsCache'
import './Home.css'

const PIPELINE = [
  'New Project Inquiry', 'Working Proposals', 'Proposals Out', 'Sent Contract and DI',
  'Job Prep by Date', 'Done/Ready for Building', 'Commissioning Report Needed', "No Go's (litter box)",
]
const PIPELINE_SHORT = ['New inquiry', 'Working', 'Proposals out', 'Contract sent', 'Job prep', 'Ready to build', 'Commissioning', 'No go']

function statusColor(s) {
  const t = (s || '').toLowerCase()
  if (t.includes('complet')) return '#22c55e'
  if (t.includes('no go') || t.includes('cancel')) return '#94a3b8'
  if (t.includes('progress')) return '#a855f7'
  if (t.includes('confirm') || t.includes('schedul')) return '#3b82f6'
  if (t.includes('propos') || t.includes('inquir')) return '#e8a23a'
  return '#94a3b8'
}
const parseFmDate = v => {
  if (!v) return null
  const [date] = String(v).split(' ')
  const [m, d, y] = date.split('/')
  if (!y) return null
  const dt = new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00`)
  return isNaN(dt) ? null : dt
}
const daysUntil = v => {
  const dt = parseFmDate(v); if (!dt) return null
  const t = new Date(); t.setHours(0, 0, 0, 0)
  return Math.round((dt - t) / 86400000)
}
const fmtDate = v => { const dt = parseFmDate(v); return dt ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—' }

export default function Home({ onOpen, onGoto, onOpenView, onOpenPalette }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    let alive = true, tries = 0
    const load = async () => {
      const [proj, cont, insp, prod] = await Promise.all([
        readCacheAsync('RCD_New', RCD_CACHE_VERSION),
        readCacheAsync('Contacts_New', 2),
        readCacheAsync('Inspections_New', 1),
        readCacheAsync('Products & Services_New', 4),
      ])
      if (!alive) return
      const projects = proj?.records || []
      setData({
        projects,
        contacts: cont?.total ?? cont?.records?.length ?? 0,
        inspections: insp?.total ?? insp?.records?.length ?? 0,
        products: prod?.total ?? prod?.records?.length ?? 0,
      })
      if (projects.length === 0 && tries++ < 15) setTimeout(load, 700)
    }
    load()
    return () => { alive = false }
  }, [])

  const projects = data?.projects || []
  const isDone = s => (s || '').toLowerCase().includes('complet') || (s || '').toLowerCase().includes('no go')

  const stageCounts = PIPELINE.map(st => projects.filter(p => p.fieldData.kanban_status === st).length)
  const maxStage = Math.max(1, ...stageCounts)

  const upcoming = projects
    .map(p => ({ p, d: daysUntil(p.fieldData['rcd start date']) }))
    .filter(x => x.d != null && x.d >= 0 && x.d <= 30 && !isDone(x.p.fieldData.Status))
    .sort((a, b) => a.d - b.d)
    .slice(0, 6)

  const recent = [...projects]
    .sort((a, b) => (parseFmDate(b.fieldData.zz__Modified_On) || 0) - (parseFmDate(a.fieldData.zz__Modified_On) || 0))
    .slice(0, 6)

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  const kpis = [
    { label: 'Active projects', value: projects.length, go: 'projects' },
    { label: 'Upcoming events', value: upcoming.length, sub: 'next 30 days' },
    { label: 'Contacts', value: data ? data.contacts.toLocaleString() : '—', go: 'contacts' },
    { label: 'Inspections', value: data ? data.inspections.toLocaleString() : '—', go: 'inspections' },
  ]

  return (
    <div className="home-root">
      <div className="home-inner">
        <header className="home-head">
          <div>
            <h1 className="home-title">Overview</h1>
            <div className="home-date">{today}</div>
          </div>
          <button className="home-search" onClick={onOpenPalette}>
            <span>⌕</span> Search… <span className="home-kbd">⌘K</span>
          </button>
        </header>

        <div className="home-kpis">
          {kpis.map(k => (
            <button key={k.label} className={`home-kpi${k.go ? ' clickable' : ''}`} onClick={() => k.go && onGoto(k.go)}>
              <div className="home-kpi-label">{k.label}</div>
              <div className="home-kpi-value">{k.value}</div>
              {k.sub && <div className="home-kpi-sub">{k.sub}</div>}
            </button>
          ))}
        </div>

        <div className="home-card">
          <div className="home-card-head"><span>Pipeline</span><button className="home-link" onClick={() => onOpenView('projects', 'board')}>Open board →</button></div>
          <div className="home-pipe">
            {PIPELINE.map((st, i) => (
              <div key={st} className="home-pipe-stage" title={`${stageCounts[i]} · ${st}`}>
                <div className="home-pipe-count">{stageCounts[i]}</div>
                <div className="home-pipe-bar"><div style={{ height: `${(stageCounts[i] / maxStage) * 100}%` }} /></div>
                <div className="home-pipe-label">{PIPELINE_SHORT[i]}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="home-cols">
          <div className="home-card">
            <div className="home-card-head"><span>Upcoming events</span></div>
            {upcoming.length === 0 ? <div className="home-empty">{data ? 'Nothing in the next 30 days' : 'Loading…'}</div> : (
              <div className="home-list">
                {upcoming.map(({ p, d }) => {
                  const c = statusColor(p.fieldData.Status)
                  return (
                    <button key={p.recordId} className="home-row" onClick={() => onOpen('projects', p.recordId)}>
                      <span className="home-dot" style={{ background: c }} />
                      <span className="home-row-main">
                        <span className="home-row-title">{p.fieldData.zz__Display_Organization__ct || '—'}</span>
                        <span className="home-row-sub">{p.fieldData['Type of Project(1)'] || p.fieldData.kanban_status || ''}</span>
                      </span>
                      <span className="home-row-meta">
                        <span className="home-row-date">{fmtDate(p.fieldData['rcd start date'])}</span>
                        <span className={`home-badge${d <= 7 ? ' urg' : ''}`}>{d === 0 ? 'today' : `${d}d`}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="home-card">
            <div className="home-card-head"><span>Recently updated</span></div>
            {recent.length === 0 ? <div className="home-empty">{data ? 'No projects' : 'Loading…'}</div> : (
              <div className="home-list">
                {recent.map(p => {
                  const c = statusColor(p.fieldData.Status)
                  return (
                    <button key={p.recordId} className="home-row" onClick={() => onOpen('projects', p.recordId)}>
                      <span className="home-dot" style={{ background: c }} />
                      <span className="home-row-main">
                        <span className="home-row-title">{p.fieldData.zz__Display_Organization__ct || '—'}</span>
                        <span className="home-row-sub">{p.fieldData.Status || ''}</span>
                      </span>
                      <span className="home-row-date">{fmtDate(p.fieldData.zz__Modified_On)}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="home-quick">
          {[['contacts', 'Contacts', '◉'], ['inspections', 'Inspections', '⚑'], ['products', 'Products & Services', '◫'], ['projects', 'Course projects', '◈']].map(([id, label, icon]) => (
            <button key={id} className="home-quick-btn" onClick={() => onGoto(id)}><span className="home-quick-icon">{icon}</span>{label}</button>
          ))}
        </div>
      </div>
    </div>
  )
}
