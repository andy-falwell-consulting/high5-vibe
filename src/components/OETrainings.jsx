import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { readCacheAsync } from '../api/filemaker'
import ListToolbar, { useListControls, ListBody } from './ListControls'
import { listCourses, getRoster, courseKey, feeTotal, depositDue, balanceDue, rosterTotals, money } from '../api/oeTrainings'
import { canonicalEnrollment } from '../config/oeEnrollment'
import './OETrainings.css'

// OE Trainings — the ROSTER side of open-enrollment programs.
//
// OE Lookups holds the offering (one row per scheduled session); this holds who
// signed up (one row per person per session). FileMaker states the relationship
// itself: the `Course Number` field carries a value list named `OELookup`.
//
// The sidebar joins Vibe's session index against the OE Lookup replica on
// Program Code = Course Number — 548 of 556 sessions match (98.6%). The eight
// that do not are junk codes ("0", "CCM", "CANCELLED: AB-2020-3") and show their
// code alone rather than being hidden.

const LOOKUP_LAYOUT = 'OELookup_New'
const LOOKUP_CV = 1

const fmtDate = v => (v ? String(v).split(' ')[0] : '')
const yearOf = v => { const m = String(v || '').match(/\/(\d{4})\b/); return m ? m[1] : '' }

function Flag({ on, children }) {
  return <span className={`oet-flag${on ? ' on' : ''}`}>{on ? '✓' : '○'} {children}</span>
}

