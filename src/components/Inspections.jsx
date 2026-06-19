import { useState, useCallback, useRef, useEffect } from 'react';
import { getRecord, prefetchRecord, updateRecord, invalidateRecord, patchCachedRecord } from '../api/filemaker';
import { useAllRecords } from '../hooks/useAllRecords';
import ColorLegend from './ColorLegend';
import './Inspections.css';

const LAYOUT = 'Inspections_New';
const CACHE_VERSION = 1;

const STATUS_COLOR = {
  'Needs Repair': '#e8322a',
  'Report Ready': '#22c55e',
  Open:           '#64748b',
  default:        '#64748b',
};

// Checkbox groups from the "More Info" tab
const FACILITATOR_ACCESS = [
  { key: 'fa_Leads_and_Y_Lanyards', label: 'Leads and Y Lanyards' },
  { key: 'fa_Rope_Grabs',           label: 'Rope Grabs' },
  { key: 'fa_Cable_Grab',           label: 'Cable Grab' },
  { key: 'fa_Prusik',               label: 'Prusik' },
  { key: 'fa_Belay_Extra_P_Cord',   label: 'Belay / Extra p-cord' },
  { key: 'fa_Stairs_Ladder',        label: 'Stairs / Ladder' },
  { key: 'ALF',                     label: 'ALF' },
  { key: 'fa_other',                label: 'Other' },
];

const COURSE_TYPE = [
  { key: 'ct_Low',                   label: 'Low' },
  { key: 'ct_High',                  label: 'High' },
  { key: 'ct_Trees',                 label: 'Trees' },
  { key: 'ct_Poles',                 label: 'Poles' },
  { key: 'ct_Indoors',               label: 'Indoors' },
  { key: 'ct_Dynamic',               label: 'Dynamic' },
  { key: 'ct_Static_Voyageur_Style', label: 'Static, Voyageur Style' },
  { key: 'ct_Auto_Belay',            label: 'Auto Belay' },
  { key: 'ct_Other',                 label: 'Other' },
];

const isChecked = v => v != null && v !== '' && v !== '0';

// FileMaker stores line breaks as carriage returns (\r), which CSS pre-wrap
// won't break on — normalize to \n for display.
const fmText = v => (typeof v === 'string' ? v.replace(/\r/g, '\n') : v);

function statusOf(f) {
  if (isChecked(f.needs_repair)) return 'Needs Repair';
  if (f['Report Ready'] === 'Yes' || isChecked(f['Report Ready'])) return 'Report Ready';
  return 'Open';
}

// Current value for a field, preferring an unsaved edit.
const val = (f, edits, fk) => (fk in edits ? edits[fk] : f?.[fk]);
const isDirty = (f, edits, fk) => fk in edits && edits[fk] !== (f?.[fk] ?? '');

function TextField({ label, fieldKey, f, edits, onChange, editing, editable, mono, wide }) {
  const v = val(f, edits, fieldKey);
  const dirty = isDirty(f, edits, fieldKey);
  return (
    <div className={`insp-field${wide ? ' wide' : ''}`}>
      <label>{label}{dirty && <span className="insp-dirty-dot" />}</label>
      {editing && editable ? (
        <input className="insp-input" value={v || ''} onChange={e => onChange(fieldKey, e.target.value)} />
      ) : (
        <span className={`insp-value${mono ? ' mono' : ''}`}>{fmText(v) || '—'}</span>
      )}
    </div>
  );
}

function ToggleField({ label, fieldKey, f, edits, onChange, editing, onValue }) {
  const raw = val(f, edits, fieldKey);
  const on = onValue === 'Yes' ? (raw === 'Yes' || isChecked(raw)) : isChecked(raw);
  const dirty = isDirty(f, edits, fieldKey);
  return (
    <div className="insp-field">
      <label>{label}{dirty && <span className="insp-dirty-dot" />}</label>
      {editing ? (
        <button type="button" className={`insp-pill-toggle${on ? ' on' : ''}`}
          onClick={() => onChange(fieldKey, on ? '' : onValue)}>
          <span className="insp-pill-dot" />{on ? 'Yes' : 'No'}
        </button>
      ) : (
        <span className="insp-value">{on ? 'Yes' : 'No'}</span>
      )}
    </div>
  );
}

