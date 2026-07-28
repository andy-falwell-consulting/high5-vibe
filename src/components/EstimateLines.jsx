import { lineAmount, subtotalOf, money } from '../api/estimateLines'
import './EstimateLines.css'

// Editable line-item table for an estimate. Presentational — the parent stages
// the edits and commits them on Save, matching the rest of the record pages.
//
// Unit price always comes from the product catalogue; there's no per-line
// override, so the only editable numbers here are quantity and the description.

const fmtMoney = v => (money(v)).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

function Row({ line, onEdit, onDelete, onUndelete }) {
  const deleted = !!line._deleted
  const id = line.recordId || line._tempId
  return (
    <tr className={`est-li-row${deleted ? ' deleted' : ''}${line._tempId ? ' is-new' : ''}`}>
      <td className="desc">
        <div className="est-li-name">{line.Item_Name || '—'}</div>
        <input
          className="est-li-desc-input"
          value={line.Description || ''}
          disabled={deleted}
          placeholder="Description (optional)"
          onChange={e => onEdit(id, 'Description', e.target.value)}
        />
      </td>
      <td className="num">
        <input
          className="est-li-qty" inputMode="decimal" value={line.Quantity ?? ''} disabled={deleted}
          onChange={e => onEdit(id, 'Quantity', e.target.value)} aria-label="Quantity"
        />
      </td>
      <td className="num unit">{fmtMoney(line.Unit_Price)}</td>
      <td className="num amount">{fmtMoney(lineAmount(line))}</td>
      <td className="act">
        {deleted
          ? <button type="button" className="est-li-undo" onClick={() => onUndelete(id)}>Undo</button>
          : <button type="button" className="est-li-del" title="Remove this line" onClick={() => onDelete(id)}>✕</button>}
      </td>
    </tr>
  )
}

export default function EstimateLines({
  lines, onEdit, onDelete, onUndelete, onAddClick,
  storedSubtotal, storedTax, storedTotal, taxName, taxRate, pushedToQbo,
}) {
  const live = lines.filter(l => !l._deleted)
  const computed = subtotalOf(live)
  const stored = money(storedSubtotal)
  const dirty = lines.some(l => l._deleted || l._tempId || l._dirty)
  // Only meaningful once something has changed — otherwise a pre-existing
  // mismatch in old data would look like something we caused.
  const drift = dirty && Math.abs(computed - stored) >= 0.005

  return (
    <div className="est-li">
      <div className="est-li-bar">
        <span className="est-li-count">{live.length} line{live.length === 1 ? '' : 's'}</span>
        <span className="est-li-spacer" />
        <button type="button" className="est-li-add" onClick={onAddClick}>＋ Add item</button>
      </div>

      {pushedToQbo && dirty && (
        <p className="est-li-warn">
          ⚠ This estimate has already been pushed to QuickBooks. Changes here update Vibe and
          FileMaker only — QuickBooks won't see them, and the two will disagree.
        </p>
      )}

      {live.length === 0 && lines.length === 0 ? (
        <p className="est-empty-portal">No line items on this estimate</p>
      ) : (
        <div className="est-table-wrap">
          <table className="est-table est-li-table">
            <thead>
              <tr>
                <th className="desc">Item / Description</th>
                <th className="num">Qty</th>
                <th className="num">Unit Price</th>
                <th className="num">Amount</th>
                <th className="act" />
              </tr>
            </thead>
            <tbody>
              {lines.map(l => (
                <Row key={l.recordId || l._tempId} line={l}
                  onEdit={onEdit} onDelete={onDelete} onUndelete={onUndelete} />
              ))}
            </tbody>
          </table>

          <div className="est-totals">
            <div className="est-total-row">
              <span>Subtotal</span>
              <span>{fmtMoney(drift ? computed : stored)}</span>
            </div>
            {storedTax != null && (
              <div className="est-total-row">
                <span>Tax{taxName ? ` (${taxName})` : ''}{taxRate ? ` ${taxRate}%` : ''}</span>
                <span>{fmtMoney(storedTax)}</span>
              </div>
            )}
            <div className="est-total-row grand">
              <span>Total</span>
              <span>{fmtMoney(drift ? computed + money(storedTax) : storedTotal)}</span>
            </div>
            {drift && (
              <p className="est-li-pending">
                Showing your unsaved changes. The stored total updates when you save.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
