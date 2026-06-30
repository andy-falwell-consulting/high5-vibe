import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getRecord, prefetchRecord, updateRecord, createRecord, addCachedRecord, addPortalRow, invalidateRecord, deleteRecord, findInLayout } from '../api/filemaker';
import { useAllRecords } from '../hooks/useAllRecords';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import ContactPicker from './ContactPicker';
import RecordFormModal from './RecordFormModal';
import RecordSaveBar from './RecordSaveBar';
import ComposeEmail from './ComposeEmail';
import ReminderModal from './ReminderModal';
import { invoiceRowInfo } from './InvoicePane';
import './Contacts.css';

const LAYOUT = 'Contacts_New';
const CACHE_VERSION = 2;

const CONTACT_CREATE_FIELDS = [
  { key: 'Name_Organization', label: 'Name / Organization', type: 'text', required: true },
  { key: 'Organization', label: 'Type', type: 'select', options: [{ value: '1', label: 'Organization' }, { value: '0', label: 'Individual' }], default: '1' },
  { key: 'Status', label: 'Status', type: 'select', options: ['Active', 'Inactive', 'Prospect'], default: 'Active' },
  { key: 'Industry', label: 'Industry', type: 'text' },
  { key: 'Source', label: 'Source', type: 'text' },
  { key: 'Notes', label: 'Notes', type: 'textarea', wide: true },
];

// Add-a-contact-method modals. Field keys are the portal's qualified field names,
// so the form's output is exactly the row payload for addPortalRow.
const METHOD_CONFIG = {
  phone: {
    title: 'Add Phone', portal: 'cntct_PHONE',
    fields: [
      { key: 'cntct_PHONE::Type', label: 'Type', type: 'select', options: ['Work', 'Main Office', 'Fax', 'Camp', 'Winter'], default: 'Work' },
      { key: 'cntct_PHONE::Number', label: 'Number', type: 'text', required: true },
    ],
  },
  email: {
    title: 'Add Email / Website', portal: 'cntct_INADR',
    fields: [
      { key: 'cntct_INADR::Type', label: 'Type', type: 'select', options: ['Email', 'Web'], default: 'Email' },
      { key: 'cntct_INADR::Address', label: 'Email or URL', type: 'text', required: true },
    ],
  },
  address: {
    title: 'Add Address', portal: 'cntct_ADDR',
    fields: [
      { key: 'cntct_ADDR::Type', label: 'Type', type: 'select', options: ['Main', 'Course', 'Mailing', 'Billing', 'Work', 'Winter'], default: 'Main' },
      { key: 'cntct_ADDR::Street', label: 'Street', type: 'text', wide: true },
      { key: 'cntct_ADDR::City', label: 'City', type: 'text' },
      { key: 'cntct_ADDR::State', label: 'State', type: 'text' },
      { key: 'cntct_ADDR::Zip', label: 'Zip', type: 'text' },
      { key: 'cntct_ADDR::Country', label: 'Country', type: 'text' },
    ],
  },
};

const STATUS_COLOR = {
  Active: '#22c55e',
  Inactive: '#64748b',
  Prospect: '#e87722',
  default: '#64748b',
};

const STATUS_OPTIONS = ['Active', 'Inactive', 'Prospect'];

// In FileMaker the contact's kind is stored on the `Organization` flag (1 = it's
// an organization, blank/0 = an individual). The "Type" DDL in Belay reads/writes
// that flag rather than the legacy free-text `Type` field, which isn't used.
const typeLabel = fd => String(fd?.Organization) === '1' ? 'Organization' : 'Individual';

const FIELD_LABELS = {
  Name_Organization: 'Name / Organization', Organization: 'Type', Status: 'Status',
  Industry: 'Industry', Department: 'Department', Source: 'Source',
  Spouse: 'Spouse', Birthdate: 'Birthdate',
  Client_Alert: 'Client alert', Keywords: 'Keywords', Notes: 'Notes',
};

const ABOUT_FIELDS = ['Name_Organization', 'Organization', 'Status', 'Industry', 'Department', 'Source', 'Spouse', 'Birthdate'];
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
const PORTAL_NAV = { inspections: 'inspections', ccs: 'projects', custom_training: 'trainings', estimates: 'estimates', rmi: 'rmi', related: 'contacts' };

