import { useState, useCallback, useRef, useEffect } from 'react';
import { getRecord, getRecordWithPortals, prefetchRecord, updateRecord, invalidateRecord, patchCachedRecord, createRecord, addCachedRecord } from '../api/filemaker';
import { useAllRecords } from '../hooks/useAllRecords';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import RecordSaveBar from './RecordSaveBar';
import RecordFormModal from './RecordFormModal';
import { generateAndAttachReport, downloadReport, inspectionAttachments } from '../api/inspectionAttachments';
import AttachmentsPanel from './AttachmentsPanel';
import InspectionLines from './InspectionLines';
import { toLine, addLines, updateLine, deleteLine, copyLines } from '../api/inspectionLines';
import { fetchCarriedLines, markCarriedLines, clearCarriedLine } from '../api/naFlags';
import { copyProfileFields } from '../config/inspectionCopy';
import './Inspections.css';

const LAYOUT = 'Inspections_New';
const CACHE_VERSION = 1;

const STATUS_COLOR = {
  'Needs Repair': '#ED1C24',
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

export default function Inspections({ navTarget, onClearNav, onRecordSelect } = {}) {
  const { records, total } = useAllRecords(LAYOUT, { cacheVersion: CACHE_VERSION });
  const [selected, setSelected] = useState(null);
  const [navWidth, setNavWidth] = useState(300);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [saveErrorMsg, setSaveErrorMsg] = useState(null);
  const [attBusy, setAttBusy] = useState(null); // 'report-attach' | 'report-download'
  const [attStage, setAttStage] = useState(null); // progress label while a report runs
  const [attError, setAttError] = useState(null);
  const [attReload, setAttReload] = useState(0); // bump to make AttachmentsPanel re-list
  const [showNew, setShowNew] = useState(false);
  const isResizing = useRef(false);

  const parseFmDate = v => {
    if (!v) return 0;
    const [date, time = '00:00:00'] = v.split(' ');
    const [m, d, y] = date.split('/');
    return new Date(`${y}-${m}-${d}T${time}`).getTime();
  };

  const orgName = f => f.Organization || f['inspt_CNTCT__site::Name_Organization'] || '';

  const list = useListControls({
    records,
    storageKey: 'insp_sort',
    name: orgName,
    searchKeys: ['Organization', 'inspt_CNTCT__site::Name_Organization', 'inspt_CNTCT::NameFirstLast', 'inspt_CNTCT__site::Site Number', 'Inspectors Name', '_kpt__Inspection_ID'],
    chips: [
      { id: 'all', label: 'All' },
      { id: 'repair', label: 'Needs repair', color: STATUS_COLOR['Needs Repair'], match: f => statusOf(f) === 'Needs Repair' },
      { id: 'ready', label: 'Report ready', color: STATUS_COLOR['Report Ready'], match: f => statusOf(f) === 'Report Ready' },
      { id: 'open', label: 'Open', color: STATUS_COLOR.Open, match: f => statusOf(f) === 'Open' },
    ],
    sorts: [
      { id: 'date', label: 'Date', value: f => parseFmDate(f.Date) },
      { id: 'alpha', label: 'Name', alpha: true, value: f => orgName(f).trim().toLowerCase() || '￿' },
      { id: 'created', label: 'Created', value: f => parseFmDate(f.zz__Created_On) },
      { id: 'modified', label: 'Modified', value: f => parseFmDate(f.zz__Modified_On) },
    ],
    defaultSort: 'date', defaultOrder: 'desc',
  });

  // ── Line-item editing ──
  // Staged like field `edits`: nothing is written until Save. `lineEdits` holds
  // changes to existing rows, `newLines` rows added this session, `deletedIds`
  // rows marked for removal (reversible until Save).
  const [lineEdits, setLineEdits] = useState({});
  const [newLines, setNewLines] = useState([]);
  const [deletedIds, setDeletedIds] = useState(() => new Set());
  const [carriedIds, setCarriedIds] = useState(() => new Set());
  const tempId = useRef(0);
  const selectedRef = useRef(null);   // guards async fetches against stale selections
  const copySourceRef = useRef(null); // recordId of the inspection being copied, if any
  const [copySource, setCopySource] = useState('');

  const resetLineState = useCallback(() => {
    setLineEdits({}); setNewLines([]); setDeletedIds(new Set());
  }, []);

  async function handleSelect(r) {
    setEdits({}); setSaveStatus(null);
    resetLineState();
    setCarriedIds(new Set());
    selectedRef.current = r.recordId;
    // Guarded on the record id — clicking quickly between inspections must not
    // let a slow response land on the wrong record.
    fetchCarriedLines(r.recordId).then(keys => {
      if (selectedRef.current === r.recordId) setCarriedIds(new Set(keys));
    }).catch(() => {});
    setSelected(r);
    // Plain getRecord caps the line-items portal at FileMaker's default of 50
    // (same issue the PDF report worked around) — elevate it so the on-screen
    // list matches the report and doesn't silently truncate large inspections.
    getRecordWithPortals(LAYOUT, r.recordId, { inspt_INSPLI: 2000 }).then(detail => {
      setSelected(prev => prev?.recordId === r.recordId ? detail.response.data[0] : prev);
    }).catch(() => {});
  }

  // Deep-link from the command palette / Contacts portal: select a record by id
  useEffect(() => {
    if (navTarget?.moduleId !== 'inspections' || !navTarget.recordId) return;
    const rec = records.find(r => String(r.recordId) === String(navTarget.recordId));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deep-link selection
    if (rec) { handleSelect(rec); onClearNav?.(); return; }
    // Not in the loaded list yet (still loading): fetch directly so it still opens.
    let alive = true;
    getRecord(LAYOUT, navTarget.recordId).then(d => {
      const r = d?.response?.data?.[0];
      if (alive && r) { handleSelect(r); onClearNav?.(); }
    }).catch(() => {});
    return () => { alive = false; };
  }, [navTarget, records]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Attachments live in the shared <AttachmentsPanel>; only inspection-report
  // generation stays here (passed into the panel via `actions`). ──
  const inspId = selected?.fieldData?._kpt__Inspection_ID;
  async function handleGenerateReport(attach) {
    if (!selected) return;
    setAttBusy(attach ? 'report-attach' : 'report-download');
    setAttStage('Building PDF…'); setAttError(null);
    try {
      if (attach) {
        await generateAndAttachReport(selected, setAttStage);
        setAttReload(n => n + 1); // tell the panel to re-list so the report shows
      } else {
        await downloadReport(selected, setAttStage);
      }
    } catch (e) { setAttError(e.message || 'Report failed'); }
    finally { setAttBusy(null); setAttStage(null); }
  }

  // ── Create a new inspection ──
  const createFields = [
    { key: '_kft__Contact_ID', label: 'Site / Contact', type: 'contact', required: true, orgField: 'Organization' },
    { key: 'Date',            label: 'Date',           type: 'date', default: new Date().toLocaleDateString('en-US') },
    { key: 'Inspectors Name', label: 'Inspector Name', type: 'text' },
  ];

  // Prior inspections for the contact picked in the create form — the sites are
  // re-inspected yearly, so last year's is almost always the right source.
  const priorInspections = useCallback((contactId) => {
    if (!contactId) return [];
    return records
      .filter(r => String(r.fieldData?._kft__Contact_ID || '') === String(contactId))
      .sort((a, b) => parseFmDate(b.fieldData?.Date) - parseFmDate(a.fieldData?.Date))
      .slice(0, 25);
  }, [records]);

  async function handleCreate(fieldData) {
    const source = copySourceRef.current;
    let payload = fieldData;

    // Copying carries the site's course profile across as well as its lines.
    if (source) {
      const full = await getRecord(LAYOUT, source);
      const src = full?.response?.data?.[0]?.fieldData;
      if (!src) throw new Error('Could not load the inspection to copy.');
      payload = { ...copyProfileFields(src), ...fieldData };
    }

    const res = await createRecord(LAYOUT, payload);
    const newId = res?.response?.recordId;
    if (!newId) throw new Error(res?.messages?.[0]?.message || 'Could not create the record');

    // Line items must wait until the new record exists and has its own
    // _kpt__Inspection_ID — a portal write against a record without one fails
    // with FileMaker error 101.
    if (source) {
      const copied = await copyLines(source, newId);
      if (copied.length) {
        await markCarriedLines(newId, copied.map(l => String(l.recordId))).catch(() => {});
      }
    }
    copySourceRef.current = null;

    getRecord(LAYOUT, newId).then(d => {
      const rec = d?.response?.data?.[0];
      if (rec) { addCachedRecord(LAYOUT, CACHE_VERSION, rec); handleSelect(rec); onRecordSelect?.(rec.recordId, rec.fieldData?.Organization || rec.fieldData?.['inspt_CNTCT__site::Name_Organization']); }
    }).catch(() => {});
  }

  const handleFieldChange = useCallback((fk, v) => setEdits(p => ({ ...p, [fk]: v })), []);
  const handleDiscard = () => { setEdits({}); resetLineState(); setSaveStatus(null); setSaveErrorMsg(null); };

  // Editing a line is what marks it reviewed, so the carried-over badge clears
  // as soon as someone touches it (optimistically here; persisted on Save).
  const onLineEdit = useCallback((id, field, value) => {
    if (String(id).startsWith('new:')) {
      setNewLines(rows => rows.map(r => (r._tempId === id ? { ...r, [field]: value } : r)));
      return;
    }
    setLineEdits(p => ({ ...p, [id]: { ...(p[id] || {}), [field]: value } }));
    setCarriedIds(prev => {
      if (!prev.has(String(id))) return prev;
      const next = new Set(prev); next.delete(String(id)); return next;
    });
  }, []);

  const onLineDelete = useCallback((id) => {
    if (String(id).startsWith('new:')) { setNewLines(rows => rows.filter(r => r._tempId !== id)); return; }
    setDeletedIds(prev => new Set(prev).add(String(id)));
  }, []);

  const onLineUndelete = useCallback((id) => {
    setDeletedIds(prev => { const next = new Set(prev); next.delete(String(id)); return next; });
  }, []);

  const onLineAdd = useCallback((category) => {
    const id = `new:${++tempId.current}`;
    setNewLines(rows => [...rows, { _tempId: id, Category: category, Description: '', Quantity: '', Equipment: '', Element_Grade: '', Flag_Checkbox: '' }]);
  }, []);

  // Re-read the portal after writing, so the on-screen rows carry the real
  // recordIds the server assigned (needed for any subsequent edit or delete).
  const refreshLines = useCallback(async () => {
    const id = selected?.recordId;
    if (!id) return;
    invalidateRecord(LAYOUT, id);
    const detail = await getRecordWithPortals(LAYOUT, id, { inspt_INSPLI: 2000 });
    const rec = detail?.response?.data?.[0];
    if (rec && selectedRef.current === id) setSelected(prev => (prev?.recordId === id ? rec : prev));
  }, [selected?.recordId]);

  async function handleSave() {
    const lineChanges = Object.keys(lineEdits).length + newLines.length + deletedIds.size;
    if (!Object.keys(edits).length && !lineChanges) { return; }
    setSaving(true); setSaveStatus(null); setSaveErrorMsg(null);
    try {
      // Line items first — they're the risky part. If they fail we surface the
      // error before touching the parent, rather than half-saving.
      if (lineChanges) {
        for (const id of deletedIds) await deleteLine(selected.recordId, id);
        for (const [id, changes] of Object.entries(lineEdits)) {
          if (deletedIds.has(String(id))) continue;   // deleted wins over edited
          await updateLine(selected.recordId, id, changes);
        }
        const toAdd = newLines.filter(l => (l.Description || '').trim() || l.Quantity || l.Equipment || l.Element_Grade);
        if (toAdd.length) await addLines(selected.recordId, toAdd);

        // Persist the cleared carried-over flags for the lines just edited.
        for (const id of Object.keys(lineEdits)) clearCarriedLine(selected.recordId, id).catch(() => {});
        for (const id of deletedIds) clearCarriedLine(selected.recordId, id).catch(() => {});

        await refreshLines();
        resetLineState();
      }
      if (Object.keys(edits).length) await updateRecord(LAYOUT, selected.recordId, edits);
      // Apply saved values optimistically — no blocking refetch (which can be
      // starved behind background batch loads). Patch the list cache so the
      // sidebar status dot updates, and drop the detail cache so a later
      // reopen pulls authoritative data from the server.
      patchCachedRecord(LAYOUT, CACHE_VERSION, selected.recordId, edits);
      invalidateRecord(LAYOUT, selected.recordId);
      setSelected(prev => ({ ...prev, fieldData: { ...prev.fieldData, ...edits } }));
      setEdits({}); setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (e) { setSaveStatus('error'); setSaveErrorMsg(e?.message || null); }
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

  // What the editor renders: saved rows with any staged edits applied and
  // deletions marked, followed by rows added this session.
  const workingLines = [
    ...lineItems.map(row => {
      const line = toLine(row);
      const staged = lineEdits[line.recordId];
      return { ...line, ...(staged || {}), _deleted: deletedIds.has(String(line.recordId)) };
    }),
    ...newLines,
  ];

  const lineChangeCount = Object.keys(lineEdits).length + newLines.length + deletedIds.size;
  const dirtyCount = Object.keys(edits).length + lineChangeCount;

  return (
    <div className="insp-container">
      <aside className="insp-sidebar" style={{ width: navWidth }}>
        <div className="insp-sidebar-header">
          <div className="insp-sidebar-title">
            <div>
              <div className="insp-sidebar-module">Inspections</div>
              <div className="insp-sidebar-count">{total ? `${total.toLocaleString()} inspections` : 'Loading…'}</div>
            </div>
            <button className="insp-new-btn" onClick={() => setShowNew(true)} title="New inspection">＋ New</button>
          </div>
          <ListToolbar c={list} unit="inspections" />
        </div>

        {records.length === 0 ? (
          <div className="insp-loading">{[...Array(8)].map((_, i) => <div key={i} className="insp-skeleton" />)}</div>
        ) : (
          <div className="insp-list">
            <ListBody c={list} activeId={selected?.recordId} renderItem={r => {
              const color = STATUS_COLOR[statusOf(r.fieldData)] || STATUS_COLOR.default;
              return (
                <div key={r.recordId}
                  className={`insp-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                  onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId, r.fieldData?.Organization || r.fieldData?.['inspt_CNTCT__site::Name_Organization']); }}
                  // onMouseEnter={() => prefetchRecord(LAYOUT, r.recordId)}
                >
                  <span className="insp-item-dot" style={{ background: color }} />
                  <div className="insp-item-text">
                    <div className="insp-item-name">{r.fieldData.Organization || r.fieldData['inspt_CNTCT__site::Name_Organization'] || '—'}</div>
                    <div className="insp-item-sub">
                      {[r.fieldData['inspt_CNTCT__site::Site Number'], r.fieldData.Date].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                </div>
              );
            }} />
          </div>
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
            </div>

            <div className="insp-content">
              <Section title="Inspection Details" icon="◈">
                <div className="insp-field-grid">
                  <TextField label="Site" fieldKey="inspt_CNTCT__site::Name_Organization" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} />
                  <TextField label="Site Number" fieldKey="inspt_CNTCT__site::Site Number" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} mono />
                  <TextField label="Date" fieldKey="Date" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <TextField label="Inspector Name" fieldKey="Inspectors Name" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable />
                  <TextField label="Inspection #" fieldKey="_kpt__Inspection_ID" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} mono />
                  <TextField label="Individual" fieldKey="inspt_CNTCT::NameFirstLast" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} />
                  <TextField label="Email" fieldKey="inspt_CNTCT::zz__Email__ct" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} />
                  <ToggleField label="Report Ready" fieldKey="Report Ready" f={f} edits={edits} onChange={handleFieldChange} editing={true} onValue="Yes" />
                  <ToggleField label="Needs Repair" fieldKey="needs_repair" f={f} edits={edits} onChange={handleFieldChange} editing={true} onValue="1" />
                  <TextField label="Address" fieldKey="Address_Block_Billing" f={f} edits={edits} onChange={handleFieldChange} editing={true} editable={false} wide />
                </div>
              </Section>

              <Section title="Facilitator Access" icon="⚐">
                <CheckGrid items={FACILITATOR_ACCESS} f={f} edits={edits} onChange={handleFieldChange} editing={true} />
              </Section>

              <Section title="Course Type" icon="◑">
                <CheckGrid items={COURSE_TYPE} f={f} edits={edits} onChange={handleFieldChange} editing={true} />
              </Section>

              <Section title="Line Items" icon="≡">
                <InspectionLines
                  lines={workingLines}
                  carriedIds={carriedIds}
                  onEdit={onLineEdit}
                  onDelete={onLineDelete}
                  onUndelete={onLineUndelete}
                  onAdd={onLineAdd}
                />
              </Section>

              <AttachmentsPanel
                parentId={inspId}
                api={inspectionAttachments}
                invoiceDocNumber={selected?.fieldData?._kat__QuickBooks_Invoice_ID}
                reloadSignal={attReload}
                actions={(
                  <>
                    <button className="att-btn" disabled={attBusy === 'report-attach' || attBusy === 'report-download'} onClick={() => handleGenerateReport(true)}>
                      {attBusy === 'report-attach' ? (attStage || 'Working…') : '＋ Generate report & attach'}
                    </button>
                    <button className="att-btn" disabled={attBusy === 'report-attach' || attBusy === 'report-download'} onClick={() => handleGenerateReport(false)}>
                      {attBusy === 'report-download' ? (attStage || 'Working…') : '⤓ Download report'}
                    </button>
                  </>
                )}
              />
              {attError && <p className="insp-att-error">{attError}</p>}

              <div className="insp-record-footer">
                ID {f._kpt__Inspection_ID} · Record {selected.recordId} · Created {f.zz__Created_On?.split(' ')[0]} by {f.zz__Created_By} · Modified {f.zz__Modified_On?.split(' ')[0] || '—'} by {f.zz__Modified_By}
              </div>
              <RecordSaveBar count={dirtyCount} saving={saving} status={saveStatus} errorMessage={saveErrorMsg} onSave={handleSave} onDiscard={handleDiscard} />
            </div>
          </>
        )}
      </main>

      {showNew && (
        <RecordFormModal
          title="New Inspection"
          fields={createFields}
          submitLabel="Create inspection"
          onCreate={handleCreate}
          onClose={() => { copySourceRef.current = null; setCopySource(''); setShowNew(false); }}
        >
          {values => {
            const prior = priorInspections(values._kft__Contact_ID);
            if (!values._kft__Contact_ID) return null;
            return (
              <div className="insp-copy-block">
                <span className="rfm-label">Start from</span>
                {prior.length === 0 ? (
                  <p className="insp-copy-note">No previous inspections for this site — this one starts empty.</p>
                ) : (
                  <>
                    <select
                      className="insp-copy-select"
                      value={copySource}
                      onChange={e => { setCopySource(e.target.value); copySourceRef.current = e.target.value || null; }}
                    >
                      <option value="">A blank inspection</option>
                      {prior.map(r => (
                        <option key={r.recordId} value={r.recordId}>
                          Copy {r.fieldData?.Date || 'undated'}{r.fieldData?.['Inspectors Name'] ? ` · ${r.fieldData['Inspectors Name']}` : ''}
                        </option>
                      ))}
                    </select>
                    {copySource && (
                      <p className="insp-copy-note">
                        Brings across the course profile and every line item. Copied lines are flagged
                        <strong> carried over</strong> until you review each one — last year's grades and
                        notes come with them.
                      </p>
                    )}
                  </>
                )}
              </div>
            );
          }}
        </RecordFormModal>
      )}
    </div>
  );
}
