import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getRecord, prefetchRecord, updateRecord } from '../api/filemaker';
import { useAllRecords } from '../hooks/useAllRecords';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import './Contacts.css';

const LAYOUT = 'Contacts_New';

const STATUS_COLOR = {
  Active: '#22c55e',
  Inactive: '#64748b',
  Prospect: '#e87722',
  default: '#64748b',
};

const TYPE_OPTIONS   = ['Individual', 'Organization', 'Vendor', 'Staff'];
const STATUS_OPTIONS = ['Active', 'Inactive', 'Prospect'];

const FIELD_LABELS = {
  Name_Organization: 'Name / Organization', Type: 'Type', Status: 'Status',
  Industry: 'Industry', Department: 'Department', Source: 'Source',
  Spouse: 'Spouse', Birthdate: 'Birthdate',
  Client_Alert: 'Client alert', Keywords: 'Keywords', Notes: 'Notes',
};

const ABOUT_FIELDS = ['Name_Organization', 'Type', 'Status', 'Industry', 'Department', 'Source', 'Spouse', 'Birthdate'];
const NOTE_FIELDS  = ['Client_Alert', 'Keywords', 'Notes'];

// FileMaker portal occurrence names, keyed by our logical id.
const PORTAL_KEY = {
  phone: 'cntct_PHONE', email: 'cntct_INADR', address: 'cntct_ADDR',
  related: 'Portal__Contacts', inspections: 'Portal__Opportunities',
  custom_training: 'Portal__Estimates', oe_training: 'Portal__Orders',
  ccs: 'Portal__Orders 2', certifications: 'Portal__Projects',
  estimates: 'Portal__Estimates 2', invoices: 'Portal__Invoices', rmi: 'Portal__Estimates 3',
};
const rowsOf = (p, id) => (p && p[PORTAL_KEY[id]]) || [];

const PORTAL_LABEL = {
  related: 'Related contacts', inspections: 'Inspections', custom_training: 'Custom training',
  oe_training: 'OE training', ccs: 'CCS projects', certifications: 'Certifications',
  estimates: 'Estimates', invoices: 'Invoices', rmi: 'Risk items',
};

// Portals whose rows deep-link into another module. The portal row's `recordId`
// is the related record's id in its own base table, which matches the target
// module's layout. Only these two have a navigable destination module; other
// portals (training, certs, estimates, invoices, risk, related) have none.
const PORTAL_NAV = { inspections: 'inspections', ccs: 'projects', custom_training: 'trainings' };

const TABS = [
  { id: 'overview',    label: 'Overview' },
  { id: 'engagements', label: 'Engagements', portals: ['inspections', 'custom_training', 'oe_training', 'ccs', 'certifications'] },
  { id: 'financials',  label: 'Financials',  portals: ['estimates', 'invoices'] },
  { id: 'risk',        label: 'Risk',        portals: ['rmi'] },
  { id: 'related',     label: 'Related',     portals: ['related'] },
  { id: 'notes',       label: 'Notes' },
];

const money = v => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
const num = v => Number(v || 0);