export default function OETrainings({ navTarget, onClearNav, onRecordSelect, onNavigateTo } = {}) {
  const [courses, setCourses] = useState(null)      // null = loading
  // Program Code -> { f: fieldData, recordId }.
  //
  // The recordId is carried deliberately: OE Lookup keys its navTarget on the
  // FileMaker recordId, so "View offering" cannot open the right program
  // without it. v1.0.439 stored fieldData alone and passed null, which opened
  // the OE Lookup LIST instead of the offering — it looked like a navigation
  // that went to the wrong place, because it did.
  const [lookups, setLookups] = useState(new Map())
  const [selected, setSelected] = useState(null)    // { course, rows } | null
  const [rosterBusy, setRosterBusy] = useState(false)
  const [error, setError] = useState(null)
  const [sidebarWidth, setSidebarWidth] = useState(320)
  const dragging = useRef(false)

  // Sessions from Vibe, catalogue detail from the OE Lookup replica.
  useEffect(() => {
    let alive = true
    Promise.all([
      listCourses().catch(e => { if (alive) setError(e.message); return [] }),
      readCacheAsync(LOOKUP_LAYOUT, LOOKUP_CV).then(c => c?.records || []).catch(() => []),
    ]).then(([cs, recs]) => {
      if (!alive) return
      const m = new Map()
      for (const r of recs) {
        const k = courseKey(r.fieldData?.['Program Code'])
        if (k && !m.has(k)) m.set(k, { f: r.fieldData, recordId: r.recordId })
      }
      setLookups(m)
      setCourses(cs)
    })
    return () => { alive = false }
  }, [])

  // One row per session, catalogue fields merged in where the code matches.
  const records = useMemo(() => (courses || []).map(c => {
    const f = lookups.get(c.course)?.f || {}
    return {
      recordId: c.course,
      fieldData: {
        course: c.course,
        count: c.count,
        programType: f['Program Type'] || '',
        startDate: f['Program Start Date'] || '',
        endDate: f['Program End Date'] || '',
        lead: f['Lead Facilitator'] || '',
        enrollment: canonicalEnrollment(f['Open Enrollment or Custom']),
        tuition: f['Tuition'] || '',
        inCatalogue: !!lookups.get(c.course),
      },
    }
  }), [courses, lookups])

  const controls = useListControls({
    records,
    storageKey: 'oe-trainings',
    name: f => f.programType || f.course,
    searchKeys: ['course', 'programType', 'lead'],
    chips: [
      { id: 'all', label: 'All' },
      { id: 'upcoming', label: 'Upcoming', match: f => yearOf(f.startDate) >= String(new Date().getFullYear()) },
      { id: 'unlisted', label: 'Not in catalogue', match: f => !f.inCatalogue },
    ],
    sorts: [
      { id: 'date',   label: 'Start date',  value: f => { const m = String(f.startDate || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}${m[1]}${m[2]}` : '' } },
      { id: 'course', label: 'Course code', value: f => f.course },
      { id: 'size',   label: 'Registrants', value: f => Number(f.count) || 0 },
      { id: 'type',   label: 'Program type', value: f => f.programType || '' },
    ],
    defaultSort: 'date', defaultOrder: 'desc',
  })

  const openCourse = useCallback(async (course) => {
    setSelected({ course, rows: null })
    setRosterBusy(true); setError(null)
    try { setSelected({ course, rows: await getRoster(course) }) }
    catch (e) { setError(e.message); setSelected({ course, rows: [] }) }
    finally { setRosterBusy(false) }
  }, [])

  // Deep link: #oe-trainings/<course code>
  //
  // Fetch first, then set state — openCourse's opening setSelected would be a
  // synchronous setState in an effect body, which triggers a cascading render.
  useEffect(() => {
    if (!navTarget || navTarget.moduleId !== 'oe-trainings') return undefined
    const c = courseKey(navTarget.recordId)
    if (!c) return undefined
    let alive = true
    getRoster(c)
      .then(r => { if (alive) { setSelected({ course: c, rows: r }); onClearNav?.() } })
      .catch(e => { if (alive) { setError(e.message); setSelected({ course: c, rows: [] }) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navTarget])

  const onMouseDown = useCallback(e => {
    dragging.current = true
    const startX = e.clientX, startW = sidebarWidth
    const onMove = ev => { if (dragging.current) setSidebarWidth(Math.max(240, Math.min(560, startW + ev.clientX - startX))) }
    const onUp = () => { dragging.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }, [sidebarWidth])

  const rows = selected?.rows
  const hit = selected ? lookups.get(selected.course) : null
  const cat = hit?.f || null
  const totals = rows ? rosterTotals(rows) : null

  return (
    <div className="oet-container">
      <aside className="oet-sidebar" style={{ width: sidebarWidth }}>
        <div className="oet-sidebar-header">
          <div>
            <div className="oet-sidebar-module">OE Trainings</div>
            <div className="oet-sidebar-count">
              {courses === null ? 'Loading…' : `${controls.count.toLocaleString()} sessions`}
            </div>
          </div>
          <ListToolbar c={controls} unit="sessions" />
        </div>

        {courses === null ? (
          <div className="oet-loading">{Array.from({ length: 12 }, (_, i) => <div key={i} className="oet-skeleton" />)}</div>
        ) : (
          <ListBody c={controls} activeId={selected?.course} renderItem={r => {
            const f = r.fieldData
            return (
              <div key={r.recordId}
                className={`oet-item ${selected?.course === f.course ? 'active' : ''}`}
                onClick={() => { openCourse(f.course); onRecordSelect?.(f.course, f.programType || f.course) }}>
                <div className="oet-item-main">
                  <div className="oet-item-name">{f.programType || <span className="oet-unlisted">{f.course}</span>}</div>
                  <div className="oet-item-sub">
                    {f.course}{f.startDate ? ` · ${fmtDate(f.startDate)}` : ''}{f.lead ? ` · ${f.lead}` : ''}
                  </div>
                </div>
                <span className="oet-count" title="registrants">{f.count}</span>
              </div>
            )
          }} />
        )}
      </aside>

      <div className="oet-resize-handle" onMouseDown={onMouseDown} />

      <main className="oet-main">
        {!selected ? (
          <div className="oet-empty"><div className="oet-empty-icon">◆</div><p>Select a session</p></div>
        ) : (
          <>
            <div className="oet-topbar">
              <div>
                <h1 className="oet-title">{cat?.['Program Type'] || selected.course}</h1>
                <div className="oet-meta">
                  <span className="oet-chip code">{selected.course}</span>
                  {cat?.['Program Start Date'] && (
                    <span className="oet-chip">{fmtDate(cat['Program Start Date'])} – {fmtDate(cat['Program End Date'])}</span>
                  )}
                  {cat?.['Lead Facilitator'] && <span className="oet-chip">{cat['Lead Facilitator']}</span>}
                  {!cat && <span className="oet-chip warn">Not in the OE Lookup catalogue</span>}
                  {hit?.recordId && (
                    <button className="oet-link" onClick={() => onNavigateTo?.('oe-lookup', hit.recordId)}>
                      View offering →
                    </button>
                  )}
                </div>
              </div>
            </div>

            {error && <div className="oet-error">{error}</div>}

            {rows === null || rosterBusy ? (
              <div className="oet-loading-body">Loading roster…</div>
            ) : (
              <div className="oet-content">
                <div className="oet-stats">
                  <div className="oet-stat"><span>{totals.registrants}</span><label>Registrants</label></div>
                  <div className="oet-stat"><span>{money(totals.fees)}</span><label>Fees</label></div>
                  <div className="oet-stat"><span>{money(totals.received)}</span><label>Received</label></div>
                  <div className={`oet-stat${totals.outstanding > 0 ? ' owing' : ''}`}>
                    <span>{money(totals.outstanding)}</span><label>Outstanding</label>
                  </div>
                  {totals.unassigned > 0 && (
                    <div className="oet-stat warn" title="These registrations have no contact in FileMaker — they were invisible before the store was normalised.">
                      <span>{totals.unassigned}</span><label>Unassigned</label>
                    </div>
                  )}
                </div>

                <div className="oet-table-wrap">
                  <table className="oet-table">
                    <thead>
                      <tr>
                        <th>Registrant</th><th>Organization</th>
                        <th className="num">Fee</th><th className="num">Deposit due</th>
                        <th className="num">Received</th><th className="num">Balance</th>
                        <th>Paperwork</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr><td colSpan={7} className="oet-none">No registrations recorded.</td></tr>
                      ) : rows.map(w => {
                        const bal = balanceDue(w)
                        return (
                          <tr key={w.id}>
                            <td>
                              {w.contactId ? (
                                <button className="oet-link" onClick={() => onNavigateTo?.('contacts-v2', w.contactId)}>
                                  {w.contactName || w.contactId}
                                </button>
                              ) : (
                                <span className="oet-unassigned" title="No contact on the FileMaker record">unassigned</span>
                              )}
                            </td>
                            <td>{w.organization || '—'}</td>
                            <td className="num">{money(feeTotal(w))}</td>
                            <td className="num">{money(depositDue(w))}</td>
                            <td className="num">{money(w.depositReceived)}</td>
                            <td className={`num${bal > 0 ? ' owing' : ''}`}>{money(bal)}</td>
                            <td className="oet-flags">
                              <Flag on={!!w.confirmationSent}>confirm</Flag>
                              <Flag on={!!w.invoiceSent}>invoice</Flag>
                              {w.qboInvoiceId && <span className="oet-flag on">QBO</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
