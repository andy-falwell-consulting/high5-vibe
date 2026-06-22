import { useState, useCallback, useRef, useEffect } from 'react';
import { getRecord, prefetchRecord, updateRecord, invalidateRecord, patchCachedRecord } from '../api/filemaker';
import { useAllRecords } from '../hooks/useAllRecords';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import { listAttachments, uploadAttachment, deleteAttachment, generateAndAttachReport, downloadReport, getFreshAttachmentUrl } from '../api/inspectionAttachments';
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

export default function Inspections({ navTarget, onClearNav, onRecordSelect } = {}) {
  const { records, total } = useAllRecords(LAYOUT, { cacheVersion: CACHE_VERSION });
  const [selected, setSelected] = useState(null);
  const [navWidth, setNavWidth] = useState(300);
  const [dataEditing, setDataEditing] = useState(false);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [attLoading, setAttLoading] = useState(false);
  const [attBusy, setAttBusy] = useState(null); // 'upload' | 'report-attach' | 'report-download' | recordId being deleted
  const [attStage, setAttStage] = useState(null); // progress label while a report runs
  const [attError, setAttError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const isResizing = useRef(false);
  const fileInputRef = useRef(null);

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

  async function handleSelect(r) {
    setEdits({}); setDataEditing(false); setSaveStatus(null);
    setSelected(r);
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

  // ── Attachments ──
  const inspId = selected?.fieldData?._kpt__Inspection_ID;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on inspection change
    setAttachments([]); setAttError(null);
    if (!inspId) return;
    let alive = true;
    setAttLoading(true);
    listAttachments(inspId)
      .then(a => { if (alive) setAttachments(a); })
      .catch(() => { if (alive) setAttError('Could not load attachments'); })
      .finally(() => { if (alive) setAttLoading(false); });
    return () => { alive = false; };
  }, [inspId]);

  async function handleFiles(files) {
    if (!inspId || !files?.length) return;
    setAttBusy('upload'); setAttError(null);
    try {
      // Prepend each uploaded file as it lands, so the grid fills in live.
      for (const file of files) {
        const card = await uploadAttachment(inspId, file);
        setAttachments(a => [card, ...a]);
      }
    } catch (e) { setAttError(e.message || 'Upload failed'); }
    finally { setAttBusy(null); }
  }
  // Open an attachment. The just-generated card holds an in-memory blob URL that
  // opens instantly; any other card re-fetches a fresh container URL at click
  // time so the file stays openable/downloadable forever (FMP URLs expire).
  async function handleOpenAttachment(a) {
    setAttError(null);
    if (a.url && a.url.startsWith('blob:')) { window.open(a.url, '_blank', 'noopener'); return; }
    const w = window.open('', '_blank'); // open synchronously to dodge popup blockers
    try {
      const fresh = await getFreshAttachmentUrl(a.recordId);
      if (!fresh) throw new Error('File is no longer available');
      const abs = fresh.startsWith('http') ? fresh : window.location.origin + fresh;
      if (w) w.location.href = abs; else window.open(abs, '_blank', 'noopener');
    } catch (e) {
      if (w) w.close();
      setAttError(e.message || 'Could not open file');
    }
  }
  async function handleDeleteAtt(recordId) {
    setAttBusy(recordId); setAttError(null);
    try { await deleteAttachment(recordId); setAttachments(a => a.filter(x => x.recordId !== recordId)); }
    catch (e) { setAttError(e.message || 'Delete failed'); }
    finally { setAttBusy(null); }
  }
  async function handleGenerateReport(attach) {
    if (!selected) return;
    setAttBusy(attach ? 'report-attach' : 'report-download');
    setAttStage('Building PDF…'); setAttError(null);
    try {
      if (attach) {
        const card = await generateAndAttachReport(selected, setAttStage);
        setAttachments(a => [card, ...a]); // optimistic — no re-list round-trip
      } else {
        await downloadReport(selected, setAttStage);
      }
    } catch (e) { setAttError(e.message || 'Report failed'); }
    finally { setAttBusy(null); setAttStage(null); }
  }

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
          <ListToolbar c={list} unit="inspections" />
        </div>

        {records.length === 0 ? (
          <div className="insp-loading">{[...Array(8)].map((_, i) => <div key={i} className="insp-skeleton" />)}</div>
        ) : (
          <div className="insp-list">
            <ListBody c={list} renderItem={r => {
              const color = STATUS_COLOR[statusOf(r.fieldData)] || STATUS_COLOR.default;
              return (
                <div key={r.recordId}
                  className={`insp-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                  onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId); }}
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

              <Section title="Attachments" icon="❏">
                <div className="insp-att-actions">
                  <button
                    className="insp-att-btn primary"
                    disabled={attBusy === 'report-attach' || attBusy === 'report-download'}
                    onClick={() => handleGenerateReport(true)}
                  >
                    {attBusy === 'report-attach' ? (attStage || 'Working…') : '＋ Generate report & attach'}
                  </button>
                  <button
                    className="insp-att-btn"
                    disabled={attBusy === 'report-attach' || attBusy === 'report-download'}
                    onClick={() => handleGenerateReport(false)}
                  >
                    {attBusy === 'report-download' ? (attStage || 'Working…') : '⤓ Download report'}
                  </button>
                  <button
                    className="insp-att-btn"
                    disabled={attBusy === 'upload'}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {attBusy === 'upload' ? 'Uploading…' : '⇪ Upload file'}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    onChange={e => { handleFiles([...e.target.files]); e.target.value = ''; }}
                  />
                </div>

                {attError && <p className="insp-att-error">{attError}</p>}

                <div
                  className={`insp-att-drop${dragOver ? ' over' : ''}`}
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles([...e.dataTransfer.files]); }}
                >
                  {attLoading ? (
                    <p className="insp-att-empty">Loading attachments…</p>
                  ) : attachments.length === 0 ? (
                    <p className="insp-att-empty">No attachments yet — drop files here, or use the buttons above.</p>
                  ) : (
                    <ul className="insp-att-grid">
                      {attachments.map(a => (
                        <li key={a.recordId} className="insp-att-card">
                          <a
                            className="insp-att-thumb"
                            href={a.url || undefined}
                            onClick={e => { e.preventDefault(); if (a.hasFile) handleOpenAttachment(a); }}
                            title={a.hasFile ? 'Open' : 'No file'}
                          >
                            {a.isImage && a.url
                              ? <img src={a.url} alt={a.name} />
                              : <span className="insp-att-ext">{(a.name.split('.').pop() || '?').toUpperCase()}</span>}
                          </a>
                          <div className="insp-att-meta">
                            <a className="insp-att-name" href={a.url || undefined} onClick={e => { e.preventDefault(); if (a.hasFile) handleOpenAttachment(a); }} title={a.name}>{a.name}</a>
                            <span className="insp-att-sub">{a.created ? a.created.split(' ')[0] : 'Just now'}{a.by ? ` · ${a.by}` : ''}</span>
                          </div>
                          <button
                            className="insp-att-del"
                            title="Delete attachment"
                            disabled={attBusy === a.recordId}
                            onClick={() => handleDeleteAtt(a.recordId)}
                          >
                            {attBusy === a.recordId ? '…' : '✕'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
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
