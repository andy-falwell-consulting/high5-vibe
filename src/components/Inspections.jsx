import { useState, useCallback, useRef, useEffect } from 'react';
import { getRecord, prefetchRecord, invalidateRecord, patchCachedRecord, addCachedRecord } from '../api/filemaker';
import { updateVibeRecord, createVibeRecord } from '../api/vibeRecords';
import { useAllRecords } from '../hooks/useAllRecords';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import RecordSaveBar from './RecordSaveBar';
import RecordFormModal from './RecordFormModal';
import { generateAndAttachReport, downloadReport, inspectionAttachments } from '../api/inspectionAttachments';
import AttachmentsPanel from './AttachmentsPanel';
import InspectionLines from './InspectionLines';
// Line items come from Vibe's own store (api/_inspectionLines.js), not the
// FileMaker portal. The exported surface matches inspectionLines.js, but the
// keys do NOT: every call takes the inspection's _kpt__Inspection_ID and a
// line's own id, where the portal client took FileMaker recordIds. That is why
// the swap is a real change rather than an import rename.
import { listLines, addLines, updateLine, deleteLine, copyLines } from '../api/inspectionLinesVibe';
import { fetchCarriedLines, markCarriedLines, clearCarriedLine } from '../api/naFlags';
import { copyProfileFields } from '../config/inspectionCopy';
import './Inspections.css';
import DeleteRecordButton from './DeleteRecordButton'
import ReminderModal from './ReminderModal'
import RecordFooter from './RecordFooter';
import { useRecordPanel } from '../hooks/useRecordPanel';

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
  const [remindOpen, setRemindOpen] = useState(false)
  // Width, drag and memory come from useRecordPanel — see the hook for what
  // the twelve hand-rolled copies had drifted into.
  const { width: navWidth, onPointerDown: startPanelResize } = useRecordPanel('inspections', 300);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [saveErrorMsg, setSaveErrorMsg] = useState(null);
  const [attBusy, setAttBusy] = useState(null); // 'report-attach' | 'report-download'
  const [attStage, setAttStage] = useState(null); // progress label while a report runs
  const [attError, setAttError] = useState(null);
  const [attReload, setAttReload] = useState(0); // bump to make AttachmentsPanel re-list
  const [showNew, setShowNew] = useState(false);

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
  // Saved lines for the open inspection. They used to arrive as
  // selected.portalData.inspt_INSPLI; Vibe serves them separately, so they get
  // their own state and their own loading flag.
  const [lines, setLines] = useState([]);
  const [linesLoading, setLinesLoading] = useState(false);
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
    setLines([]);
    // Vibe's store has no 50-row portal cap to work around, so this is one
    // read of the whole set however long the inspection is.
    const inspectionId = r.fieldData?._kpt__Inspection_ID;
    setLinesLoading(!!inspectionId);
    if (inspectionId) {
      listLines(inspectionId).then(rows => {
        if (selectedRef.current !== r.recordId) return;
        setLines(rows);
        setLinesLoading(false);
      }).catch(() => { if (selectedRef.current === r.recordId) setLinesLoading(false); });
    }
    // The record itself is still re-read: the detail pane shows related fields
    // (site, individual, e-mail) that the list-level record does not carry.
    getRecord(LAYOUT, r.recordId).then(detail => {
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

  // Prior inspections for the site picked in the create form — sites are
  // re-inspected yearly, so last year's is almost always the right source.
  //
  // Matched on Organization, NOT the contact FK: the picker hands back the org
  // contact (e.g. 4-H Camp Bristol Hills = 72380) while its inspections point
  // at a separate site contact (82201), so an FK match finds nothing. The
  // Organization text is what the inspt_CNTCT__site relationship keys on
  // anyway. FK is kept as a fallback for records with no Organization set.
  const priorInspections = useCallback((contactId, org) => {
    const orgKey = String(org || '').trim().toLowerCase();
    if (!orgKey && !contactId) return [];
    return records
      .filter(r => {
        const fd = r.fieldData || {};
        const rOrg = String(fd.Organization || fd['inspt_CNTCT__site::Name_Organization'] || '').trim().toLowerCase();
        if (orgKey && rOrg) return rOrg === orgKey;
        return contactId && String(fd._kft__Contact_ID || '') === String(contactId);
      })
      .sort((a, b) => parseFmDate(b.fieldData?.Date) - parseFmDate(a.fieldData?.Date))
      .slice(0, 25);
  }, [records]);

  async function handleCreate(fieldData) {
    const source = copySourceRef.current;
    let payload = fieldData;
    let sourceInspectionId = null;

    // Copying carries the site's course profile across as well as its lines.
    if (source) {
      const full = await getRecord(LAYOUT, source);
      const src = full?.response?.data?.[0]?.fieldData;
      if (!src) throw new Error('Could not load the inspection to copy.');
      sourceInspectionId = src._kpt__Inspection_ID;
      payload = { ...copyProfileFields(src), ...fieldData };
      // Point the copy at the SAME site contact as its predecessor. The picker
      // hands back the org contact, but inspections hang off a separate site
      // contact — inheriting it keeps the new record on the same site record
      // the previous years used.
      if (src._kft__Contact_ID) payload._kft__Contact_ID = String(src._kft__Contact_ID);
    }

    // Born in Vibe, not FileMaker. The minted `V-` id IS the record id and the
    // value of _kpt__Inspection_ID, so there is no read-back to discover the
    // key — the two-step dance the FileMaker create needed is gone, along with
    // its requirement for a per-user FileMaker session.
    const made = await createVibeRecord(LAYOUT, payload);
    const newId = made?.recordId;
    if (!newId) throw new Error('Could not create the record');

    const rec = { recordId: newId, fieldData: made.fieldData, portalData: {} };

    if (source && sourceInspectionId) {
      const copied = await copyLines(sourceInspectionId, newId);
      if (copied.length) {
        await markCarriedLines(newId, copied.map(l => String(l.recordId))).catch(() => {});
      }
    }
    copySourceRef.current = null;

    addCachedRecord(LAYOUT, CACHE_VERSION, rec);
    handleSelect(rec);
    onRecordSelect?.(rec.recordId, rec.fieldData?.Organization || rec.fieldData?.['inspt_CNTCT__site::Name_Organization']);
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

  // Re-read the lines after writing, so the on-screen rows carry the real ids
  // the server assigned (needed for any subsequent edit or delete).
  const refreshLines = useCallback(async () => {
    const recordId = selected?.recordId;
    const inspectionId = selected?.fieldData?._kpt__Inspection_ID;
    if (!recordId || !inspectionId) return;
    const rows = await listLines(inspectionId);
    if (selectedRef.current === recordId) setLines(rows);
  }, [selected?.recordId, selected?.fieldData?._kpt__Inspection_ID]);

  async function handleSave() {
    const lineChanges = Object.keys(lineEdits).length + newLines.length + deletedIds.size;
    if (!Object.keys(edits).length && !lineChanges) { return; }
    setSaving(true); setSaveStatus(null); setSaveErrorMsg(null);
    try {
      // Line items first — they're the risky part. If they fail we surface the
      // error before touching the parent, rather than half-saving.
      if (lineChanges) {
        // Keyed on the inspection's own id, not FileMaker's recordId — see the
        // import comment. Passing recordId here would write under a key that
        // looks valid and belongs to nothing.
        const inspectionId = selected.fieldData?._kpt__Inspection_ID;
        if (!inspectionId) throw new Error('This inspection has no ID yet, so its lines cannot be saved.');
        for (const id of deletedIds) await deleteLine(inspectionId, id);
        for (const [id, changes] of Object.entries(lineEdits)) {
          if (deletedIds.has(String(id))) continue;   // deleted wins over edited
          await updateLine(inspectionId, id, changes);
        }
        const toAdd = newLines.filter(l => (l.Description || '').trim() || l.Quantity || l.Equipment || l.Element_Grade);
        if (toAdd.length) await addLines(inspectionId, toAdd);

        // Persist the cleared carried-over flags for the lines just edited.
        for (const id of Object.keys(lineEdits)) clearCarriedLine(selected.recordId, id).catch(() => {});
        for (const id of deletedIds) clearCarriedLine(selected.recordId, id).catch(() => {});

        await refreshLines();
        resetLineState();
      }
      // Inspections_New is Vibe-owned (api/_vibeStore.js), so the record's own
      // fields no longer go back to FileMaker. Line items still do — they are a
      // portal, and the fragment model covers fieldData only. Until they move,
      // an inspection's fields live in Vibe and its findings in FileMaker.
      if (Object.keys(edits).length) await updateVibeRecord(LAYOUT, selected.recordId, edits);
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

  const f = selected?.fieldData;

  // What the editor renders: saved rows with any staged edits applied and
  // deletions marked, followed by rows added this session. `lines` are already
  // in UI shape (listLines maps them through toLine), so there is nothing to
  // convert here any more.
  const workingLines = [
    ...lines.map(line => {
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

      <div className="insp-resize-handle" onPointerDown={startPanelResize} />

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
                <button className="h5-btn h5-btn--quiet h5-btn--sm" onClick={() => setRemindOpen(true)}>⏰ Remind</button>
                <DeleteRecordButton
                  layout={LAYOUT} cacheVersion={CACHE_VERSION}
                  recordId={selected.recordId}
                  name={f.Organization || f['inspt_CNTCT__site::Name_Organization']}
                  onDeleted={() => setSelected(null)}
                />
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
                {/* Lines are fetched separately now, so there is a moment where
                    the record is on screen and they are not. Saying so beats
                    rendering an empty findings list on a full inspection. */}
                {linesLoading && !workingLines.length && (
                  <p className="insp-lines-loading">Loading line items…</p>
                )}
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
                parentLabel={f.Organization || f['inspt_CNTCT__site::Name_Organization']}
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

              <RecordFooter id={f._kpt__Inspection_ID} recordId={selected.recordId} fieldData={f} />
              <RecordSaveBar count={dirtyCount} saving={saving} status={saveStatus} errorMessage={saveErrorMsg} onSave={handleSave} onDiscard={handleDiscard} />
            </div>
          </>
        )}
      </main>

      {remindOpen && selected && (
        <ReminderModal
          initial={{
            // The FileMaker recordId, which is what this module's navTarget
            // resolves and what RECORD_SOURCES looks a record up by. Contacts
            // are the exception (they key on the contact id) because their
            // FileMaker table is being retired; these layouts are not.
            recordType: 'inspections',
            recordId: String(selected.recordId),
            recordLabel: f.Organization || f['inspt_CNTCT__site::Name_Organization'] || 'inspection',
            title: `Follow up on ${f.Organization || f['inspt_CNTCT__site::Name_Organization'] || 'inspection'}`,
          }}
          onClose={() => setRemindOpen(false)}
          onSaved={() => setRemindOpen(false)} />
      )}

      {showNew && (
        <RecordFormModal
          title="New Inspection"
          fields={createFields}
          submitLabel="Create inspection"
          onCreate={handleCreate}
          onClose={() => { copySourceRef.current = null; setCopySource(''); setShowNew(false); }}
        >
          {values => {
            if (!values._kft__Contact_ID) return null;
            const prior = priorInspections(values._kft__Contact_ID, values.Organization);
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