function CheckGrid({ items, f, edits, onChange, editing }) {
  return (
    <div className="insp-check-grid">
      {items.map(({ key, label }) => {
        const on = isChecked(val(f, edits, key));
        const dirty = isDirty(f, edits, key);
        return (
          <div key={key}
            className={`insp-check-row${on ? ' on' : ''}${editing ? ' editable' : ''}${dirty ? ' dirty' : ''}`}
            onClick={editing ? () => onChange(key, on ? '' : '1') : undefined}>
            <span className="insp-check-box">{on ? '✓' : ''}</span>
            <span className="insp-check-label">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function Section({ title, icon, children }) {
  return (
    <div className="insp-section">
      <div className="insp-section-header">
        <span className="insp-section-icon">{icon}</span>
        <h3>{title}</h3>
      </div>
      {children}
    </div>
  );
}

export default function Inspections({ navTarget, onClearNav } = {}) {
  const { records, total } = useAllRecords(LAYOUT, { cacheVersion: CACHE_VERSION });
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');
  const [sortField, setSortFieldRaw] = useState(() => localStorage.getItem('insp_sort_field') || 'date');
  const [sortOrder, setSortOrderRaw] = useState(() => localStorage.getItem('insp_sort_order') || 'desc');
  const [navWidth, setNavWidth] = useState(300);
  const [dataEditing, setDataEditing] = useState(false);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const isResizing = useRef(false);

  const setSortField = v => { setSortFieldRaw(v); localStorage.setItem('insp_sort_field', v); };
  const setSortOrder = v => { setSortOrderRaw(v); localStorage.setItem('insp_sort_order', v); };

  const parseFmDate = v => {
    if (!v) return 0;
    const [date, time = '00:00:00'] = v.split(' ');
    const [m, d, y] = date.split('/');
    return new Date(`${y}-${m}-${d}T${time}`).getTime();
  };

  const filtered = records.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    const f = r.fieldData;
    return (
      f.Organization?.toLowerCase().includes(q) ||
      f['inspt_CNTCT::NameFirstLast']?.toLowerCase().includes(q) ||
      f['inspt_CNTCT__site::Site Number']?.toLowerCase().includes(q) ||
      f['Inspectors Name']?.toLowerCase().includes(q) ||
      String(f._kpt__Inspection_ID || '').includes(q)
    );
  });

  const sortedFiltered = [...filtered].sort((a, b) => {
    let va, vb;
    if (sortField === 'alpha') {
      va = (a.fieldData.Organization || '').toLowerCase();
      vb = (b.fieldData.Organization || '').toLowerCase();
    } else if (sortField === 'date') {
      va = parseFmDate(a.fieldData.Date);
      vb = parseFmDate(b.fieldData.Date);
    } else if (sortField === 'created') {
      va = parseFmDate(a.fieldData.zz__Created_On);
      vb = parseFmDate(b.fieldData.zz__Created_On);
    } else {
      va = parseFmDate(a.fieldData.zz__Modified_On);
      vb = parseFmDate(b.fieldData.zz__Modified_On);
    }
    if (va < vb) return sortOrder === 'asc' ? -1 : 1;
    if (va > vb) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  });

  async function handleSelect(r) {
    setEdits({}); setDataEditing(false); setSaveStatus(null);
    setSelected(r);
    getRecord(LAYOUT, r.recordId).then(detail => {
      setSelected(prev => prev?.recordId === r.recordId ? detail.response.data[0] : prev);
    }).catch(() => {});
  }

  // Deep-link from the command palette: select a record by id
  useEffect(() => {
    if (navTarget?.moduleId !== 'inspections' || !navTarget.recordId) return;
    const rec = records.find(r => String(r.recordId) === String(navTarget.recordId));
    if (rec) { handleSelect(rec); onClearNav?.(); }
  }, [navTarget, records]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFieldChange = useCallback((fk, v) => setEdits(p => ({ ...p, [fk]: v })), []);
  const handleDiscard = () => { setEdits({}); setDataEditing(false); setSaveStatus(null); };

  async function handleSave() {
    const dirtyCount = Object.keys(edits).length;
    if (!dirtyCount) { setDataEditing(false); return; }
    setSaving(true); setSaveStatus(null);
    try {
      await updateRecord(LAYOUT, selected.recordId, edits);
      // Apply saved values optimistically — no blocking refetch (which can be
      // starved behind background batch loads). Patch the list cache so the
      // sidebar status dot updates, and drop the detail cache so a later
      // reopen pulls authoritative data from the server.
      patchCachedRecord(LAYOUT, CACHE_VERSION, selected.recordId, edits);
      invalidateRecord(LAYOUT, selected.recordId);
      setSelected(prev => ({ ...prev, fieldData: { ...prev.fieldData, ...edits } }));
      setEdits({}); setDataEditing(false); setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch { setSaveStatus('error'); }
    finally { setSaving(false); }
  }

  const startResize = useCallback((e) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const startX = e.clientX;
    const startW = navWidth;
    const onMove = (e) => {
      if (!isResizing.current) return;
      setNavWidth(Math.min(520, Math.max(200, startW + (e.clientX - startX))));
    };
    const onUp = () => {
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [navWidth]);

  const f = selected?.fieldData;
  const p = selected?.portalData;
  const lineItems = p?.inspt_INSPLI || [];
  const dirtyCount = Object.keys(edits).length;

  return (
    <div className="insp-container">
      <aside className="insp-sidebar" style={{ width: navWidth }}>
        <div className="insp-sidebar-header">
          <div className="insp-sidebar-title">
            <div>
              <div className="insp-sidebar-module">Inspections</div>
              <div className="insp-sidebar-count">{total ? `${total.toLocaleString()} inspections` : 'Loading…'}</div>
            </div>
          </div>
          <div className="insp-search-wrap" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <span className="insp-search-icon">⌕</span>
              <input className="insp-search" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <ColorLegend items={Object.entries(STATUS_COLOR).filter(([k]) => k !== 'default').map(([label, color]) => ({ label, color }))} />
          </div>
          <div className="sort-bar">
            <select className="sort-field" value={sortField} onChange={e => setSortField(e.target.value)}>
              <option value="date">Date</option>
              <option value="alpha">A–Z</option>
              <option value="created">Created</option>
              <option value="modified">Modified</option>
            </select>
            <button className="sort-order-btn" onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}>
              {sortOrder === 'asc' ? '↑' : '↓'}
            </button>
          </div>
        </div>

        {records.length === 0 ? (
          <div className="insp-loading">{[...Array(8)].map((_, i) => <div key={i} className="insp-skeleton" />)}</div>
        ) : (
          <ul className="insp-list">
            {sortedFiltered.map(r => {
              const status = statusOf(r.fieldData);
              const color = STATUS_COLOR[status] || STATUS_COLOR.default;
              return (
                <li key={r.recordId}
                  className={`insp-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                  onClick={() => handleSelect(r)}
                  onMouseEnter={() => prefetchRecord(LAYOUT, r.recordId)}
                >
                  <span className="insp-item-dot" style={{ background: color }} />
                  <div className="insp-item-text">
                    <div className="insp-item-name">{r.fieldData.Organization || r.fieldData['inspt_CNTCT__site::Name_Organization'] || '—'}</div>
                    <div className="insp-item-sub">
                      {[r.fieldData['inspt_CNTCT__site::Site Number'], r.fieldData.Date].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <div className="insp-resize-handle" onMouseDown={startResize} />

      <main className="insp-main">
        {!selected && (
          <div className="insp-empty-state">
            <div className="insp-empty-icon">⚑</div>
            <p>Select an inspection</p>
          </div>
        )}

        {selected && f && (
          <>
            <div className="insp-topbar">
              <div className="insp-topbar-left">
                <div>
                  <h1 className="insp-title">{f.Organization || f['inspt_CNTCT__site::Name_Organization'] || '—'}</h1>
                  <div className="insp-meta-row">
                    {(() => {
                      const status = statusOf({ ...f, ...edits });
                      const color = STATUS_COLOR[status] || STATUS_COLOR.default;
                      return <span className="insp-chip status" style={{ background: color + '22', color, borderColor: color + '44' }}>{status}</span>;
                    })()}
                    {f.Date && <span className="insp-chip muted">{f.Date}</span>}
                    {f['inspt_CNTCT__site::Site Number'] && <span className="insp-chip type">{f['inspt_CNTCT__site::Site Number']}</span>}
                  </div>
                </div>
              </div>
              <div className="insp-topbar-actions">
                {saveStatus === 'saved' && <span className="insp-status saved">✓ Saved</span>}
                {saveStatus === 'error' && <span className="insp-status error">✗ Failed</span>}
                {!dataEditing ? (
                  <button className="insp-btn-edit" onClick={() => setDataEditing(true)}>✎ Edit</button>
                ) : (
                  <>
                    <button className="insp-btn-discard" onClick={handleDiscard} disabled={saving}>Discard</button>
                    <button className="insp-btn-save" onClick={handleSave} disabled={saving || dirtyCount === 0}>
                      {saving ? 'Saving…' : dirtyCount ? `Save ${dirtyCount} change${dirtyCount > 1 ? 's' : ''}` : 'Save'}
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="insp-content">
              <Section title="Inspection Details" icon="◈">
                <div className="insp-field-grid">
                  <TextField label="Site" fieldKey="inspt_CNTCT__site::Name_Organization" f={f} edits={edits} onChange={handleFieldChange} editing={dataEditing} editable={false} />
                  <TextField label="Site Number" fieldKey="inspt_CNTCT__site::Site Number" f={f} edits={edits} onChange={handleFieldChange} editing={dataEditing} editable={false} mono />
                  <TextField label="Date" fieldKey="Date" f={f} edits={edits} onChange={handleFieldChange} editing={dataEditing} editable />
                  <TextField label="Inspector Name" fieldKey="Inspectors Name" f={f} edits={edits} onChange={handleFieldChange} editing={dataEditing} editable />
                  <TextField label="Inspection #" fieldKey="_kpt__Inspection_ID" f={f} edits={edits} onChange={handleFieldChange} editing={dataEditing} editable={false} mono />
                  <TextField label="Individual" fieldKey="inspt_CNTCT::NameFirstLast" f={f} edits={edits} onChange={handleFieldChange} editing={dataEditing} editable={false} />
                  <TextField label="Email" fieldKey="inspt_CNTCT::zz__Email__ct" f={f} edits={edits} onChange={handleFieldChange} editing={dataEditing} editable={false} />
                  <ToggleField label="Report Ready" fieldKey="Report Ready" f={f} edits={edits} onChange={handleFieldChange} editing={dataEditing} onValue="Yes" />
                  <ToggleField label="Needs Repair" fieldKey="needs_repair" f={f} edits={edits} onChange={handleFieldChange} editing={dataEditing} onValue="1" />
                  <TextField label="Address" fieldKey="Address_Block_Billing" f={f} edits={edits} onChange={handleFieldChange} editing={dataEditing} editable={false} wide />
                </div>
              </Section>

              <Section title="Facilitator Access" icon="⚐">
                <CheckGrid items={FACILITATOR_ACCESS} f={f} edits={edits} onChange={handleFieldChange} editing={dataEditing} />
              </Section>

              <Section title="Course Type" icon="◑">
                <CheckGrid items={COURSE_TYPE} f={f} edits={edits} onChange={handleFieldChange} editing={dataEditing} />
              </Section>

              <Section title={`Line Items${lineItems.length ? ` (${lineItems.length})` : ''}`} icon="≡">
                {lineItems.length === 0 ? (
                  <p className="insp-empty-portal">No line items</p>
                ) : (
                  <div className="insp-table-wrap">
                    <table className="insp-table">
                      <thead>
                        <tr>
                          <th className="chk"></th>
                          <th>Category</th>
                          <th>Element Grade</th>
                          <th>Equipment</th>
                          <th className="num">Quantity</th>
                          <th>Element</th>
                          <th>Item Name</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lineItems.map((r, i) => (
                          <tr key={r.recordId || i}>
                            <td className="chk">{isChecked(r['inspt_INSPLI::Flag_Checkbox']) ? '☑' : '☐'}</td>
                            <td>{r['inspt_INSPLI::Category']}</td>
                            <td>{r['inspt_INSPLI::Element_Grade']}</td>
                            <td>{r['inspt_INSPLI::Equipment']}</td>
                            <td className="num">{r['inspt_INSPLI::Quantity']}</td>
                            <td className="insp-element">{fmText(r['inspt_INSPLI::Description'])}</td>
                            <td>{r['ITEM::Name']}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>

              <div className="insp-record-footer">
                ID {f._kpt__Inspection_ID} · Created {f.zz__Created_On?.split(' ')[0]} by {f.zz__Created_By} · Modified {f.zz__Modified_On?.split(' ')[0] || '—'} by {f.zz__Modified_By}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