const TABS = [
  { id: 'overview',    label: 'Overview' },
  { id: 'engagements', label: 'Engagements', portals: ['inspections', 'custom_training', 'oe_training', 'ccs', 'certifications'] },
  { id: 'financials',  label: 'Invoices',    portals: ['estimates', 'invoices'] },
  { id: 'risk',        label: 'Risk',        portals: ['rmi'] },
  { id: 'related',     label: 'Related',     portals: ['related'] },
  { id: 'notes',       label: 'Notes' },
];

const money = v => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
const num = v => Number(v || 0);

// Invoices have no in-app record page, so "open" = view the QBO PDF. We fetch the
// PDF bytes from QBO (authenticated via the session cookie) and open them as a
// blob — avoids FileMaker container URLs, which 401 when hit directly by the
// browser. A tab is opened synchronously first so popup blockers don't eat it.
async function openInvoicePdf(docNumber) {
  if (!docNumber) return;
  const win = window.open('', '_blank');
  try {
    const resp = await fetch('/api/qbo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'invoice-pdf', docNumber, base64: true }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.base64) { win?.close(); window.alert('Could not load the invoice PDF.'); return; }
    const bytes = Uint8Array.from(atob(data.base64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    if (win) win.location = url; else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch { win?.close(); window.alert('Could not load the invoice PDF.'); }
}

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
  rowsOf(p, 'invoices').forEach(r => items.push({ icon: '$', date: r['cntct_INVO::Date'], title: `Invoice #${r['cntct_INVO::QuickBooks_Reference_Number'] || '—'}`, sub: money(invoiceRowInfo(r).total) }));
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
    if (fieldKey === 'Organization') return <span className="ct-value">{String(value) === '1' ? 'Organization' : 'Individual'}</span>;
    return <span className="ct-value">{value || '—'}</span>;
  }
  if (fieldKey === 'Organization') return <select className="ct-input" value={String(value) === '1' ? '1' : '0'} onChange={e => ch(e.target.value)}><option value="1">Organization</option><option value="0">Individual</option></select>;
  if (fieldKey === 'Status') return <select className="ct-input" value={value || ''} onChange={e => ch(e.target.value)}><option value="">—</option>{STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}</select>;
  if (fieldKey === 'Notes') return <textarea className="ct-textarea" rows={5} value={value || ''} onChange={e => ch(e.target.value)} />;
  return <input className="ct-input" value={value || ''} onChange={e => ch(e.target.value)} />;
}

// Read-only table for a portal occurrence. When `onOpenRow` is provided, rows
// are clickable and deep-link into the related record's module.
function PortalTable({ id, rows, onOpenRow, onRemove }) {
  const linkProps = r => (onOpenRow && r.recordId)
    ? { className: 'ct-row-link', onClick: () => onOpenRow(r), title: 'Open' }
    : {};
  if (id === 'related') return (
    <table className="ct-table"><thead><tr><th>Name</th><th>Phone</th><th>Email</th>{onRemove && <th aria-label="Unlink" />}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} {...linkProps(r)}><td>{r['cntct_rltn_CNTCT::zz__Display__ct'] || r['cntct_RLTN::zz__Display__ct']}</td><td className="mono">{r['cntct_rltn_cntct_PHONE::Number']}</td><td>{r['cntct_rltn_cntct_INADR__email::Address']}</td>{onRemove && <td className="num"><button className="ct-unlink" title="Unlink contact" onClick={(e) => { e.stopPropagation(); onRemove(r); }}>✕</button></td>}</tr>)}</tbody></table>
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
      <tbody>{rows.map((r, i) => <tr key={i} {...linkProps(r)}><td className="mono">{r['cntct_ESTMT::_kpt__Estimate_ID']}</td><td>{r['cntct_ESTMT::Date']}</td><td>{r['cntct_ESTMT::Title']}</td><td className="num">{money(r['cntct_ESTMT::zz__Total__xn'])}</td><td>{r['cntct_ESTMT::Status']}</td></tr>)}</tbody></table>
  );
  if (id === 'invoices') return (
    <table className="ct-table"><thead><tr><th>QB Ref</th><th>Date</th><th className="num">Total</th><th className="num">Balance</th><th>Status</th></tr></thead>
      <tbody>{[...rows].sort((a, b) => parseFmDate(b['cntct_INVO::Date']) - parseFmDate(a['cntct_INVO::Date'])).map((r, i) => {
        const info = invoiceRowInfo(r);
        return (
          <tr key={i} {...linkProps(r)}>
            <td className="mono">#{r['cntct_INVO::QuickBooks_Reference_Number'] || '—'}</td>
            <td>{r['cntct_INVO::Date']}</td>
            <td className="num">{money(info.total)}</td>
            <td className="num" style={{ color: info.balance > 0 ? '#e8322a' : 'inherit' }}>{money(info.balance)}</td>
            <td>{info.status}</td>
          </tr>
        );
      })}</tbody></table>
  );
  if (id === 'rmi') return (
    <table className="ct-table"><thead><tr><th>Entry date</th><th>Risk</th><th>Concern</th><th>Assigned</th><th>Status</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}><td>{r['cntct_RMI::Entry_Date']}</td><td>{r['cntct_RMI::Level_of_Risk']}</td><td>{r['cntct_RMI::Level_of_Concern']}</td><td>{r['cntct_RMI::Assigned_To']}</td><td>{r['cntct_RMI::Status']}</td></tr>)}</tbody></table>
  );
  return null;
}

