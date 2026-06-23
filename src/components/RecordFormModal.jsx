import { useState, useEffect } from 'react'
import ContactPicker from './ContactPicker'
import './RecordFormModal.css'

// Generic, config-driven "new record" modal. Each module passes a `fields`
// schema; the modal renders the form, validates required fields, and calls
// onCreate(fieldData). The caller handles createRecord + cache insert + select.
//
// Field shape:
//   { key, label, type, required?, default?, wide?, placeholder?, options?, step? }
//   type: 'text' | 'number' | 'date' | 'textarea' | 'select'
//   options (for select): ['A','B'] or [{ value, label }]
//
// Pass extra module-specific UI (e.g. Shopify/QBO toggles) as children.

export default function RecordFormModal({ title, fields, submitLabel = 'Create', onCreate, onClose, children }) {
  const [values, setValues] = useState(() => {
    const init = {}
    fields.forEach(f => { init[f.key] = f.default ?? '' })
    return init
  })
  const [status, setStatus] = useState(null) // null | 'saving' | 'error'
  const [error, setError] = useState('')
  const [pickerField, setPickerField] = useState(null) // contact field whose picker is open
  const [labels, setLabels] = useState({})             // key -> human label for picked refs

  const set = (k, v) => setValues(s => ({ ...s, [k]: v }))

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape' && status !== 'saving') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, status])

  async function submit() {
    const missing = fields.find(f => f.required && !String(values[f.key] ?? '').trim())
    if (missing) { setError(`${missing.label} is required.`); setStatus('error'); return }
    setStatus('saving'); setError('')
    try {
      // Drop empty strings so we don't write blanks over field defaults/calcs.
      const fieldData = {}
      for (const f of fields) {
        const v = values[f.key]
        if (v !== '' && v != null) fieldData[f.key] = v
      }
      await onCreate(fieldData)
      onClose()
    } catch (e) {
      setError(e.message || 'Something went wrong.')
      setStatus('error')
    }
  }

  return (
    <div className="rfm-backdrop" onClick={e => e.target === e.currentTarget && status !== 'saving' && onClose()}>
      <div className="rfm-drawer">
        <div className="rfm-header">
          <h2>{title}</h2>
          <button className="rfm-close" onClick={onClose} disabled={status === 'saving'}>✕</button>
        </div>

        <div className="rfm-body">
          <div className="rfm-grid">
            {fields.map(f => (
              <label key={f.key} className={`rfm-field${f.wide || f.type === 'textarea' || f.type === 'contact' ? ' wide' : ''}`}>
                <span className="rfm-label">{f.label}{f.required && <span className="rfm-req"> *</span>}</span>
                {f.type === 'contact' ? (
                  <button type="button" className={`rfm-picker${values[f.key] ? ' set' : ''}`} onClick={() => setPickerField(f)}>
                    {labels[f.key] || (values[f.key] ? `#${values[f.key]}` : 'Select a contact…')}
                  </button>
                ) : (
                  <FieldInput field={f} value={values[f.key]} onChange={v => set(f.key, v)} />
                )}
              </label>
            ))}
          </div>
          {children}
        </div>

        <div className="rfm-footer">
          {status === 'error' && <span className="rfm-error">{error}</span>}
          <button className="rfm-btn cancel" onClick={onClose} disabled={status === 'saving'}>Cancel</button>
          <button className="rfm-btn save" onClick={submit} disabled={status === 'saving'}>
            {status === 'saving' ? 'Creating…' : submitLabel}
          </button>
        </div>
      </div>

      {pickerField && (
        <ContactPicker
          onSelect={contact => {
            const f = pickerField
            const pk = contact.fieldData?.[f.valueField || '_kpt__Contact_ID']
            const label = contact.fieldData?.[f.labelField || 'zz__Display__ct'] || contact.fieldData?.Name_Organization
            set(f.key, pk)
            setLabels(l => ({ ...l, [f.key]: label }))
            setPickerField(null)
          }}
          onClose={() => setPickerField(null)}
        />
      )}
    </div>
  )
}

function FieldInput({ field, value, onChange }) {
  const v = value ?? ''
  switch (field.type) {
    case 'select':
      return (
        <select value={v} onChange={e => onChange(e.target.value)}>
          {!field.required && <option value="">—</option>}
          {(field.options || []).map(o =>
            typeof o === 'string'
              ? <option key={o} value={o}>{o}</option>
              : <option key={o.value} value={o.value}>{o.label}</option>
          )}
        </select>
      )
    case 'textarea':
      return <textarea value={v} rows={4} placeholder={field.placeholder} onChange={e => onChange(e.target.value)} />
    case 'number':
      return <input type="number" value={v} step={field.step || 'any'} placeholder={field.placeholder} onChange={e => onChange(e.target.value)} />
    case 'date':
      return <input type="text" value={v} placeholder={field.placeholder || 'MM/DD/YYYY'} onChange={e => onChange(e.target.value)} />
    default:
      return <input type="text" value={v} placeholder={field.placeholder} onChange={e => onChange(e.target.value)} />
  }
}
