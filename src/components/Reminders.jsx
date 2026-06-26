import { useState, useEffect, useCallback } from 'react'
import { listReminders, bucketReminders, completeReminder, snoozeReminder, deleteReminder, subscribeReminders } from '../api/reminders'
import { isReminderSoundOn, setReminderSoundOn, playReminderChime } from '../utils/chime'
import ReminderModal from './ReminderModal'
import './Reminders.css'

const DAY = 86400000

function fmtWhen(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - startToday) / DAY)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (dayDiff === 0) return `Today · ${time}`
  if (dayDiff === -1) return `Yesterday · ${time}`
  if (dayDiff === 1) return `Tomorrow · ${time}`
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  return `${day} · ${time}`
}

const GROUPS = [
  { key: 'overdue', label: 'Overdue', tone: 'danger' },
  { key: 'today',   label: 'Today',   tone: 'warn' },
  { key: 'week',    label: 'This week', tone: 'muted' },
  { key: 'later',   label: 'Later',   tone: 'muted' },
  { key: 'done',    label: 'Done',    tone: 'muted' },
]

export default function Reminders({ navTarget, onClearNav, onNavigateTo } = {}) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('open') // open | done | all
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [soundOn, setSoundOn] = useState(isReminderSoundOn)

  function toggleSound() {
    const next = !soundOn
    setSoundOn(next); setReminderSoundOn(next)
    if (next) playReminderChime('lead') // brief preview when turning it on
  }

  const load = useCallback(() => {
    return listReminders()
      .then(rows => { setItems(rows); setError(null) })
      .catch(e => setError(e.message || 'Could not load reminders'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(); const unsub = subscribeReminders(load); return unsub }, [load])

  // Deep-link target (#reminders) just selects the module; nothing record-specific.
  useEffect(() => { if (navTarget?.moduleId === 'reminders') onClearNav?.() }, [navTarget, onClearNav])

  const q = query.trim().toLowerCase()
  const visible = q
    ? items.filter(r => `${r.title} ${r.notes} ${r.recordLabel}`.toLowerCase().includes(q))
    : items
  const groups = bucketReminders(visible)

  const shownGroups = GROUPS.filter(g =>
    filter === 'all' ? true : filter === 'done' ? g.key === 'done' : g.key !== 'done'
  ).filter(g => groups[g.key].length > 0)

  const dueNow = groups.overdue.length + groups.today.length
  const openTotal = items.filter(r => !r.done).length

  async function act(fn) { try { await fn() } catch (e) { setError(e.message || 'Action failed') } }
  const onComplete = r => act(() => completeReminder(r.id, !r.done))
  const onSnooze = r => act(() => snoozeReminder(r.id, new Date(new Date(r.start || Date.now()).getTime() + DAY).toISOString(),
    r.end && r.start ? Math.max(15, Math.round((new Date(r.end) - new Date(r.start)) / 60000)) : 30))
  const onDelete = r => { if (window.confirm(`Delete reminder “${r.title}”?`)) act(() => deleteReminder(r.id)) }

  return (
    <div className="rm-container">
      <div className="rm-main">
        <header className="rm-topbar">
          <div className="rm-title-wrap">
            <span className="rm-bell">⏰</span>
            <span className="rm-title">Reminders</span>
            <span className="rm-count">{openTotal} open{dueNow ? ` · ${dueNow} due` : ''}</span>
          </div>
          <div className="rm-top-actions">
            <button className="rm-sound" title={soundOn ? 'Sound on — click to mute' : 'Sound off — click to unmute'} aria-label={soundOn ? 'Mute reminder sound' : 'Unmute reminder sound'} onClick={toggleSound}>
              {soundOn ? '🔔' : '🔕'}
            </button>
            <button className="rm-new" onClick={() => setCreateOpen(true)}>＋ New reminder</button>
          </div>
        </header>

        <div className="rm-controls">
          <div className="rm-segment">
            {['open', 'done', 'all'].map(f => (
              <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                {f === 'open' ? 'Open' : f === 'done' ? 'Done' : 'All'}
              </button>
            ))}
          </div>
          <input className="rm-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search reminders…" />
        </div>

        <div className="rm-scroll">
          {loading ? (
            <div className="rm-loading">{Array.from({ length: 4 }, (_, i) => <div key={i} className="rm-skeleton" />)}</div>
          ) : error ? (
            <div className="rm-empty"><p>{error}</p><button className="rm-retry" onClick={load}>Retry</button></div>
          ) : shownGroups.length === 0 ? (
            <div className="rm-empty">
              <p>{q ? 'No reminders match your search.' : filter === 'done' ? 'Nothing completed yet.' : 'No reminders. Create one to get a nudge.'}</p>
            </div>
          ) : (
            shownGroups.map(g => (
              <section key={g.key} className="rm-group">
                <div className={`rm-group-head tone-${g.tone}`}>
                  <span className="rm-group-label">{g.label}</span>
                  <span className="rm-group-count">{groups[g.key].length}</span>
                  <span className="rm-group-rule" />
                </div>
                {groups[g.key].map(r => (
                  <div key={r.id} className={`rm-row ${r.done ? 'is-done' : ''}`}>
                    <button className={`rm-check ${r.done ? 'checked' : ''}`} title={r.done ? 'Reopen' : 'Complete'} onClick={() => onComplete(r)}>
                      {r.done ? '✓' : ''}
                    </button>
                    <div className="rm-body" onClick={() => setEditing(r)}>
                      <div className="rm-row-title">{r.title}</div>
                      <div className="rm-meta">
                        {r.recordLabel && (
                          <button className="rm-chip" title="Open linked record"
                            onClick={e => { e.stopPropagation(); if (r.recordType && r.recordId) onNavigateTo?.(r.recordType, r.recordId) }}>
                            ◉ {r.recordLabel}
                          </button>
                        )}
                        <span className={`rm-when tone-${g.tone}`}>{fmtWhen(r.start)}</span>
                      </div>
                    </div>
                    <div className="rm-actions">
                      {!r.done && <button title="Snooze 1 day" onClick={() => onSnooze(r)}>⏱</button>}
                      <button title="Edit" onClick={() => setEditing(r)}>✎</button>
                      <button title="Delete" onClick={() => onDelete(r)}>✕</button>
                    </div>
                  </div>
                ))}
              </section>
            ))
          )}
        </div>
      </div>

      {createOpen && <ReminderModal onClose={() => setCreateOpen(false)} />}
      {editing && <ReminderModal reminder={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
