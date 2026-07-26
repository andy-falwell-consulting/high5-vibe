import { CATEGORIES, ELEMENT_GRADES, EQUIPMENT, groupByCategory } from '../api/inspectionLines';
import './InspectionLines.css';

// Editable line-item table for an inspection. Presentational — the parent owns
// the staged edits and commits them on Save, matching how field `edits` work on
// the rest of the record pages.
//
// Rows are grouped by Category in the canonical value-list order (History →
// Repairs), which is also the order the PDF report builds its sections in, so
// what you see here is the order the report comes out.

const isOn = v => v === 1 || v === '1' || v === true;
const fmText = v => (typeof v === 'string' ? v.replace(/\r/g, '\n') : v);

function Row({ line, carried, onEdit, onDelete, onUndelete }) {
  const deleted = !!line._deleted;
  const id = line.recordId || line._tempId;
  const set = (k, v) => onEdit(id, k, v);

  return (
    <tr className={`insp-li-row${deleted ? ' deleted' : ''}${line._tempId ? ' is-new' : ''}`}>
      <td className="chk">
        <input type="checkbox" checked={isOn(line.Flag_Checkbox)} disabled={deleted}
          onChange={e => set('Flag_Checkbox', e.target.checked ? '1' : '')} aria-label="Flag" />
      </td>
      <td className="grade">
        <select value={line.Element_Grade || ''} disabled={deleted} onChange={e => set('Element_Grade', e.target.value)}>
          <option value="">—</option>
          {ELEMENT_GRADES.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
      </td>
      <td className="equip">
        <select value={line.Equipment || ''} disabled={deleted} onChange={e => set('Equipment', e.target.value)}>
          <option value="">—</option>
          {EQUIPMENT.map(g => <option key={g} value={g}>{g}</option>)}
          {line.Equipment && !EQUIPMENT.includes(line.Equipment) && <option value={line.Equipment}>{line.Equipment}</option>}
        </select>
      </td>
      <td className="num">
        <input className="qty" inputMode="decimal" value={line.Quantity ?? ''} disabled={deleted}
          onChange={e => set('Quantity', e.target.value)} aria-label="Quantity" />
      </td>
      <td className="desc">
        <textarea rows={2} value={fmText(line.Description) || ''} disabled={deleted}
          onChange={e => set('Description', e.target.value)} placeholder="Describe the element and its condition…" />
        {carried && !deleted && (
          <span className="insp-li-carried" title="Copied from a previous inspection — not yet reviewed this year">carried over</span>
        )}
      </td>
      <td className="act">
        {deleted
          ? <button type="button" className="insp-li-undo" onClick={() => onUndelete(id)}>Undo</button>
          : <button type="button" className="insp-li-del" title="Remove this line" onClick={() => onDelete(id)}>✕</button>}
      </td>
    </tr>
  );
}

export default function InspectionLines({ lines, carriedIds, onEdit, onDelete, onUndelete, onAdd }) {
  const groups = groupByCategory(lines);
  const live = lines.filter(l => !l._deleted);
  const carriedCount = live.filter(l => carriedIds?.has(String(l.recordId))).length;

  return (
    <div className="insp-li">
      <div className="insp-li-bar">
        <span className="insp-li-count">{live.length} line{live.length === 1 ? '' : 's'}</span>
        {carriedCount > 0 && (
          <span className="insp-li-warn" title="These lines came from a previous inspection and haven't been edited yet">
            ⚠ {carriedCount} still carried over
          </span>
        )}
        <span className="insp-li-spacer" />
        <select className="insp-li-add" value="" onChange={e => { if (e.target.value) { onAdd(e.target.value); e.target.value = ''; } }}>
          <option value="">＋ Add line…</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {live.length === 0 && lines.length === 0 ? (
        <p className="insp-empty-portal">No line items. Add one, or copy a previous inspection when creating.</p>
      ) : (
        <div className="insp-table-wrap">
          <table className="insp-table insp-li-table">
            <thead>
              <tr>
                <th className="chk" />
                <th className="grade">Grade</th>
                <th className="equip">Equipment</th>
                <th className="num">Qty</th>
                <th className="desc">Element</th>
                <th className="act" />
              </tr>
            </thead>
            {groups.map(g => (
              <tbody key={g.category}>
                <tr className="insp-li-group">
                  <td colSpan={6}>{g.category}<span className="insp-li-group-n">{g.lines.filter(l => !l._deleted).length}</span></td>
                </tr>
                {g.lines.map(l => (
                  <Row key={l.recordId || l._tempId} line={l}
                    carried={carriedIds?.has(String(l.recordId))}
                    onEdit={onEdit} onDelete={onDelete} onUndelete={onUndelete} />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </div>
  );
}