const parseFmDate = v => {
  if (!v) return 0;
  const [date, time = '00:00:00'] = String(v).split(' ');
  const [m, d, y] = date.split('/');
  return new Date(`${y}-${m}-${d}T${time}`).getTime();
};

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Merge dated rows from several portals into one recent-first activity feed.
function buildActivity(p) {
  const items = [];
  rowsOf(p, 'inspections').forEach(r => items.push({ icon: '⚑', date: r['cntct_INSPT::Date'], title: 'Inspection', sub: r['cntct_INSPT::Inspectors Name'] }));
  rowsOf(p, 'invoices').forEach(r => items.push({ icon: '$', date: r['cntct_INVO::Date'], title: `Invoice #${r['cntct_INVO::QuickBooks_Reference_Number'] || '—'}`, sub: money(r['cntct_INVO::zz__Total__xn']) }));
  rowsOf(p, 'estimates').forEach(r => items.push({ icon: '≡', date: r['cntct_ESTMT::Date'], title: r['cntct_ESTMT::Title'] || `Estimate ${r['cntct_ESTMT::_kpt__Estimate_ID']}`, sub: money(r['cntct_ESTMT::zz__Total__xn']) }));
  rowsOf(p, 'ccs').forEach(r => items.push({ icon: '◈', date: r['cntct_RCD::rcd start date'], title: `CCS project · ${r['cntct_RCD::Status'] || '—'}`, sub: `RCD #${r['cntct_RCD::_kpt__RCD_ID']}` }));
  rowsOf(p, 'rmi').forEach(r => items.push({ icon: '⚠', date: r['cntct_RMI::Entry_Date'], title: `Risk — ${r['cntct_RMI::Level_of_Risk'] || '—'}`, sub: r['cntct_RMI::Status'] }));
  return items
    .filter(i => i.date)
    .map(i => ({ ...i, ts: parseFmDate(i.date) }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 12);
}

function FieldValue({ fieldKey, value, onChange, editing }) {
  const ch = v => onChange(fieldKey, v);
  if (!editing) {
    if (fieldKey === 'Notes') return <div className="ct-notes-display">{value || '—'}</div>;
    return <span className="ct-value">{value || '—'}</span>;
  }
  if (fieldKey === 'Type') return <select className="ct-input" value={value || ''} onChange={e => ch(e.target.value)}><option value="">—</option>{TYPE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}</select>;
  if (fieldKey === 'Status') return <select className="ct-input" value={value || ''} onChange={e => ch(e.target.value)}><option value="">—</option>{STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}</select>;
  if (fieldKey === 'Notes') return <textarea className="ct-textarea" rows={5} value={value || ''} onChange={e => ch(e.target.value)} />;
  return <input className="ct-input" value={value || ''} onChange={e => ch(e.target.value)} />;
}

// Read-only table for a portal occurrence. When `onOpenRow` is provided, rows
// are clickable and deep-link into the related record's module.
function PortalTable({ id, rows, onOpenRow }) {
  const linkProps = r => (onOpenRow && r.recordId)
    ? { className: 'ct-row-link', onClick: () => onOpenRow(r.recordId), title: 'Open record' }
    : {};
  if (id === 'related') return (
    <table className="ct-table"><thead><tr><th>Name</th><th>Phone</th><th>Email</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}><td>{r['cntct_RLTN::zz__Display__ct']}</td><td className="mono">{r['cntct_rltn_cntct_PHONE::Number']}</td><td>{r['cntct_rltn_cntct_INADR__email::Address']}</td></tr>)}</tbody></table>
  );
  if (id === 'inspections') return (
    <table className="ct-table"><thead><tr><th>Date</th><th>Organization</th><th>Contact</th><th>Inspector</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} {...linkProps(r)}><td>{r['cntct_INSPT::Date']}</td><td>{r['cntct_INSPT::zz__Display_Organization__ct']}</td><td>{r['cntct_INSPT::zz__Display_Contact__ct']}</td><td>{r['cntct_INSPT::Inspectors Name']}</td></tr>)}</tbody></table>
  );
  if (id === 'custom_training') return (
    <table className="ct-table"><thead><tr><th>Organization</th><th>Contact</th><th>Type</th><th>Start</th><th>Status</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} {...linkProps(r)}><td>{r['cntct_TRNPP::zz__Display_Organization__ct']}</td><td>{r['cntct_TRNPP::zz__Display_Contact__ct']}</td><td>{r['cntct_TRNPP::Type of Program']}</td><td>{r['cntct_TRNPP::Start Date']}</td><td>{r['cntct_TRNPP::Status']}</td></tr>)}</tbody></table>
  );
  if (id === 'oe_training') return (
    <table className="ct-table"><thead><tr><th>Course #</th><th>Course Name</th><th>Organization</th><th>Start</th><th>End</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}><td className="mono">{r['cntct_WKSRG::Course Number']}</td><td>{r['cntct_WKSRG::Course Name']}</td><td>{r['cntct_WKSRG::zz__Display_Organization__ct']}</td><td>{r['cntct_WKSRG::Start Date']}</td><td>{r['cntct_WKSRG::End Date']}</td></tr>)}</tbody></table>
  );
  if (id === 'ccs') return (
    <table className="ct-table"><thead><tr><th>ID</th><th>Status</th><th>Organization</th><th>Type</th><th>Start</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} {...linkProps(r)}><td className="mono">{r['cntct_RCD::_kpt__RCD_ID']}</td><td>{r['cntct_RCD::Status']}</td><td>{r['cntct_RCD::zz__Display_Organization__ct']}</td><td>{r['cntct_RCD::zz__TypeOfProjectList__ct']}</td><td>{r['cntct_RCD::rcd start date']}</td></tr>)}</tbody></table>
  );
  if (id === 'certifications') return (
    <table className="ct-table"><thead><tr><th>Certificate dates</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}><td>{r['cntct_CTFC::CertificateDates']}</td></tr>)}</tbody></table>
  );
  if (id === 'estimates') return (
    <table className="ct-table"><thead><tr><th>ID</th><th>Date</th><th>Title</th><th className="num">Total</th><th>Status</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}><td className="mono">{r['cntct_ESTMT::_kpt__Estimate_ID']}</td><td>{r['cntct_ESTMT::Date']}</td><td>{r['cntct_ESTMT::Title']}</td><td className="num">{money(r['cntct_ESTMT::zz__Total__xn'])}</td><td>{r['cntct_ESTMT::Status']}</td></tr>)}</tbody></table>
  );
  if (id === 'invoices') return (
    <table className="ct-table"><thead><tr><th>QB Ref</th><th>Date</th><th className="num">Total</th><th className="num">Balance</th><th>Memo</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}><td className="mono">{r['cntct_INVO::QuickBooks_Reference_Number']}</td><td>{r['cntct_INVO::Date']}</td><td className="num">{money(r['cntct_INVO::zz__Total__xn'])}</td><td className="num" style={{ color: num(r['cntct_INVO::zz__Balance_Due__xs']) > 0 ? '#e8322a' : 'inherit' }}>{money(r['cntct_INVO::zz__Balance_Due__xs'])}</td><td>{r['cntct_INVO::Memo']}</td></tr>)}</tbody></table>
  );
  if (id === 'rmi') return (
    <table className="ct-table"><thead><tr><th>Entry date</th><th>Risk</th><th>Concern</th><th>Assigned</th><th>Status</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}><td>{r['cntct_RMI::Entry_Date']}</td><td>{r['cntct_RMI::Level_of_Risk']}</td><td>{r['cntct_RMI::Level_of_Concern']}</td><td>{r['cntct_RMI::Assigned_To']}</td><td>{r['cntct_RMI::Status']}</td></tr>)}</tbody></table>
  );
  return null;
}

