import { useState, useEffect } from 'react'
import { createReminder, updateReminder } from '../api/reminders'
import { recordSourceFor } from '../config/recordSources'
import RecordPicker from './RecordPicker'
import './ReminderModal.css'

// Create or edit a reminder (a Google Calendar event). Open for create with
// `initial` { recordType, recordId, recordLabel, title }, or for edit with a
// full `reminder` object.
const REMIND_OPTIONS = [
  { id: 'at',   label: 'At time of event', overrides: [{ method: 'popup', minutes: 0 }] },
  { id: '10',   label: '10 minutes before', overrides: [{ method: 'popup', minutes: 10 }] },
  { id: '30',   label: '30 minutes before', overrides: [{ method: 'popup', minutes: 30 }] },
  { id: '60',   label: '1 hour before',     overrides: [{ method: 'popup', minutes: 60 }] },
  { id: '1440', label: '1 day before (popup + email)', overrides: [{ method: 'popup', minutes: 1440 }, { method: 'email', minutes: 1440 }] },
]
const DURATIONS = [[15, '15 min'], [30, '30 min'], [60, '1 hour'], [120, '2 hours']]

function pad(n) { return String(n).padStart(2, '0') }
function toLocalParts(d) {
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}
function nextHour() {
  const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d
}

export default function ReminderModal({ reminder, initial = {}, onClose, onSaved }) {
  const editing = !!reminder
  const startDate = editing && reminder.start ? new Date(reminder.start) : nextHour()
  const initParts = toLocalParts(startDate)
  const initDuration = editing && reminder.start && reminder.end
    ? Math.max(15, Math.round((new Date(reminder.end) - new Date(reminder.start)) / 60000)) : 30

  const [title, setTitle] = useState(reminder?.title || initial.title || '')
  const [date, setDate] = useState(initParts.date)
  const [time, setTime] = useState(initParts.time)
  const [duration, setDuration] = useState(initDuration)
  const [remindId, setRemindId] = useState('10')
  const [notes, setNotes] = useState(reminder?.notes || '')
  const [status, setStatus] = useState(null) // null | 'saving' | 'error'
  const [error, setError] = useState('')
  const [link, setLink] = useState(() => ({
    recordType: reminder?.recordType || initial.recordType || '',
    recordId: reminder?.recordId || initial.recordId || '',
    recordLabel: reminder?.recordLabel || initial.recordLabel || '',
  }))
  const [pickerOpen, setPickerOpen] = useState(false)
  const linkSource = recordSourceFor(link.recordType)

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape' && status !== 'saving') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, status])

  async function save() {
    if (!title.trim()) { setError('Give the reminder a title.'); setStatus('error'); return }
    if (!date || !time) { setError('Pick a date and time.'); setStatus('error'); return }
    const startISO = new Date(`${date}T${time}`).toISOString()
    const overrides = REMIND_OPTIONS.find(o => o.id === remindId)?.overrides
    setStatus('saving'); setError('')
    try {
      const linkChanged = editing && (
        link.recordType !== (reminder.recordType || '') ||
        link.recordId !== (reminder.recordId || '') ||
        link.recordLabel !== (reminder.recordLabel || '')
      )
      const saved = editing
        ? await updateReminder(reminder.id, { title: title.trim(), notes, startISO, durationMin: Number(duration), overrides,
            recordLink: linkChanged ? link : undefined })
        : await createReminder({ title: title.trim(), notes, startISO, durationMin: Number(duration), overrides,
            recordType: link.recordType, recordId: link.recordId, recordLabel: link.recordLabel })
      onSaved?.(saved)
      onClose()
    } catch (e) {
      setError(e.message || 'Could not save'); setStatus('error')
    }
  }

  return (
    <div className="rmm-backdrop" onClick={e => e.target === e.currentTarget && status !== 'saving' && onClose()}>
      <div className="rmm-panel">
        <div className="rmm-header">
          <h3>{editing ? 'Edit reminder' : 'New reminder'}</h3>
          <button className="rmm-close" onClick={onClose} disabled={status === 'saving'}>✕</button>
        </div>
        <div className="rmm-body">
          <label className="rmm-field"><span>Title</span>
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Follow up with…" autoFocus />
          </label>
          <div className="rmm-field">
            <span>Linked record</span>
            {link.recordId ? (
              <div className="rmm-link">
                <span className="rmm-link-tag" style={{ color: linkSource?.color || '#94a3b8', background: (linkSource?.color || '#94a3b8') + '1f' }}>
                  {linkSource?.type || link.recordType}
                </span>
                <span className="rmm-link-name">{link.recordLabel}</span>
                <button type="button" className="rmm-link-change" onClick={() => setPickerOpen(true)}>Change</button>
                <button type="button" className="rmm-link-remove" title="Remove link" onClick={() => setLink({ recordType: '', recordId: '', recordLabel: '' })}>✕</button>
              </div>
            ) : (
              <button type="button" className="rmm-link-attach" onClick={() => setPickerOpen(true)}>＋ Attach a record</button>
            )}
          </div>
          <div className="rmm-row">
            <label className="rmm-field"><span>Date</span>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} />
            </label>
            <label className="rmm-field"><span>Time</span>
              <input type="time" value={time} onChange={e => setTime(e.target.value)} />
            </label>
          </div>
          <div className="rmm-row">
            <label className="rmm-field"><span>Duration</span>
              <select value={duration} onChange={e => setDuration(e.target.value)}>
                {DURATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="rmm-field"><span>Remind me</span>
              <select value={remindId} onChange={e => setRemindId(e.target.value)}>
                {REMIND_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
          </div>
          <label className="rmm-field"><span>Notes</span>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Optional" />
          </label>
        </div>
        <div className="rmm-footer">
          {status === 'error' && <span className="rmm-error">{error}</span>}
          <button className="rmm-btn cancel" onClick={onClose} disabled={status === 'saving'}>Cancel</button>
          <button className="rmm-btn save" onClick={save} disabled={status === 'saving'}>{status === 'saving' ? 'Saving…' : (editing ? 'Save' : 'Create')}</button>
        </div>
      </div>
      {pickerOpen && (
        <RecordPicker
          title="Attach a record"
          onClose={() => setPickerOpen(false)}
          onSelect={r => { setLink({ recordType: r.module, recordId: String(r.recordId), recordLabel: r.title }); setPickerOpen(false) }}
        />
      )}
    </div>
  )
}
