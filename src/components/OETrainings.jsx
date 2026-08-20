import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { readCacheAsync } from '../api/filemaker'
import ListToolbar, { useListControls, ListBody } from './ListControls'
import { listCourses, getRoster, courseKey, feeTotal, depositDue, balanceDue, rosterTotals, money } from '../api/oeTrainings'
import { canonicalEnrollment } from '../config/oeEnrollment'
import WorkshopEmailModal from './WorkshopEmailModal'
import ReminderModal from './ReminderModal'
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
  const [emailing, setEmailing] = useState(null)   // the registration being e-mailed
  const [remindOpen, setRemindOpen] = useState(false)
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
    <div className="h5-module oet-container">
      <aside className="h5-sidebar" style={{ width: sidebarWidth }}>
        <div className="h5-sidebar__head">
          <div>
            <div className="oet-sidebar-module">OE Trainings</div>
            <div className="oet-sidebar-count">
              {courses === null ? 'Loading…' : `${controls.count.toLocaleString()} sessions`}
            </div>
          </div>
          <ListToolbar c={controls} unit="sessions" />
        </div>

        {courses === null ? (
          <div className="oet-loading">{Array.from({ length: 12 }, (_, i) => <div key={i} className="h5-skeleton h5-skeleton--row" />)}</div>
        ) : (
          // ListBody returns a bare ARRAY of items with no wrapper of its own,
          // so the scrolling container has to come from here. Without it the
          // sidebar's `overflow: hidden` simply clips everything past the fold
          // and there is no way to reach it — the exact trap CLAUDE.md warns
          // about, and the one this module walked straight into.
          <div className="h5-sidebar__list h5-scroll">
            <ListBody c={controls} activeId={selected?.course} renderItem={r => {
            const f = r.fieldData
            return (
              <div key={r.recordId}
                className={`h5-list-item${selected?.course === f.course ? ' h5-list-item--active' : ''}`}
                onClick={() => { openCourse(f.course); onRecordSelect?.(f.course, f.programType || f.course) }}>
                <div className="h5-list-item__body">
                  <div className="h5-list-item__title">{f.programType || <span className="oet-unlisted">{f.course}</span>}</div>
                  <div className="h5-list-item__sub">
                    {f.course}{f.startDate ? ` · ${fmtDate(f.startDate)}` : ''}{f.lead ? ` · ${f.lead}` : ''}
                  </div>
                </div>
                <span className="h5-list-item__count" title="registrants">{f.count}</span>
              </div>
            )
            }} />
          </div>
        )}
      </aside>

      <div className="h5-resize" onMouseDown={onMouseDown} />

      <main className="h5-detail">
        {!selected ? (
          <div className="h5-empty"><div className="h5-empty__icon">◆</div><p className="h5-empty__title">Select a session</p><p className="h5-empty__body">Choose a course from the list to see who is on it.</p></div>
        ) : (
          <>
            <div className="h5-page-header">
              <div>
                <h1 className="h5-page-header__title">{cat?.['Program Type'] || selected.course}</h1>
                <div className="h5-page-header__meta">
                  <span className="h5-badge h5-badge--blue">{selected.course}</span>
                  {cat?.['Program Start Date'] && (
                    <span className="h5-badge">{fmtDate(cat['Program Start Date'])} – {fmtDate(cat['Program End Date'])}</span>
                  )}
                  {cat?.['Lead Facilitator'] && <span className="h5-badge">{cat['Lead Facilitator']}</span>}
                  {!cat && <span className="h5-badge h5-badge--warning">Not in the OE Lookup catalogue</span>}
                  {hit?.recordId && (
                    <button className="oet-link h5-btn h5-btn--ghost h5-btn--sm" onClick={() => onNavigateTo?.('oe-lookup', hit.recordId)}>
                      View offering →
                    </button>
                  )}
                  <button className="oet-link h5-btn h5-btn--ghost h5-btn--sm" onClick={() => setRemindOpen(true)}>⏰ Remind</button>
                </div>
              </div>
            </div>

            {error && <div className="h5-callout h5-callout--error" style={{ margin: 'var(--space-lg) var(--space-2xl)' }}><span className="h5-callout__icon">×</span><div className="h5-callout__body">{error}</div></div>}

            {rows === null || rosterBusy ? (
              <div className="oet-loading-body h5-caption">Loading roster…</div>
            ) : (
              <div className="h5-detail__body h5-scroll">
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

                <div className="h5-table-wrap">
                  <table className="h5-table">
                    <thead>
                      <tr>
                        <th>Registrant</th><th>Organization</th>
                        <th className="h5-table__num">Fee</th><th className="h5-table__num">Deposit due</th>
                        <th className="h5-table__num">Received</th><th className="h5-table__num">Balance</th>
                        <th>Paperwork</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr><td colSpan={8} className="oet-none h5-caption">No registrations recorded.</td></tr>
                      ) : rows.map(w => {
                        const bal = balanceDue(w)
                        return (
                          <tr key={w.id}>
                            <td>
                              {w.contactId ? (
                                <button className="oet-link h5-btn h5-btn--ghost h5-btn--sm" onClick={() => onNavigateTo?.('contacts-v2', w.contactId)}>
                                  {w.contactName || w.contactId}
                                </button>
                              ) : (
                                <span className="oet-unassigned" title="No contact on the FileMaker record">unassigned</span>
                              )}
                            </td>
                            <td className="oet-org">{w.organization || '—'}</td>
                            <td className="h5-table__num">{money(feeTotal(w))}</td>
                            <td className="h5-table__num">{money(depositDue(w))}</td>
                            <td className="h5-table__num">{money(w.depositReceived)}</td>
                            <td className={`h5-table__num${bal > 0 ? ' oet-owing' : ''}`}>{money(bal)}</td>
                            <td className="oet-flags">
                              <Flag on={!!w.confirmationSent}>confirm</Flag>
                              <Flag on={!!w.invoiceSent}>invoice</Flag>
                              {w.qboInvoiceId && <span className="oet-flag on">QBO</span>}
                            </td>
                            <td className="oet-actions">
                              {w.contactId ? (
                                <button className="h5-btn h5-btn--secondary h5-btn--sm" onClick={() => setEmailing(w)}
                                  title={w.emailVersionSent ? `Last sent: ${w.emailVersionSent}` : 'Send a workshop e-mail'}>
                                  ✉ {w.confirmationSent ? 'Resend' : 'E-mail'}
                                </button>
                              ) : (
                                <span className="oet-no-action" title="No contact on this registration, so there is no address to send to">—</span>
                              )}
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

      {remindOpen && selected && (
        <ReminderModal
          initial={{
            // The COURSE CODE, not a recordId — a session is the thing being
            // reminded about, and it has no FileMaker record of its own. The
            // module's deep link takes the same code, so the reminder opens the
            // roster it came from.
            recordType: 'oe-trainings',
            recordId: selected.course,
            recordLabel: cat?.['Program Type'] || selected.course,
            title: `Follow up on ${cat?.['Program Type'] || selected.course}`,
          }}
          onClose={() => setRemindOpen(false)}
          onSaved={() => setRemindOpen(false)} />
      )}

      {emailing && (
        <WorkshopEmailModal
          workshop={emailing}
          courseLabel={cat?.['Program Type'] || selected?.course}
          onClose={() => setEmailing(null)}
          onSent={updated => setSelected(prev => prev && ({
            ...prev,
            rows: (prev.rows || []).map(r => (r.id === updated.id ? updated : r)),
          }))}
        />
      )}
    </div>
  )
}
