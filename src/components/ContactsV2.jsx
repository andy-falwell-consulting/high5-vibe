import { useState, useEffect, useRef } from 'react';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import { BRAND, UI } from '../config/brandColors';
import {
  listPeople, listOrganizations, getContact, getOrganizationPeople,
  createPerson, createOrganization, updateContact,
  affiliate, setPrimary, unaffiliate, setParent,
  addMethod, updateMethod, removeMethod, deleteContact,
} from '../api/vibeContacts';
import './ContactsV2.css';

// Contacts, on Vibe's own model — organizations, people and affiliations as
// three separate things (docs/contacts-model.md).
//
// A NEW module rather than a rewrite of Contacts.jsx, following the CCS
// precedent where the Workspace lived alongside the List until it had earned
// the switch. The old module still reads FileMaker and is untouched, so nothing
// anyone relies on today moves until this has proven itself.
//
// The point of it: FileMaker keeps people and organizations in one table with a
// type flag and a single name field, which is how a person called Ryan Doak was
// filed as a company and then rendered blank everywhere. Here they are separate
// kinds, and a person has a first and last name.

// Status colours, matching the original Contacts module so a record reads the
// same in both. Brand tones rather than arbitrary ones — see config/brandColors.
const statusColor = status => ({
  Active: UI.success,
  Inactive: UI.neutral,
  Prospect: BRAND.gold,
}[status] || UI.neutral);

// What each kind exposes for editing. These lists must stay in step with
// PERSON_FIELDS / ORG_FIELDS in api/contacts-write.js, which rejects anything
// it does not own rather than storing it quietly.
const PERSON_FORM = [
  { key: 'first', label: 'First name' },
  { key: 'last', label: 'Last name' },
  { key: 'title', label: 'Title' },
  { key: 'status', label: 'Status' },
  { key: 'notes', label: 'Notes', textarea: true },
];
const ORG_FORM = [
  { key: 'name', label: 'Organization name' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'siteNumber', label: 'Site number' },
  { key: 'notes', label: 'Notes', textarea: true },
];

