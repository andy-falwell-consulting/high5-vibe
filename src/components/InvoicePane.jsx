import { useState } from 'react'
import { getRecord, invalidateRecord, findRecords } from '../api/filemaker'
import { getCurrentEnv } from '../config/fmpEnvironments'
import './InvoicePane.css'

// Shared invoice pane. Renders a contact's invoices from the Portal__Invoices
// relationship (cntct_INVO); each row expands to its mirrored line items
// (Invoice_Line_Items) and opens the attached PDF from the INVO Invoice_PDF
// container. Reusable on any page that has a contact record.
const INVO_LAYOUT = 'Invoices_Form'
const LI_LAYOUT = 'Invoice_Line_Items'

const num = v => Number(v || 0)
const money = v => '$' + num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const parseFmDate = v => {
  if (!v) return 0
  const [d] = String(v).split(' ')
  const [m, day, y] = d.split('/')
  return new Date(`${y}-${m}-${day}`).getTime() || 0
}

// Amount/status for a portal row. FMP's total fields are script-maintained calcs
// (not populated via the API), so mirrored rows carry the figures as JSON in
// Memo; rows without it fall back to whatever the calc holds.
export function invoiceRowInfo(r) {
  let total = num(r['cntct_INVO::zz__Total__xn'])
  let subtotal = total, tax = 0
  let balance = num(r['cntct_INVO::zz__Balance_Due__xs'] ?? r['cntct_INVO::zz__Balance_Due__cn'])
  let status = balance > 0 ? 'Open' : (total > 0 ? 'Paid' : '—')
  try {
    const m = JSON.parse(r['cntct_INVO::Memo'] || '')
    if (m && typeof m === 'object') {
      if (m.total != null) total = num(m.total)
      if (m.subtotal != null) subtotal = num(m.subtotal)
      if (m.tax != null) tax = num(m.tax)
      if (m.balance != null) balance = num(m.balance)
      if (m.status) status = m.status
    }
  } catch { /* Memo is plain text → keep the calc values */ }
  return { total, subtotal, tax, balance, status }
}

export default function InvoicePane({ contact, title = 'Invoices' }) {
  const [busy, setBusy] = useState(null)
  const [open, setOpen] = useState(null)        // expanded invoiceId
  const [lines, setLines] = useState({})        // invoiceId -> [lineItems] | 'loading'

  const rows = (contact?.portalData?.['Portal__Invoices'] || [])
    .slice()
    .sort((a, b) => parseFmDate(b['cntct_INVO::Date']) - parseFmDate(a['cntct_INVO::Date']))

  const billed = rows.reduce((s, r) => s + invoiceRowInfo(r).total, 0)
  const openBal = rows.reduce((s, r) => s + invoiceRowInfo(r).balance, 0)

  async function toggle(invoiceId) {
    if (open === invoiceId) { setOpen(null); return }
    setOpen(invoiceId)
    if (!lines[invoiceId]) {
      setLines(p => ({ ...p, [invoiceId]: 'loading' }))
      try {
        const res = await findRecords(LI_LAYOUT, [{ _kft__Invoice_ID: `==${invoiceId}` }], 100)
        const data = (res?.response?.data || []).map(d => d.fieldData)
        setLines(p => ({ ...p, [invoiceId]: data }))
      } catch {
        setLines(p => ({ ...p, [invoiceId]: [] }))
      }
    }
  }

  async function viewPdf(recordId, ref, e) {
    e?.stopPropagation()
    if (!recordId) return
    // Hold a tab open within the user gesture (popup blockers); fill it after.
    const win = window.open('', '_blank')
    setBusy(recordId)
    try {
      invalidateRecord(INVO_LAYOUT, recordId)
      let res = await getRecord(INVO_LAYOUT, recordId)
      let streaming = res?.response?.data?.[0]?.fieldData?.Invoice_PDF
      if (!streaming) {
        // Lazily fetch the PDF from QBO and attach it to the container, then re-read.
        const db = getCurrentEnv().db
        const resp = await fetch('/api/qbo', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'attach-invoice-pdf', db, recordId, docNumber: ref }),
        })
        if (resp.ok) {
          invalidateRecord(INVO_LAYOUT, recordId)
          res = await getRecord(INVO_LAYOUT, recordId)
          streaming = res?.response?.data?.[0]?.fieldData?.Invoice_PDF
        }
      }
      if (!streaming) { win?.close(); window.alert('No PDF available for this invoice.'); return }
      let url = streaming
      try { const u = new URL(streaming); url = u.pathname + u.search } catch { /* use as-is */ }
      if (win) win.location = url; else window.open(url, '_blank')
    } catch {
      win?.close()
      window.alert('Could not open the invoice PDF.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="invp">
      <div className="invp-head">
        <div className="invp-title">{title}<span className="invp-count">{rows.length}</span></div>
        {rows.length > 0 && (
          <div className="invp-totals">
            <span>Billed <b>{money(billed)}</b></span>
            <span className={openBal > 0 ? 'invp-open' : ''}>Open <b>{money(openBal)}</b></span>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="invp-empty">No invoices for this client.</div>
      ) : (
        <table className="invp-table">
          <thead>
            <tr><th className="invp-cx"></th><th>Date</th><th>Invoice #</th><th className="num">Amount</th><th className="num">Balance</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const { total, subtotal, tax, balance, status } = invoiceRowInfo(r)
              const rid = r.recordId
              const invoiceId = r['cntct_INVO::_kpt__Invoice_ID']
              const ref = r['cntct_INVO::QuickBooks_Reference_Number'] || '—'
              const expanded = open === invoiceId
              const li = lines[invoiceId]
              return [
                <tr key={rid} className={`invp-row${expanded ? ' on' : ''}`} onClick={() => toggle(invoiceId)}>
                  <td className="invp-cx">{expanded ? '▾' : '▸'}</td>
                  <td>{r['cntct_INVO::Date'] || '—'}</td>
                  <td className="mono">#{ref}</td>
                  <td className="num">{money(total)}</td>
                  <td className="num" style={{ color: balance > 0 ? '#ED1C24' : undefined }}>{money(balance)}</td>
                  <td><span className={`invp-pill ${status === 'Paid' ? 'paid' : status === 'Open' ? 'open' : 'na'}`}>{status}</span></td>
                  <td className="invp-actcell"><button className="invp-pdf" disabled={busy === rid} onClick={e => viewPdf(rid, ref, e)}>{busy === rid ? '…' : '📄 PDF'}</button></td>
                </tr>,
                expanded && (
                  <tr key={rid + '-x'} className="invp-detail-row">
                    <td colSpan={7}>
                      {li === 'loading' ? <div className="invp-li-loading">Loading line items…</div>
                       : !li || li.length === 0 ? <div className="invp-li-loading">No line items.</div>
                       : (
                        <table className="invp-li">
                          <tbody>
                            {li.map((l, i) => (
                              <tr key={i}>
                                <td className="invp-li-desc">{l.Item_Name || '—'}</td>
                                <td className="invp-li-qty">{num(l.Quantity) ? `×${num(l.Quantity)}` : ''}</td>
                                <td className="num">{money(l.Amount)}</td>
                              </tr>
                            ))}
                            <tr className="invp-li-sub"><td>Subtotal</td><td></td><td className="num">{money(subtotal)}</td></tr>
                            {tax > 0 && <tr className="invp-li-sub"><td>Tax</td><td></td><td className="num">{money(tax)}</td></tr>}
                            <tr className="invp-li-tot"><td>Total</td><td></td><td className="num">{money(total)}</td></tr>
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                ),
              ]
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
