import { useState, useEffect, useRef, useCallback } from 'react'
import { listReminders, completeReminder, snoozeReminder, subscribeReminders } from '../api/reminders'
import { playReminderChime } from '../utils/chime'
import './ReminderToaster.css'

// In-app toast notifications for reminders. Two toasts per reminder while the
// app is open: a heads-up "in X" at the reminder's lead time, and "Due now" at
// the event time. Purely client-side — reuses the reminders we already load,
// ticks every 30s to catch due moments, and dedupes fired toasts in
// localStorage so it never double-nags across reloads.
const TICK_MS = 30 * 1000
const REFETCH_MS = 3 * 60 * 1000
const NOW_GRACE_MS = 5 * 60 * 1000   // only surface "now" within 5 min of due (avoid stale spam)
const AUTO_DISMISS_MS = 10 * 1000
const FIRED_KEY = 'h5_reminder_fired'
const DAY = 86400000

function loadFired() {
  try { return JSON.parse(localStorage.getItem(FIRED_KEY) || '{}') } catch { return {} }
}
function saveFired(obj) {
  // Prune anything older than a day so the map can't grow unbounded.
  const cutoff = Date.now() - DAY
  const pruned = {}
  for (const [k, v] of Object.entries(obj)) if (v > cutoff) pruned[k] = v
  try { localStorage.setItem(FIRED_KEY, JSON.stringify(pruned)) } catch { /* ignore */ }
  return pruned
}

function fmtIn(ms) {
  const m = Math.max(1, Math.round(ms / 60000))
  if (m < 60) return `in ${m} min`
  const h = Math.round(m / 60)
  if (m < 1440) return `in ${h} hr`
  const d = Math.round(m / 1440)
  return `in ${d} day${d === 1 ? '' : 's'}`
}
function fmtClock(iso) {
  try { return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) } catch { return '' }
}

export default function ReminderToaster({ onOpen }) {
  const [toasts, setToasts] = useState([])
  const listRef = useRef([])
  const firedRef = useRef(loadFired())
  const timersRef = useRef(new Map())

  const dismiss = useCallback(key => {
    const t = timersRef.current.get(key)
    if (t) { clearTimeout(t); timersRef.current.delete(key) }
    setToasts(ts => ts.filter(x => x.key !== key))
  }, [])

  const push = useCallback((key, kind, r) => {
    const start = new Date(r.start).getTime()
    const sub = kind === 'now' ? 'Due now' : `${fmtIn(start - Date.now())} · ${fmtClock(r.start)}`
    setToasts(ts => ts.some(x => x.key === key) ? ts : [...ts, { key, kind, r, sub }])
    const timer = setTimeout(() => dismiss(key), AUTO_DISMISS_MS)
    timersRef.current.set(key, timer)
  }, [dismiss])

  const tick = useCallback(() => {
    const now = Date.now()
    const fired = firedRef.current
    let changed = false
    let sawNow = false
    for (const r of listRef.current) {
      if (r.done || !r.start) continue
      const start = new Date(r.start).getTime()
      if (Number.isNaN(start)) continue
      const lead = (r.lead || 0) * 60000

      const leadKey = `${r.id}|lead|${r.start}`
      if (lead > 0 && now >= start - lead && now < start && !fired[leadKey]) {
        fired[leadKey] = now; changed = true; push(leadKey, 'lead', r)
      }
      const nowKey = `${r.id}|now|${r.start}`
      if (now >= start && now < start + NOW_GRACE_MS && !fired[nowKey]) {
        fired[nowKey] = now; changed = true; sawNow = true; push(nowKey, 'now', r)
      }
    }
    if (changed) {
      firedRef.current = saveFired(fired)
      playReminderChime(sawNow ? 'now' : 'lead') // one chime per batch, "now" wins
    }
  }, [push])

  useEffect(() => {
    let alive = true
    const refetch = () => listReminders().then(rows => { if (alive) { listRef.current = rows; tick() } }).catch(() => {})
    refetch()
    const unsub = subscribeReminders(refetch)
    const refetchTimer = setInterval(refetch, REFETCH_MS)
    const tickTimer = setInterval(tick, TICK_MS)
    return () => {
      alive = false; unsub(); clearInterval(refetchTimer); clearInterval(tickTimer)
      timersRef.current.forEach(clearTimeout); timersRef.current.clear()
    }
  }, [tick])

  async function act(key, fn) { try { await fn() } catch { /* surfaced elsewhere */ } dismiss(key) }

  if (toasts.length === 0) return null

  return (
    <div className="rt-stack">
      {toasts.map(({ key, kind, r, sub }) => (
        <div key={key} className={`rt-toast ${kind}`}
          onMouseEnter={() => { const t = timersRef.current.get(key); if (t) { clearTimeout(t); timersRef.current.delete(key) } }}>
          <div className="rt-head">
            <span className="rt-icon">⏰</span>
            <div className="rt-text">
              <div className="rt-title">{r.title}</div>
              <div className="rt-meta">
                {r.recordLabel && (
                  <button className="rt-chip" onClick={() => { onOpen?.(r); dismiss(key) }}>◉ {r.recordLabel}</button>
                )}
                <span className={`rt-when ${kind}`}>{sub}</span>
              </div>
            </div>
            <button className="rt-x" title="Dismiss" onClick={() => dismiss(key)}>✕</button>
          </div>
          <div className="rt-actions">
            <button className="rt-btn done" onClick={() => act(key, () => completeReminder(r.id))}>✓ Done</button>
            <button className="rt-btn" onClick={() => act(key, () => snoozeReminder(r.id, new Date(Date.now() + 3600000).toISOString(),
              r.end && r.start ? Math.max(15, Math.round((new Date(r.end) - new Date(r.start)) / 60000)) : 30))}>⏱ Snooze 1h</button>
            <button className="rt-btn" onClick={() => { onOpen?.(r); dismiss(key) }}>↗ Open</button>
          </div>
        </div>
      ))}
    </div>
  )
}