// Phones, emails and addresses.
//
// Type vocabularies are the values actually in the file, counted across all
// 36,663 rows — not the list the old Contacts module offers, which turned out
// to be missing Home and Mobile, the second and fourth most common phone types.
// Everything occurring 12+ times is here; rarer and plainly corrupt values
// ('MobiWorkle', a street address typed into the Type box) are left off the
// list but never rewritten — see MethodForm.
const METHOD_SPEC = {
  phone: {
    label: 'Phone', plural: 'Phones', field: 'phones',
    types: ['Work', 'Home', 'Fax', 'Mobile', 'Main Office', 'Personal Mobile',
      'Billing Fax', 'Mobile Parent', 'Camp', 'Winter', 'Work Parent'],
    fields: [{ key: 'number', label: 'Number' }],
    show: m => m.number,
    href: m => `tel:${String(m.number || '').replace(/[^\d+]/g, '')}`,
  },
  email: {
    label: 'Email or website', plural: 'Email & web', field: 'emails',
    types: ['Email', 'Web', 'Home Email', 'Business Web', 'Billing', 'Email Parent', 'Home Web'],
    fields: [{ key: 'address', label: 'Email or URL' }],
    show: m => m.address,
    href: m => (m.type === 'Web'
      ? (/^https?:\/\//i.test(m.address || '') ? m.address : `https://${m.address}`)
      : `mailto:${m.address}`),
  },
  address: {
    label: 'Address', plural: 'Addresses', field: 'addresses',
    types: ['Main', 'Home', 'Mailing', 'Billing', 'Course', 'Work', 'Winter', 'Camp'],
    fields: [
      { key: 'street', label: 'Street' }, { key: 'city', label: 'City' },
      { key: 'state', label: 'State' }, { key: 'zip', label: 'Zip' },
      { key: 'country', label: 'Country' },
    ],
    show: m => [m.street, [m.city, m.state].filter(Boolean).join(', '), m.zip, m.country]
      .map(s => String(s || '').trim()).filter(Boolean).join(' · '),
    href: null,
  },
};

// The original Contacts module groups everything into bordered cards with a
// red-accented icon and an uppercase title. Same component here so a record
// reads the same in both modules.
function Section({ icon, title, children, aside }) {
  return (
    <section className="c2-section">
      <div className="c2-section-header">
        <span className="c2-section-icon" aria-hidden="true">{icon}</span>
        <h3>{title}</h3>
        {aside}
      </div>
      <div className="c2-section-body">{children}</div>
    </section>
  );
}

function MethodForm({ kind, initial, busy, onSave, onCancel }) {
  const spec = METHOD_SPEC[kind];
  const [v, setV] = useState(() => ({
    type: initial?.type ?? '',
    ...Object.fromEntries(spec.fields.map(f => [f.key, initial?.[f.key] ?? ''])),
  }));
  const set = (k, x) => setV(p => ({ ...p, [k]: x }));
  // A migrated row can carry a type that is not on the list — 'Southern Course',
  // or a street address someone typed into the Type box. Offering it as an
  // option means opening the row to fix a typo doesn't silently rewrite the
  // type to whatever happened to be first. Blank is a real value too: 2,104
  // rows have no type at all.
  const types = v.type && !spec.types.includes(v.type)
    ? [v.type, ...spec.types]
    : spec.types;
  // Mirrors the server's rule: an address needs any one line, the others need
  // their single value. Checked here only to keep Save from being pressable —
  // the server is what actually enforces it.
  const valid = kind === 'address'
    ? spec.fields.some(f => String(v[f.key]).trim())
    : !!String(v[spec.fields[0].key]).trim();

  return (
    <div className="c2-methodform">
      <select className="c2-input c2-input--type" value={v.type} onChange={e => set('type', e.target.value)}>
        <option value="">(no type)</option>
        {types.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      {spec.fields.map((f, i) => (
        <input key={f.key} className="c2-input c2-input--inline" placeholder={f.label}
          autoFocus={i === 0} value={v[f.key]} onChange={e => set(f.key, e.target.value)} />
      ))}
      <button className="c2-btn c2-btn--primary" disabled={busy || !valid} onClick={() => onSave(v)}>Save</button>
      <button className="c2-btn" onClick={onCancel} disabled={busy}>Cancel</button>
    </div>
  );
}

function ContactMethods({ contact, busy, onAdd, onUpdate, onRemove }) {
  // { kind, id } — id null means "adding". One form open at a time, so a
  // half-typed address can't be lost behind another one.
  const [form, setForm] = useState(null);

  return (
    <div className="c2-methods">
      {Object.entries(METHOD_SPEC).map(([kind, spec]) => {
        const rows = contact[spec.field] || [];
        return (
          <div className="c2-methodgroup" key={kind}>
            <h3>{spec.plural}</h3>
            {rows.length === 0 && !(form?.kind === kind && !form.id) && (
              <p className="c2-none">None recorded.</p>
            )}
            <ul className="c2-methodlist">
              {rows.map(m => (form?.kind === kind && form.id === m.id ? (
                <li key={m.id} className="c2-methodrow c2-methodrow--editing">
                  <MethodForm kind={kind} initial={m} busy={busy}
                    onCancel={() => setForm(null)}
                    onSave={vals => { setForm(null); onUpdate(kind, m.id, vals); }} />
                </li>
              ) : (
                <li key={m.id} className="c2-methodrow">
                  <span className="c2-methodtype">{m.type || '—'}</span>
                  {spec.href
                    ? <a className="c2-methodvalue" href={spec.href(m)}>{spec.show(m)}</a>
                    : <span className="c2-methodvalue">{spec.show(m)}</span>}
                  <button className="c2-mini" disabled={busy}
                    onClick={() => setForm({ kind, id: m.id })}>edit</button>
                  <button className="c2-mini c2-mini--danger" disabled={busy}
                    onClick={() => onRemove(kind, m.id)}>remove</button>
                </li>
              )))}
            </ul>
            {form?.kind === kind && !form.id ? (
              <MethodForm kind={kind} busy={busy}
                onCancel={() => setForm(null)}
                onSave={vals => { setForm(null); onAdd(kind, vals); }} />
            ) : (
              <button className="c2-mini c2-mini--add" disabled={busy}
                onClick={() => setForm({ kind, id: null })}>+ {spec.label}</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Fields({ spec, values, onChange, autoFocusFirst }) {
  return spec.map((f, i) => (
    <label className="c2-lbl" key={f.key}>{f.label}
      {f.textarea
        ? <textarea className="c2-input c2-input--area" value={values[f.key] ?? ''}
            onChange={e => onChange(f.key, e.target.value)} rows={3} />
        : <input className="c2-input" autoFocus={autoFocusFirst && i === 0} value={values[f.key] ?? ''}
            onChange={e => onChange(f.key, e.target.value)} />}
    </label>
  ));
}

function CreateModal({ kind, onClose, onCreated }) {
  const [fields, setFields] = useState({ first: '', last: '', title: '', name: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setFields(p => ({ ...p, [k]: v }));

  const canSave = kind === 'person'
    ? !!(fields.first.trim() || fields.last.trim())
    : !!fields.name.trim();

  async function save() {
    setBusy(true); setError(null);
    try {
      const r = kind === 'person'
        ? await createPerson({ first: fields.first, last: fields.last, title: fields.title })
        : await createOrganization({ name: fields.name });
      onCreated(kind === 'person' ? r.person : r.organization);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="c2-overlay" onClick={onClose}>
      <div className="c2-modal" onClick={e => e.stopPropagation()}>
        <h2>{kind === 'person' ? 'New person' : 'New organization'}</h2>
        {kind === 'person' ? (
          <>
            {/* Two name fields, which is the entire point. */}
            <label className="c2-lbl">First name
              <input className="c2-input" autoFocus value={fields.first} onChange={e => set('first', e.target.value)} />
            </label>
            <label className="c2-lbl">Last name
              <input className="c2-input" value={fields.last} onChange={e => set('last', e.target.value)} />
            </label>
            <label className="c2-lbl">Title
              <input className="c2-input" value={fields.title} onChange={e => set('title', e.target.value)} />
            </label>
          </>
        ) : (
          <label className="c2-lbl">Organization name
            <input className="c2-input" autoFocus value={fields.name} onChange={e => set('name', e.target.value)} />
          </label>
        )}
        {error && <div className="c2-error">{error}</div>}
        <div className="c2-modal-actions">
          <button className="c2-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="c2-btn c2-btn--primary" onClick={save} disabled={busy || !canSave}>
            {busy ? 'Saving…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Editing an existing contact.
//
// Only what actually CHANGED is sent. Posting the whole form back would rewrite
// fields nobody touched with whatever this browser last read, which is how a
// stale tab quietly undoes someone else's edit.
// Typed confirmation, the same bar DeleteRecordButton sets for every other
// module: a contact can be referenced by projects, inspections and estimates
// through `_kft__Contact_ID`, and nothing here rewrites those. An OK button is
// too cheap for that.
function DeleteContact({ kind, entity, name, affiliations, busy, onDeleted }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);
  const armed = typed.trim().toUpperCase() === 'DELETE';

  async function run() {
    if (!armed || working) return;
    setWorking(true); setError(null);
    try {
      const r = await deleteContact(entity.id);
      onDeleted(r);
    } catch (e) { setError(e.message); setWorking(false); }
  }

  if (!open) {
    return (
      <div className="c2-danger">
        <button className="c2-btn c2-btn--danger" disabled={busy} onClick={() => setOpen(true)}>
          🗑 Delete {kind === 'person' ? 'person' : 'organization'}
        </button>
      </div>
    );
  }

  return (
    <div className="c2-danger c2-danger--open">
      <div className="c2-danger-title">Delete <strong>{name || 'this contact'}</strong>?</div>
      <p className="c2-danger-warn">
        This removes the {kind} from Vibe and cannot be undone from here.
        {affiliations > 0 && ` Its ${affiliations} affiliation${affiliations === 1 ? '' : 's'} ${affiliations === 1 ? 'is' : 'are'} removed too.`}
        {' '}Projects, inspections and estimates that reference this contact are
        not changed, and will be left pointing at a record that no longer exists.
      </p>
      <label className="c2-lbl" htmlFor="c2-del">Type <strong>DELETE</strong> to confirm</label>
      <input id="c2-del" className="c2-input" autoFocus autoComplete="off" placeholder="DELETE"
        value={typed} disabled={working}
        onChange={e => setTyped(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && armed) run(); }} />
      {error && <div className="c2-error">{error}</div>}
      <div className="c2-modal-actions">
        <button className="c2-btn" disabled={working} onClick={() => { setOpen(false); setTyped(''); setError(null); }}>Cancel</button>
        <button className="c2-btn c2-btn--danger" disabled={!armed || working} onClick={run}>
          {working ? 'Deleting…' : 'Delete permanently'}
        </button>
      </div>
    </div>
  );
}

function EditForm({ kind, entity, busy, error, onSave, onCancel, onDeleted, affiliations = 0, name }) {
  const spec = kind === 'person' ? PERSON_FORM : ORG_FORM;
  const [values, setValues] = useState(() =>
    Object.fromEntries(spec.map(f => [f.key, entity[f.key] ?? ''])));
  const set = (k, v) => setValues(p => ({ ...p, [k]: v }));

  const changed = Object.fromEntries(
    spec.map(f => f.key)
      .filter(k => String(values[k] ?? '') !== String(entity[k] ?? ''))
      .map(k => [k, values[k]]));
  const dirty = Object.keys(changed).length > 0;
  const valid = kind === 'person'
    ? !!(String(values.first).trim() || String(values.last).trim())
    : !!String(values.name).trim();

  return (
    <div className="c2-edit">
      <Fields spec={spec} values={values} onChange={set} autoFocusFirst />
      {error && <div className="c2-error">{error}</div>}
      <div className="c2-modal-actions">
        <button className="c2-btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="c2-btn c2-btn--primary" disabled={busy || !dirty || !valid}
          onClick={() => onSave(changed)}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
      {!valid && <p className="c2-note">A person needs a first or last name.</p>}
      {onDeleted && (
        <DeleteContact kind={kind} entity={entity} name={name}
          affiliations={affiliations} busy={busy} onDeleted={onDeleted} />
      )}
    </div>
  );
}

export default function ContactsV2({ navTarget, onClearNav, onRecordSelect } = {}) {
  const [kind, setKind] = useState('people');
  const [people, setPeople] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(null);   // resolved detail
  const [orgPeople, setOrgPeople] = useState(null);
  const [creating, setCreating] = useState(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const selectedId = useRef(null);

  // `loading` starts true, so the initial fetch sets no state synchronously —
  // which keeps this clear of react-hooks/set-state-in-effect rather than
  // silencing it. Every setState here happens once a promise has settled.
  useEffect(() => {
    let alive = true;
    Promise.all([listPeople(), listOrganizations()])
      .then(([p, o]) => { if (alive) { setPeople(p); setOrgs(o); } })
      .catch(e => { if (alive) setLoadError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // Deep links and the Back button. The kind is not in the URL — `open` reads
  // it off the record — so #contacts-v2/90043 resolves whether 90043 turns out
  // to be a person or an organization.
  useEffect(() => {
    if (!navTarget || navTarget.moduleId !== 'contacts-v2') return;
    const id = String(navTarget.recordId ?? '');
    if (!id) { onClearNav?.(); return; }
    if (selectedId.current === id) { onClearNav?.(); return; }
    open({ id }, { push: false });
    onClearNav?.();
  }, [navTarget]);   // eslint-disable-line react-hooks/exhaustive-deps

  const records = kind === 'people' ? people : orgs;

  const controls = useListControls({
    records,
    // These are flat records, not FileMaker's { fieldData } envelope.
    fields: r => r,
    storageKey: `contacts-v2-${kind}`,
    name: r => (kind === 'people' ? r.name : r.name) || '',
    // phones and emails are arrays; the hook stringifies before matching, which
    // joins them with commas and searches every one.
    searchKeys: kind === 'people'
      ? ['name', 'first', 'last', 'title', 'phones', 'phoneDigits', 'emails']
      : ['name', 'type', 'phones', 'phoneDigits', 'emails'],
    sorts: [
      // Trimmed, so a name stored with leading whitespace sorts where it reads
      // rather than ahead of everything — which is what put a 'T' section at
      // the top of the organizations list.
      { id: 'name', label: 'Name', value: r => (r.name || '').trim().toLowerCase(), alpha: true },
      { id: 'status', label: 'Status', value: r => r.status || '' },
    ],
    defaultSort: 'name',
    defaultOrder: 'asc',
  });

  // Keep the sidebar row in step with the record just read, so a renamed
  // contact does not keep its old name in the list until a reload. Derived from
  // the detail rather than from what was submitted — the server is what decided
  // what got stored.
  function syncList(d) {
    // Same shape api/contacts.js sends for a list row, including the phone and
    // email arrays — otherwise adding a number leaves the sidebar unable to
    // find the person by it until a reload.
    const contactable = e => {
      const phones = (e.phones || []).map(p => p.number).filter(Boolean);
      return {
        phones,
        phoneDigits: phones.map(n => n.replace(/\D/g, '')).filter(Boolean),
        emails: (e.emails || []).filter(m => m.type !== 'Web').map(m => m.address).filter(Boolean),
      };
    };
    if (d.kind === 'person') {
      const p = d.person;
      setPeople(list => list.map(r => r.id !== p.id ? r
        : { id: p.id, first: p.first, last: p.last, name: p.displayName, title: p.title, status: p.status, ...contactable(p) }));
    } else if (d.kind === 'organization') {
      const o = d.organization;
      setOrgs(list => list.map(r => r.id !== o.id ? r
        : { id: o.id, name: o.name, status: o.status, type: o.type, parentOrganizationId: o.parentOrganizationId, ...contactable(o) }));
    }
  }

  // `push` is false when arriving FROM the URL (a deep link or the Back
  // button) — pushing again there would add a duplicate history entry and make
  // Back appear not to work.
  async function open(rec, { push = true } = {}) {
    selectedId.current = rec.id;
    setSelected({ loading: true, id: rec.id });
    setOrgPeople(null);
    setEditing(false);
    setActionError(null);
    if (push) onRecordSelect?.(rec.id);
    try {
      const d = await getContact(rec.id);
      if (selectedId.current !== rec.id) return;
      // The tab follows the record. A person's detail showing while the
      // sidebar lists organizations is the kind of disagreement that reads as
      // a bug, so the kind comes from what the server actually returned rather
      // than from whatever tab happened to be open.
      setKind(d.kind === 'organization' ? 'organizations' : 'people');
      // The id has to be carried onto the resolved record. /api/contacts
      // answers { kind, person|organization, … } with no id at the top level,
      // so setting the response alone dropped `selected.id` — which is what the
      // sidebar highlight and ListBody's scroll-into-view both key on. The row
      // for the open record has been silently unhighlighted since this module
      // shipped; it only became obvious once records could link to each other.
      setSelected({ ...d, id: rec.id });
      syncList(d);
      if (d.kind === 'organization') {
        const op = await getOrganizationPeople(rec.id);
        if (selectedId.current === rec.id) setOrgPeople(op.people || []);
      }
    } catch (e) {
      if (selectedId.current === rec.id) setSelected({ error: e.message, id: rec.id });
    }
  }

  // Following a link from one record to another. The search box is cleared
  // because the destination is usually not in the current filter — leaving it
  // shows a detail pane for a record the sidebar says does not exist.
  function goTo(id) {
    controls.setTyped('');
    open({ id });
  }

  async function act(fn) {
    setBusy(true); setActionError(null);
    try {
      await fn();
      if (selectedId.current) await open({ id: selectedId.current }, { push: false });
    } catch (e) {
      // Shown in place. An alert() dismisses itself and leaves no trace of what
      // the server actually objected to — "that would make the hierarchy
      // circular" is worth being able to re-read.
      setActionError(e.message);
    } finally { setBusy(false); }
  }

  // Clearing the selection is not enough — the row would sit in the sidebar
  // until a reload, and clicking it would 404.
  function afterDelete(result) {
    const id = result?.deleted;
    if (result?.kind === 'person') setPeople(list => list.filter(r => r.id !== id));
    else setOrgs(list => list.filter(r => r.id !== id));
    selectedId.current = null;
    setSelected(null);
    setEditing(false);
    onRecordSelect?.(null);
  }

  const person = selected?.kind === 'person' ? selected.person : null;
  const org = selected?.kind === 'organization' ? selected.organization : null;

  return (
    <div className="c2-container">
      <aside className="c2-sidebar">
        <div className="c2-sidebar-header">
          <div className="c2-sidebar-title">
            <div className="c2-sidebar-logo">H5</div>
            <div>
              <div className="c2-sidebar-module">Contacts</div>
              <div className="c2-sidebar-count">
                {loading ? 'Loading…' : `${(people.length + orgs.length).toLocaleString()} records`}
              </div>
            </div>
            <button className="c2-new-btn" onClick={() => setCreating(kind === 'people' ? 'person' : 'organization')}>
              ＋ New
            </button>
          </div>
        </div>

        <div className="c2-kindtabs">
          <button className={kind === 'people' ? 'active' : ''} onClick={() => { setKind('people'); setSelected(null); }}>
            People <span>{people.length.toLocaleString()}</span>
          </button>
          <button className={kind === 'organizations' ? 'active' : ''} onClick={() => { setKind('organizations'); setSelected(null); }}>
            Organizations <span>{orgs.length.toLocaleString()}</span>
          </button>
        </div>

        <ListToolbar c={controls} />

        {/* ListBody returns a bare fragment, so this wrapper is what scrolls.
            Without it the rows are direct flex children of the sidebar: they
            shrink to fit instead of overflowing, which crushes them on top of
            each other and pushes the buttons below off the panel. */}
        <div className="c2-list">
          {loading ? (
            <div className="c2-loading">{Array.from({ length: 10 }, (_, i) => <div key={i} className="c2-skeleton" />)}</div>
          ) : loadError ? (
            <div className="c2-empty">Couldn’t load contacts.<br /><span>{loadError}</span></div>
          ) : (
            <ListBody c={controls} activeId={selected?.id} renderItem={r => (
              <div key={r.id}
                className={`c2-row${selected?.id === r.id ? ' active' : ''}`}
                onClick={() => open(r)}>
                <span className="c2-row-dot" style={{ background: statusColor(r.status) }} />
                <div className="c2-row-text">
                  <div className="c2-row-name">{r.name || <em>(no name)</em>}</div>
                  {kind === 'people' && r.title && <div className="c2-row-sub">{r.title}</div>}
                  {kind === 'organizations' && r.parentOrganizationId && <div className="c2-row-sub">has a parent organization</div>}
                </div>
              </div>
            )} />
          )}
        </div>

        <div className="c2-newbar">
          <button className="c2-btn" onClick={() => setCreating('person')}>+ Person</button>
          <button className="c2-btn" onClick={() => setCreating('organization')}>+ Organization</button>
        </div>
      </aside>

      <main className="c2-main">
        {!selected ? (
          <div className="c2-placeholder">Select a contact.</div>
        ) : selected.loading ? (
          <div className="c2-placeholder">Loading…</div>
        ) : selected.error ? (
          <div className="c2-placeholder">{selected.error}</div>
        ) : person ? (
          <div className="c2-detail">
            {editing ? (
              <>
                <h1>Editing</h1>
                <EditForm kind="person" entity={person} busy={busy} error={actionError}
                  name={person.displayName} affiliations={selected.affiliations?.length || 0}
                  onCancel={() => { setEditing(false); setActionError(null); }}
                  onSave={fields => act(() => updateContact(person.id, fields))}
                  onDeleted={r => afterDelete(r)} />
              </>
            ) : (
              <>
                {/* A person with no name at all is 32 real records, not a
                    rendering fault — shown as such so it can be fixed here. */}
                <h1>{person.displayName || <em className="c2-noname">(no name)</em>}</h1>
                <div className="c2-meta">
                  <span className="c2-chip">Person</span>
                  {person.title && <span>{person.title}</span>}
                  {person.status && <span>{person.status}</span>}
                  <span className="c2-id">{person.id}</span>
                  <button className="c2-mini c2-mini--flush" onClick={() => setEditing(true)}>Edit</button>
                </div>
                {person.notes && <p className="c2-notes">{person.notes}</p>}
                {actionError && <div className="c2-error">{actionError}</div>}

                <Section icon="✉" title="Contact details">
                  <ContactMethods contact={person} busy={busy}
                    onAdd={(k, v) => act(() => addMethod(person.id, k, v))}
                    onUpdate={(k, id, v) => act(() => updateMethod(person.id, k, id, v))}
                    onRemove={(k, id) => act(() => removeMethod(person.id, k, id))} />
                </Section>

                <Section icon="◎" title="Affiliations">
                {selected.affiliations.length === 0 ? (
                  <p className="c2-none">Not attached to any organization.</p>
                ) : (
                  <ul className="c2-affs">
                    {selected.affiliations.map(a => (
                      <li key={a.id}>
                        {a.organizationId
                          ? <button className="c2-link" onClick={() => goTo(a.organizationId)}>
                              {a.organization || a.organizationId}
                            </button>
                          : <span className="c2-aff-org">{a.organization || '—'}</span>}
                        {a.title && <span className="c2-aff-title">{a.title}</span>}
                        {a.primary
                          ? <span className="c2-primary">primary</span>
                          : <button className="c2-mini" disabled={busy}
                              onClick={() => act(() => setPrimary(person.id, a.id))}>make primary</button>}
                        <button className="c2-mini c2-mini--danger" disabled={busy}
                          onClick={() => act(() => unaffiliate(a.id))}>remove</button>
                      </li>
                    ))}
                  </ul>
                )}
                {/* Shown plainly rather than filled in with a guess: for the 7.3% of
                    people with more than one affiliation, picking one silently
                    would be inventing an answer. */}
                {selected.affiliations.length > 1 && !selected.primaryOrganization && (
                  <p className="c2-note">No primary organization chosen.</p>
                )}

                  <div className="c2-picker-block">
                    <OrgPicker orgs={orgs} busy={busy} withTitle actionLabel="Attach"
                      placeholder="Attach to an organization…"
                      onPick={(o, title) => act(() => affiliate(person.id, o.id, title))} />
                  </div>
                </Section>
              </>
            )}
          </div>
        ) : org ? (
          <div className="c2-detail">
            {editing ? (
              <>
                <h1>Editing</h1>
                <EditForm kind="organization" entity={org} busy={busy} error={actionError}
                  name={org.name} affiliations={selected.peopleCount || 0}
                  onCancel={() => { setEditing(false); setActionError(null); }}
                  onSave={fields => act(() => updateContact(org.id, fields))}
                  onDeleted={r => afterDelete(r)} />
              </>
            ) : (
              <>
                <h1>{org.name}</h1>
                <div className="c2-meta">
                  <span className="c2-chip c2-chip--org">Organization</span>
                  {org.type && <span>{org.type}</span>}
                  {org.status && <span>{org.status}</span>}
                  <span className="c2-id">{org.id}</span>
                  <button className="c2-mini c2-mini--flush" onClick={() => setEditing(true)}>Edit</button>
                </div>
                {org.notes && <p className="c2-notes">{org.notes}</p>}
                {actionError && <div className="c2-error">{actionError}</div>}

                <Section icon="✉" title="Contact details">
                  <ContactMethods contact={org} busy={busy}
                    onAdd={(k, v) => act(() => addMethod(org.id, k, v))}
                    onUpdate={(k, id, v) => act(() => updateMethod(org.id, k, id, v))}
                    onRemove={(k, id) => act(() => removeMethod(org.id, k, id))} />
                </Section>

                <Section icon="⌂" title="Parent organization">
                {org.parent ? (
                  <p className="c2-parent">Part of{' '}
                    <button className="c2-link c2-link--strong" onClick={() => goTo(org.parent.id)}>{org.parent.name}</button>
                    <button className="c2-mini c2-mini--danger c2-mini--flush" disabled={busy}
                      onClick={() => act(() => setParent(org.id, null))}>remove</button>
                  </p>
                ) : (
                  <>
                    {/* 8 organizations came out of the migration with a parent
                        that could not be inferred, and were left unset on
                        purpose. This is where they get answered by a human. */}
                    <p className="c2-none">Not part of a larger organization.</p>
                    <OrgPicker orgs={orgs} busy={busy} excludeId={org.id} actionLabel="Set as parent"
                      placeholder="Search for a district or parent…"
                      onPick={o => act(() => setParent(org.id, o.id))} />
                  </>
                )}
                </Section>

                <Section icon="◎" title={`People${orgPeople ? ` (${orgPeople.length})` : ''}`}>
                {!orgPeople ? <p className="c2-none">Loading…</p>
                  : orgPeople.length === 0 ? <p className="c2-none">Nobody attached yet.</p>
                  : (
                    <ul className="c2-people">
                      {orgPeople.map(p => (
                        <li key={p.affiliationId}>
                          <button className="c2-link" onClick={() => goTo(p.id)}>{p.name}</button>
                          {p.title && <span className="c2-aff-title">{p.title}</span>}
                          {p.primary && <span className="c2-primary">primary</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              </>
            )}
          </div>
        ) : null}
      </main>

      {creating && (
        <CreateModal
          kind={creating}
          onClose={() => setCreating(null)}
          onCreated={rec => {
            setCreating(null);
            if (creating === 'person') { setPeople(p => [rec, ...p]); setKind('people'); }
            else { setOrgs(o => [rec, ...o]); setKind('organizations'); }
            open(rec);
          }}
        />
      )}
    </div>
  );
}

// One search-and-pick control, used both to attach a person to an organization
// and to give an organization its parent. Same interaction, so the same widget —
// `excludeId` keeps an organization out of its own parent list.
function OrgPicker({ orgs, busy, excludeId, withTitle, placeholder, actionLabel, onPick }) {
  const [q, setQ] = useState('');
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState(null);
  const needle = q.trim().toLowerCase();
  const matches = needle.length < 2 ? [] : orgs
    .filter(o => o.id !== excludeId && (o.name || '').toLowerCase().includes(needle))
    .slice(0, 8);

  function commit() {
    onPick(picked, title);
    setPicked(null); setQ(''); setTitle('');
  }

  return (
    <div className="c2-picker">
      {picked ? (
        <div className="c2-picked">
          <strong>{picked.name}</strong>
          {withTitle && (
            <input className="c2-input c2-input--inline" placeholder="Title at this organization"
              value={title} onChange={e => setTitle(e.target.value)} />
          )}
          <button className="c2-btn c2-btn--primary" disabled={busy} onClick={commit}>{actionLabel}</button>
          <button className="c2-btn" onClick={() => setPicked(null)}>Cancel</button>
        </div>
      ) : (
        <>
          <input className="c2-input" placeholder={placeholder} value={q} onChange={e => setQ(e.target.value)} />
          {matches.length > 0 && (
            <ul className="c2-matches">
              {matches.map(o => <li key={o.id}><button onClick={() => setPicked(o)}>{o.name}</button></li>)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