export default function Contacts({ navTarget, onClearNav, onNavigateTo, onRecordSelect } = {}) {
  const { records, total } = useAllRecords(LAYOUT, { cacheVersion: 2 });
  const [selected, setSelected] = useState(null);
  const [navWidth, setNavWidth] = useState(280);
  const [tooltip, setTooltip] = useState(null);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [tab, setTab] = useState('overview');
  const [showNew, setShowNew] = useState(false);
  const [addMethod, setAddMethod] = useState(null); // 'phone' | 'email' | 'address'
  const [composeOpen, setComposeOpen] = useState(false);
  const [remindOpen, setRemindOpen] = useState(false);
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const isResizing = useRef(false);

  // Add a phone/email/address row to the selected contact, then refresh detail.
  async function handleAddMethod(rowData) {
    if (!selected?.fieldData?._kpt__Contact_ID) {
      throw new Error('This contact has no ID — it may be an empty record. Open a valid contact first.');
    }
    const cfg = METHOD_CONFIG[addMethod];
    const res = await addPortalRow(LAYOUT, selected.recordId, cfg.portal, rowData);
    if (res?.messages?.[0]?.code !== '0') throw new Error(res?.messages?.[0]?.message || 'Could not add');
    invalidateRecord(LAYOUT, selected.recordId);
    const d = await getRecord(LAYOUT, selected.recordId);
    const fresh = d?.response?.data?.[0];
    if (fresh) setSelected(fresh);
  }

  async function refreshSelected() {
    invalidateRecord(LAYOUT, selected.recordId);
    const d = await getRecord(LAYOUT, selected.recordId);
    const fresh = d?.response?.data?.[0];
    if (fresh) setSelected(fresh);
  }

  // Link an existing contact (reciprocal cntct_RLTN pair). "Sites" are org contacts;
  // linking a person to one adds them to that site's related-contacts list and vice versa.
  async function handleLinkContact(contact) {
    const A = selected?.fieldData?._kpt__Contact_ID;
    const B = contact?.fieldData?._kpt__Contact_ID;
    setShowLinkPicker(false);
    if (!A || !B || String(A) === String(B)) return;
    try {
      const existing = await findInLayout('Contact_rltn', [{ _kft__Contact_ID: `==${A}`, _kft__Contact_ID_Related: `==${B}` }], { limit: 1 });
      if (!existing?.response?.data?.length) {
        await createRecord('Contact_rltn', { _kft__Contact_ID: A, _kft__Contact_ID_Related: B });
        await createRecord('Contact_rltn', { _kft__Contact_ID: B, _kft__Contact_ID_Related: A });
      }
      await refreshSelected();
    } catch (e) { alert(`Could not link contact: ${e.message || e}`); }
  }

  // Remove a related-contact link — deletes both reciprocal cntct_RLTN records.
  async function handleUnlinkContact(row) {
    const A = selected?.fieldData?._kpt__Contact_ID;
    if (!row?.recordId) return;
    const name = row['cntct_rltn_CNTCT::zz__Display__ct'] || row['cntct_RLTN::zz__Display__ct'] || 'this contact';
    if (!window.confirm(`Unlink ${name}?`)) return;
    try {
      let B = null;
      try { const jr = await getRecord('Contact_rltn', row.recordId); B = jr?.response?.data?.[0]?.fieldData?._kft__Contact_ID_Related; } catch { /* ignore */ }
      await deleteRecord('Contact_rltn', row.recordId);                       // A → B
      if (A && B) {
        const mirror = await findInLayout('Contact_rltn', [{ _kft__Contact_ID: `==${B}`, _kft__Contact_ID_Related: `==${A}` }], { limit: 5 });
        for (const m of (mirror?.response?.data || [])) await deleteRecord('Contact_rltn', m.recordId);
      }
      await refreshSelected();
    } catch (e) { alert(`Could not unlink contact: ${e.message || e}`); }
  }

  async function handleCreate(fieldData) {
    const res = await createRecord(LAYOUT, fieldData);
    const newId = res?.response?.recordId;
    if (!newId) throw new Error(res?.messages?.[0]?.message || 'Could not create the contact');
    getRecord(LAYOUT, newId).then(d => {
      const rec = d?.response?.data?.[0];
      if (rec) { addCachedRecord(LAYOUT, CACHE_VERSION, rec); handleSelect(rec); onRecordSelect?.(rec.recordId, rec.fieldData?.zz__Display__ct); }
    }).catch(() => {});
  }

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
    setEdits({}); setSaveStatus(null); setTab('overview');
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
  const handleDiscard = () => { setEdits({}); setSaveStatus(null); };

  async function handleSave() {
    const dirtyCount = Object.keys(edits).length;
    if (!dirtyCount) return;
    setSaving(true); setSaveStatus(null);
    try {
      await updateRecord(LAYOUT, selected.recordId, edits);
      const detail = await getRecord(LAYOUT, selected.recordId);
      setSelected(detail.response.data[0]);
      setEdits({}); setSaveStatus('saved');
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
      openBalance: inv.reduce((s, r) => s + invoiceRowInfo(r).balance, 0),
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
            <button className="ct-new-btn" onClick={() => setShowNew(true)} title="New contact">＋ New</button>
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
                  onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId, r.fieldData?.zz__Display__ct); }}
                  onMouseEnter={e => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTooltip({ r, x: rect.right + 8, y: rect.top });
                    // prefetchRecord(LAYOUT, r.recordId);
                  }}
                  onMouseLeave={() => setTooltip(null)}
                >
                  <span className="ct-item-dot" style={{ background: color }} />
                  <div className="ct-item-text">
                    <div className="ct-item-name">{r.fieldData.zz__Display__ct || r.fieldData.Name_Organization || '—'}</div>
                    <div className="ct-item-sub">{r.fieldData['cntct_ADDR::zz__Display_Single_Line_No_Zip__ct'] || typeLabel(r.fieldData)}</div>
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
          <>
          <div className="ct-profile">
            {/* ── Hero ── */}
            <div className="ct-hero">
              <div className="ct-avatar">{initialsOf(f.zz__Display__ct || f.Name_Organization)}</div>
              <div className="ct-hero-main">
                <div className="ct-hero-titlerow">
                  <h1 className="ct-hero-name">{f.zz__Display__ct || f.Name_Organization || '—'}</h1>
                  {f.Status && (
                    <span className="ct-chip status" style={{ background: (STATUS_COLOR[f.Status] || '#64748b') + '22', color: STATUS_COLOR[f.Status] || '#64748b', borderColor: (STATUS_COLOR[f.Status] || '#64748b') + '44' }}>{f.Status}</span>
                  )}
                  {String(f.Organization) === '1' && <span className="ct-chip type">Organization</span>}
                  {f.Industry && <span className="ct-chip muted">{f.Industry}</span>}
                </div>
                <div className="ct-hero-chips">
                  {phone0?.['cntct_PHONE::Number'] && <span className="ct-qchip"><span className="ct-qchip-i">✆</span>{phone0['cntct_PHONE::Number']}</span>}
                  {email0?.['cntct_INADR::Address'] && <a className="ct-qchip" href={`mailto:${email0['cntct_INADR::Address']}`}><span className="ct-qchip-i">✉</span>{email0['cntct_INADR::Address']}</a>}
                  {addr0 && (addr0['cntct_ADDR::City'] || addr0['cntct_ADDR::State']) && <span className="ct-qchip"><span className="ct-qchip-i">◎</span>{[addr0['cntct_ADDR::City'], addr0['cntct_ADDR::State']].filter(Boolean).join(', ')}</span>}
                </div>
              </div>
              <div className="ct-hero-actions">
                <button className="ct-btn-email" onClick={() => setComposeOpen(true)}>✉ Email</button>
                <button className="ct-btn-email" onClick={() => setRemindOpen(true)}>⏰ Remind</button>
              </div>
            </div>

            {/* ── Metrics ── */}
            <div className="ct-metrics">
              <div className="ct-metric"><div className="ct-metric-v">{metrics.inspections}</div><div className="ct-metric-l">Inspections</div></div>
              <div className="ct-metric"><div className="ct-metric-v">{metrics.ccs}</div><div className="ct-metric-l">CCS projects</div></div>
              <div className="ct-metric"><div className="ct-metric-v">{metrics.invoices}</div><div className="ct-metric-l">Invoices</div></div>
              <div className="ct-metric"><div className="ct-metric-v" style={{ color: metrics.openBalance > 0 ? '#e8322a' : undefined }}>{money(metrics.openBalance)}</div><div className="ct-metric-l">Open balance</div></div>
            </div>


            {/* ── Body: rail + tabs ── */}
            <div className="ct-body">
              <div className="ct-rail">
                <div className="ct-card ct-card-fields">
                  <div className="ct-card-title">About</div>
                  {ABOUT_FIELDS.map(fk => (
                    <div className="ct-kv" key={fk}>
                      <span className="ct-kv-k">{FIELD_LABELS[fk] || fk}</span>
                      <span className="ct-kv-v"><FieldValue fieldKey={fk} value={val(fk)} onChange={handleFieldChange} editing={true} /></span>
                    </div>
                  ))}
                  {f._kaf__qbo_id && (
                    <div className="ct-kv"><span className="ct-kv-k">QuickBooks id</span><span className="ct-kv-v mono">{f._kaf__qbo_id}</span></div>
                  )}
                </div>

                <div className="ct-card">
                  <div className="ct-card-title">
                    Contact
                    <span className="ct-card-add">
                      <button onClick={() => setAddMethod('phone')} title="Add phone">＋ Phone</button>
                      <button onClick={() => setAddMethod('email')} title="Add email or website">＋ Email/Web</button>
                      <button onClick={() => setAddMethod('address')} title="Add address">＋ Address</button>
                    </span>
                  </div>
                  {rowsOf(p, 'phone').map((r, i) => <div className="ct-kv" key={'p' + i}><span className="ct-kv-k">{r['cntct_PHONE::Type'] || 'Phone'}</span><span className="ct-kv-v mono">{r['cntct_PHONE::Number']}</span></div>)}
                  {rowsOf(p, 'email').map((r, i) => <div className="ct-kv" key={'e' + i}><span className="ct-kv-k">{r['cntct_INADR::Type'] || 'Email'}</span><a className="ct-kv-v link" href={`mailto:${r['cntct_INADR::Address']}`}>{r['cntct_INADR::Address']}</a></div>)}
                  {rowsOf(p, 'address').map((r, i) => (
                    <div className="ct-kv" key={'a' + i}><span className="ct-kv-k">{r['cntct_ADDR::Type'] || 'Address'}</span>
                      <span className="ct-kv-v">{[r['cntct_ADDR::Street'], [r['cntct_ADDR::City'], r['cntct_ADDR::State']].filter(Boolean).join(', '), r['cntct_ADDR::Zip']].filter(Boolean).join(' · ')}</span></div>
                  ))}
                  {rowsOf(p, 'phone').length === 0 && rowsOf(p, 'email').length === 0 && rowsOf(p, 'address').length === 0 && (
                    <div className="ct-kv"><span className="ct-kv-v" style={{ color: '#64748b' }}>No contact methods yet</span></div>
                  )}
                </div>

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
                          <FieldValue fieldKey={fk} value={val(fk)} onChange={handleFieldChange} editing={true} />
                        </div>
                      ))}
                    </div>
                  )}

                  {TABS.filter(t => t.portals).map(t => {
                    if (tab !== t.id) return null;
                    const groups = t.portals.filter(id => rowsOf(p, id).length > 0);
                    return (
                      <div key={t.id}>
                        {t.id === 'related' && (
                          <div className="ct-related-actions">
                            <button onClick={() => setShowLinkPicker(true)}>+ Link contact</button>
                          </div>
                        )}
                        {groups.length === 0
                          ? <p className="ct-empty-portal">{t.id === 'related' ? 'No linked contacts yet — use “+ Link contact” to add one.' : 'No records'}</p>
                          : groups.map(id => {
                            const onOpenRow =
                              id === 'invoices'
                                ? (r) => openInvoicePdf(r['cntct_INVO::QuickBooks_Reference_Number'])
                                : PORTAL_NAV[id]
                                  ? (r) => onNavigateTo?.(PORTAL_NAV[id], r.recordId)
                                  : null;
                            return (
                              <div className="ct-portal-group" key={id}>
                                <div className="ct-portal-h">{PORTAL_LABEL[id]} <span className="ct-portal-n">{rowsOf(p, id).length}</span></div>
                                <div className="ct-table-wrap"><PortalTable id={id} rows={rowsOf(p, id)} onOpenRow={onOpenRow} onRemove={id === 'related' ? handleUnlinkContact : undefined} /></div>
                              </div>
                            );
                          })}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="ct-record-footer">
              ID {f._kpt__Contact_ID} · Record {selected.recordId} · Created {f.zz__Created_On?.split(' ')[0]} by {f.zz__Created_By} · Modified {f.zz__Modified_On?.split(' ')[0] || '—'} by {f.zz__Modified_By}
            </div>
          </div>
          <RecordSaveBar count={dirtyCount} saving={saving} status={saveStatus} onSave={handleSave} onDiscard={handleDiscard} />
          </>
        )}
      </main>

      {showNew && (
        <RecordFormModal
          title="New Contact"
          fields={CONTACT_CREATE_FIELDS}
          submitLabel="Create contact"
          onCreate={handleCreate}
          onClose={() => setShowNew(false)}
        />
      )}

      {addMethod && (
        <RecordFormModal
          title={METHOD_CONFIG[addMethod].title}
          fields={METHOD_CONFIG[addMethod].fields}
          submitLabel="Add"
          onCreate={handleAddMethod}
          onClose={() => setAddMethod(null)}
        />
      )}

      {composeOpen && selected && (
        <ComposeEmail
          initial={{
            to: email0?.['cntct_INADR::Address'] || '',
            subject: `High 5 Adventure — ${f?.zz__Display__ct || f?.Name_Organization || ''}`.trim(),
          }}
          onClose={() => setComposeOpen(false)}
        />
      )}

      {remindOpen && selected && (
        <ReminderModal
          initial={{
            recordType: 'contacts',
            recordId: String(selected.recordId),
            recordLabel: f?.zz__Display__ct || f?.Name_Organization || '',
            title: `Follow up with ${f?.zz__Display__ct || f?.Name_Organization || 'contact'}`,
          }}
          onClose={() => setRemindOpen(false)}
        />
      )}

      {showLinkPicker && selected && (
        <ContactPicker
          title={String(f?.Organization) === '1' ? 'Add a contact to this site' : 'Link a contact'}
          onSelect={handleLinkContact}
          onClose={() => setShowLinkPicker(false)}
        />
      )}
    </div>
  );
}