export default function Contacts({ navTarget, onClearNav, onNavigateTo } = {}) {
  const { records, total } = useAllRecords(LAYOUT, { cacheVersion: 2 });
  const [selected, setSelected] = useState(null);
  const [navWidth, setNavWidth] = useState(280);
  const [tooltip, setTooltip] = useState(null);
  const [dataEditing, setDataEditing] = useState(false);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [tab, setTab] = useState('overview');
  const isResizing = useRef(false);

  const list = useListControls({
    records,
    storageKey: 'ct_sort',
    name: f => f.zz__Display__ct || '',
    searchKeys: ['zz__Display__ct', 'cntct_ADDR::zz__Display_Single_Line__ct', 'Type', 'Status'],
    chips: [
      { id: 'all', label: 'All' },
      { id: 'active', label: 'Active', color: STATUS_COLOR.Active, match: f => f.Status === 'Active' },
      { id: 'inactive', label: 'Inactive', color: STATUS_COLOR.Inactive, match: f => f.Status === 'Inactive' },
      { id: 'prospect', label: 'Prospect', color: STATUS_COLOR.Prospect, match: f => f.Status === 'Prospect' },
    ],
    sorts: [
      { id: 'alpha', label: 'Name', alpha: true, value: f => (f.zz__Display__ct || '').trim().toLowerCase() || '￿' },
      { id: 'created', label: 'Created', value: f => parseFmDate(f.zz__Created_On) },
      { id: 'modified', label: 'Modified', value: f => parseFmDate(f.zz__Modified_On) },
    ],
    defaultSort: 'created', defaultOrder: 'desc',
  });

  async function handleSelect(r) {
    setEdits({}); setDataEditing(false); setSaveStatus(null); setTab('overview');
    setSelected(r);
    getRecord(LAYOUT, r.recordId).then(detail => {
      setSelected(prev => prev?.recordId === r.recordId ? detail.response.data[0] : prev);
    }).catch(() => {});
  }

  useEffect(() => {
    if (navTarget?.moduleId !== 'contacts' || !navTarget.recordId) return;
    const rec = records.find(r => String(r.recordId) === String(navTarget.recordId));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deep-link selection
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
      const detail = await getRecord(LAYOUT, selected.recordId);
      setSelected(detail.response.data[0]);
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
      setNavWidth(Math.min(500, Math.max(180, startW + (e.clientX - startX))));
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
  const dirtyCount = Object.keys(edits).length;
  const val = fk => (fk in edits ? edits[fk] : f?.[fk]);

  const metrics = useMemo(() => {
    const inv = rowsOf(p, 'invoices');
    return {
      inspections: rowsOf(p, 'inspections').length,
      ccs: rowsOf(p, 'ccs').length,
      invoices: inv.length,
      openBalance: inv.reduce((s, r) => s + num(r['cntct_INVO::zz__Balance_Due__xs']), 0),
      estimates: rowsOf(p, 'estimates').length,
    };
  }, [p]);

  const activity = useMemo(() => buildActivity(p), [p]);
  const tabCount = t => (t.portals || []).reduce((s, id) => s + rowsOf(p, id).length, 0);

  const phone0 = rowsOf(p, 'phone')[0];
  const email0 = rowsOf(p, 'email')[0];
  const addr0 = rowsOf(p, 'address')[0];

  return (
    <div className="ct-container">
      <aside className="ct-sidebar" style={{ width: navWidth }}>
        <div className="ct-sidebar-header">
          <div className="ct-sidebar-title">
            <div>
              <div className="ct-sidebar-module">Contacts</div>
              <div className="ct-sidebar-count">{total ? `${total.toLocaleString()} contacts` : 'Loading…'}</div>
            </div>
          </div>
          <ListToolbar c={list} unit="contacts" />
        </div>

        {records.length === 0 ? (
          <div className="ct-loading">{[...Array(8)].map((_, i) => <div key={i} className="ct-skeleton" />)}</div>
        ) : (
          <div className="ct-list">
            <ListBody c={list} renderItem={r => {
              const color = STATUS_COLOR[r.fieldData.Status] || STATUS_COLOR.default;
              return (
                <div key={r.recordId}
                  className={`ct-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                  onClick={() => handleSelect(r)}
                  onMouseEnter={e => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTooltip({ r, x: rect.right + 8, y: rect.top });
                    prefetchRecord(LAYOUT, r.recordId);
                  }}
                  onMouseLeave={() => setTooltip(null)}
                >
                  <span className="ct-item-dot" style={{ background: color }} />
                  <div className="ct-item-text">
                    <div className="ct-item-name">{r.fieldData.zz__Display__ct || '—'}</div>
                    <div className="ct-item-sub">{r.fieldData['cntct_ADDR::zz__Display_Single_Line_No_Zip__ct'] || r.fieldData.Type || ''}</div>
                  </div>
                </div>
              );
            }} />
          </div>
        )}
      </aside>

      <div className="ct-resize-handle" onMouseDown={startResize} />

      {tooltip && (
        <div className="ct-hover-tooltip" style={{ top: tooltip.y, left: tooltip.x }}>
          {tooltip.r.fieldData['Name_Organization'] && (
            <div className="ct-ht-row"><span className="ct-ht-label">Org</span><span className="ct-ht-value">{tooltip.r.fieldData['Name_Organization']}</span></div>
          )}
          {tooltip.r.fieldData['cntct_ADDR::Type'] && (
            <div className="ct-ht-row"><span className="ct-ht-label">Addr Type</span><span className="ct-ht-value">{tooltip.r.fieldData['cntct_ADDR::Type']}</span></div>
          )}
        </div>
      )}

      <main className="ct-main">
        {!selected && (
          <div className="ct-empty-state">
            <div className="ct-empty-icon">◈</div>
            <p>Select a contact</p>
          </div>
        )}

        {selected && f && (
          <div className="ct-profile">
            {/* ── Hero ── */}
            <div className="ct-hero">
              <div className="ct-avatar">{initialsOf(f.zz__Display__ct)}</div>
              <div className="ct-hero-main">
                <div className="ct-hero-titlerow">
                  <h1 className="ct-hero-name">{f.zz__Display__ct || '—'}</h1>
                  {f.Status && (
                    <span className="ct-chip status" style={{ background: (STATUS_COLOR[f.Status] || '#64748b') + '22', color: STATUS_COLOR[f.Status] || '#64748b', borderColor: (STATUS_COLOR[f.Status] || '#64748b') + '44' }}>{f.Status}</span>
                  )}
                  {f.Type && <span className="ct-chip type">{f.Type}</span>}
                  {f.Industry && <span className="ct-chip muted">{f.Industry}</span>}
                </div>
                <div className="ct-hero-chips">
                  {phone0?.['cntct_PHONE::Number'] && <span className="ct-qchip"><span className="ct-qchip-i">✆</span>{phone0['cntct_PHONE::Number']}</span>}
                  {email0?.['cntct_INADR::Address'] && <a className="ct-qchip" href={`mailto:${email0['cntct_INADR::Address']}`}><span className="ct-qchip-i">✉</span>{email0['cntct_INADR::Address']}</a>}
                  {addr0 && (addr0['cntct_ADDR::City'] || addr0['cntct_ADDR::State']) && <span className="ct-qchip"><span className="ct-qchip-i">◎</span>{[addr0['cntct_ADDR::City'], addr0['cntct_ADDR::State']].filter(Boolean).join(', ')}</span>}
                </div>
              </div>
              <div className="ct-hero-actions">
                {saveStatus === 'saved' && <span className="ct-status saved">✓ Saved</span>}
                {saveStatus === 'error' && <span className="ct-status error">✗ Failed</span>}
                {!dataEditing ? (
                  <button className="ct-btn-edit" onClick={() => setDataEditing(true)}>✎ Edit</button>
                ) : (
                  <>
                    <button className="ct-btn-discard" onClick={handleDiscard} disabled={saving}>Discard</button>
                    <button className="ct-btn-save" onClick={handleSave} disabled={saving || dirtyCount === 0}>
                      {saving ? 'Saving…' : dirtyCount ? `Save ${dirtyCount} change${dirtyCount > 1 ? 's' : ''}` : 'Save'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* ── Metrics ── */}
            <div className="ct-metrics">
              <div className="ct-metric"><div className="ct-metric-v">{metrics.inspections}</div><div className="ct-metric-l">Inspections</div></div>
              <div className="ct-metric"><div className="ct-metric-v">{metrics.ccs}</div><div className="ct-metric-l">CCS projects</div></div>
              <div className="ct-metric"><div className="ct-metric-v">{metrics.invoices}</div><div className="ct-metric-l">Invoices</div></div>
              <div className="ct-metric"><div className="ct-metric-v" style={{ color: metrics.openBalance > 0 ? '#e8322a' : undefined }}>{money(metrics.openBalance)}</div><div className="ct-metric-l">Open balance</div></div>
              <div className="ct-metric"><div className="ct-metric-v">{metrics.estimates}</div><div className="ct-metric-l">Estimates</div></div>
            </div>

            {/* ── Body: rail + tabs ── */}
            <div className="ct-body">
              <div className="ct-rail">
                <div className="ct-card">
                  <div className="ct-card-title">About</div>
                  {ABOUT_FIELDS.map(fk => (
                    <div className="ct-kv" key={fk}>
                      <span className="ct-kv-k">{FIELD_LABELS[fk] || fk}</span>
                      <span className="ct-kv-v"><FieldValue fieldKey={fk} value={val(fk)} onChange={handleFieldChange} editing={dataEditing} /></span>
                    </div>
                  ))}
                  {f._kaf__qbo_id && (
                    <div className="ct-kv"><span className="ct-kv-k">QuickBooks id</span><span className="ct-kv-v mono">{f._kaf__qbo_id}</span></div>
                  )}
                </div>

                {(rowsOf(p, 'phone').length > 0 || rowsOf(p, 'email').length > 0 || rowsOf(p, 'address').length > 0) && (
                  <div className="ct-card">
                    <div className="ct-card-title">Contact</div>
                    {rowsOf(p, 'phone').map((r, i) => <div className="ct-kv" key={'p' + i}><span className="ct-kv-k">{r['cntct_PHONE::Type'] || 'Phone'}</span><span className="ct-kv-v mono">{r['cntct_PHONE::Number']}</span></div>)}
                    {rowsOf(p, 'email').map((r, i) => <div className="ct-kv" key={'e' + i}><span className="ct-kv-k">{r['cntct_INADR::Type'] || 'Email'}</span><a className="ct-kv-v link" href={`mailto:${r['cntct_INADR::Address']}`}>{r['cntct_INADR::Address']}</a></div>)}
                    {rowsOf(p, 'address').map((r, i) => (
                      <div className="ct-kv" key={'a' + i}><span className="ct-kv-k">{r['cntct_ADDR::Type'] || 'Address'}</span>
                        <span className="ct-kv-v">{[r['cntct_ADDR::Street'], [r['cntct_ADDR::City'], r['cntct_ADDR::State']].filter(Boolean).join(', '), r['cntct_ADDR::Zip']].filter(Boolean).join(' · ')}</span></div>
                    ))}
                  </div>
                )}

                {val('Client_Alert') && (
                  <div className="ct-alert"><span className="ct-alert-i">⚠</span><span>{val('Client_Alert')}</span></div>
                )}
              </div>

              <div className="ct-panes">
                <div className="ct-tabs">
                  {TABS.map(t => {
                    const c = t.portals ? tabCount(t) : 0;
                    return (
                      <button key={t.id} className={`ct-tab${tab === t.id ? ' on' : ''}`} onClick={() => setTab(t.id)}>
                        {t.label}{t.portals && c > 0 && <span className="ct-tab-count">{c}</span>}
                      </button>
                    );
                  })}
                </div>

                <div className="ct-pane">
                  {tab === 'overview' && (
                    activity.length === 0
                      ? <p className="ct-empty-portal">No recent activity</p>
                      : <div className="ct-acts">
                          {activity.map((a, i) => (
                            <div className="ct-act" key={i}>
                              <span className="ct-act-i">{a.icon}</span>
                              <div className="ct-act-main"><span className="ct-act-title">{a.title}</span>{a.sub && <span className="ct-act-sub">{a.sub}</span>}</div>
                              <span className="ct-act-date">{String(a.date).split(' ')[0]}</span>
                            </div>
                          ))}
                        </div>
                  )}

                  {tab === 'notes' && (
                    <div className="ct-notes">
                      {NOTE_FIELDS.map(fk => (
                        <div className="ct-note-block" key={fk}>
                          <div className="ct-card-title">{FIELD_LABELS[fk]}</div>
                          <FieldValue fieldKey={fk} value={val(fk)} onChange={handleFieldChange} editing={dataEditing} />
                        </div>
                      ))}
                    </div>
                  )}

                  {TABS.filter(t => t.portals).map(t => {
                    if (tab !== t.id) return null;
                    const groups = t.portals.filter(id => rowsOf(p, id).length > 0);
                    if (groups.length === 0) return <p className="ct-empty-portal" key={t.id}>No records</p>;
                    return groups.map(id => {
                      const targetModule = PORTAL_NAV[id];
                      const onOpenRow = targetModule ? (recordId) => onNavigateTo?.(targetModule, recordId) : null;
                      return (
                        <div className="ct-portal-group" key={id}>
                          <div className="ct-portal-h">{PORTAL_LABEL[id]} <span className="ct-portal-n">{rowsOf(p, id).length}</span></div>
                          <div className="ct-table-wrap"><PortalTable id={id} rows={rowsOf(p, id)} onOpenRow={onOpenRow} /></div>
                        </div>
                      );
                    });
                  })}
                </div>
              </div>
            </div>

            <div className="ct-record-footer">
              ID {f._kpt__Contact_ID} · Created {f.zz__Created_On?.split(' ')[0]} by {f.zz__Created_By} · Modified {f.zz__Modified_On?.split(' ')[0]} by {f.zz__Modified_By}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
