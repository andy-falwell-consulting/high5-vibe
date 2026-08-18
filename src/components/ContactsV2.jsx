import { useState, useEffect, useRef, useCallback } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import { BRAND, UI } from '../config/brandColors';
import { formatPhone, telHref } from '../../api/_phone';
import { useRelatedRecords, sharedNameCount } from '../hooks/useRelatedRecords';
import { createRecord, getRecord } from '../api/filemaker';
import {
  listPeople, listOrganizations, getContact, getOrganizationPeople,
  createPerson, createOrganization, updateContact,
  affiliate, setPrimary, unaffiliate, setParent,
  addMethod, updateMethod, removeMethod, deleteContact,
  reorderOrgPeople, reorderMethods, contactDistance,
} from '../api/vibeContacts';
import { findInLayout, getRecordWithPortals } from '../api/filemaker';
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
    // Stored E.164, shown (508) 853-7824. The extension is its own field —
    // typing 'x261' into the number still works, the server splits it out.
    fields: [{ key: 'number', label: 'Number' }, { key: 'ext', label: 'Ext.', narrow: true }],
    show: m => formatPhone(m.number, m.ext),
    href: m => telHref(m.number, m.ext),
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
    // Google's documented search URL, which drops a pin on the address rather
    // than just centring the map near it. Opened in a new tab so nobody loses
    // the record they were reading.
    map: m => {
      const q = [m.street, m.city, m.state, m.zip, m.country]
        .map(v => String(v || '').trim()).filter(Boolean).join(', ');
      return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null;
    },
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

// The work a contact has — inspections, CCS projects, training, estimates,
// risk items. These arrived as FileMaker portals on the old Contacts page,
// which cannot see Vibe edits (see config/relatedRecords.js); here they come
// from each module's own cache and so read through the overlay.
//
// One tab per source, matching the tab strip on the original Contacts module.

// The table for a single source, rendered inside its own tab.
function WorkTable({ src, rows, onOpen }) {
  if (!rows.length) return <p className="c2-none">Nothing recorded.</p>;
  return (
    <div className="c2-table-scroll">
      <table className="c2-table">
        <thead>
          <tr>{src.columns.map(c => <th key={c.label} className={c.money ? 'num' : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.recordId} className="c2-row-link" title="Open"
              onClick={() => onOpen?.(src.module, r.recordId)}>
              {src.columns.map(c => {
                const v = c.get(r.fieldData || {});
                return (
                  <td key={c.label} className={c.money ? 'num' : undefined}>
                    {c.money
                      ? '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })
                      : (v || '—')}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// OE Training (WKSRG) rows — read-only, no Belay module to open, same as on
// the legacy Contacts module (Contacts.jsx). `state` is the effect-tracked
// { id, rows } | null from the oeTraining fetch above.
function OeTrainingTable({ state, openId }) {
  if (state?.id !== openId) return <p className="c2-none">Loading…</p>;
  if (!state.rows.length) return <p className="c2-none">Nothing recorded.</p>;
  return (
    <div className="c2-table-scroll">
      <table className="c2-table">
        <thead><tr><th>Course #</th><th>Course Name</th><th>Organization</th><th>Start</th><th>End</th></tr></thead>
        <tbody>
          {state.rows.map((r, i) => (
            <tr key={i}>
              <td className="mono">{r['cntct_WKSRG::Course Number']}</td>
              <td>{r['cntct_WKSRG::Course Name']}</td>
              <td>{r['cntct_WKSRG::zz__Display_Organization__ct']}</td>
              <td>{r['cntct_WKSRG::Start Date']}</td>
              <td>{r['cntct_WKSRG::End Date']}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The caveats that belong with a work list: a shared organization name can pull
// in another organization's records, and a district's list includes its sites.
// Shown above the table rather than hidden, so an overlap reads as a known
// limitation instead of as fact.
function WorkNotes({ shared, children }) {
  if (!shared && !children) return null;
  return (
    <>
      {shared > 0 && (
        <p className="c2-note c2-note--warn">
          {shared === 1
            ? 'Another organization shares this name, so these lists may include its work.'
            : `${shared} other organizations share this name, so these lists may include their work.`}
        </p>
      )}
      {children > 0 && (
        <p className="c2-note">Includes {children === 1 ? 'one affiliated site' : `${children} affiliated sites`}.</p>
      )}
    </>
  );
}

// A contact with an open risk item says so at a glance, wherever you land on
// the record — not only on the RMI tab. High level of risk is called out
// separately because that is the one that changes what someone does next.
function RiskBadge({ active, high, onOpen }) {
  if (!active?.length) return null;
  const n = active.length;
  return (
    <button type="button" className={`c2-riskbadge${high ? ' c2-riskbadge--high' : ''}`}
      onClick={onOpen}
      title={`${n} active risk item${n === 1 ? '' : 's'} — open the RMI tab`}>
      <span aria-hidden="true">⚠</span>
      {high ? 'High risk' : 'Active RMI'}
      {n > 1 && <span className="c2-riskbadge-count">{n}</span>}
    </button>
  );
}

// One draggable person row on an organization.
function SortablePerson({ person, busy, onOpen }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: person.affiliationId,
  });
  return (
    <li ref={setNodeRef}
      className={`c2-person-row${isDragging ? ' dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}>
      {/* The handle, not the whole row, starts a drag — the name is a link and
          has to stay clickable. */}
      <span className="c2-drag" title="Drag to reorder" {...attributes} {...listeners}>⠿</span>
      <button className="c2-link" disabled={busy} onClick={() => onOpen(person.id)}>{person.name}</button>
      {person.title && <span className="c2-aff-title">{person.title}</span>}
      {person.primary && <span className="c2-primary">primary</span>}
    </li>
  );
}

// The people on an organization, in an order the team drags by hand.
//
// The order is stored in the byOrg index that already drives the read, so no
// field was added for it. Reordered optimistically and rolled back on failure:
// this is a display order, and showing the drop then taking it away beats
// freezing the list on a round trip.
function OrgPeople({ people, busy, onOpen, onReorder }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  if (!people) return <p className="c2-none">Loading…</p>;
  if (!people.length) return <p className="c2-none">Nobody attached yet.</p>;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return;
        const from = people.findIndex(p => p.affiliationId === active.id);
        const to = people.findIndex(p => p.affiliationId === over.id);
        if (from < 0 || to < 0) return;
        onReorder(arrayMove(people, from, to));
      }}>
      <SortableContext items={people.map(p => p.affiliationId)} strategy={verticalListSortingStrategy}>
        <ul className="c2-people">
          {people.map(p => (
            <SortablePerson key={p.affiliationId} person={p} busy={busy} onOpen={onOpen} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

// Type-search for a PERSON, to attach one to an organization. Deliberately the
// same interaction as OrgPicker below, which does the reverse from a person's
// page — the two directions of one relationship should not feel different.
function PersonPicker({ people, busy, excludeIds, placeholder, actionLabel, onPick }) {
  const [q, setQ] = useState('');
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState(null);
  const needle = q.trim().toLowerCase();
  const skip = excludeIds || new Set();
  const matches = needle.length < 2 ? [] : people
    .filter(p => !skip.has(String(p.id)) && (p.name || '').toLowerCase().includes(needle))
    .slice(0, 8);

  return (
    <div className="c2-picker">
      {picked ? (
        <div className="c2-picked">
          <span className="c2-picked-name">{picked.name}</span>
          <input className="c2-input c2-input--inline" placeholder="Title (optional)"
            value={title} onChange={e => setTitle(e.target.value)} />
          <button className="c2-btn c2-btn--primary" disabled={busy}
            onClick={() => { onPick(picked, title.trim()); setPicked(null); setTitle(''); setQ(''); }}>
            {actionLabel}
          </button>
          <button className="c2-btn" disabled={busy} onClick={() => { setPicked(null); setTitle(''); }}>Cancel</button>
        </div>
      ) : (
        <>
          <input className="c2-input" placeholder={placeholder} value={q} onChange={e => setQ(e.target.value)} />
          {matches.length > 0 && (
            <ul className="c2-matches">
              {matches.map(p => (
                <li key={p.id}><button onClick={() => setPicked(p)}>{p.name}{p.title ? ` · ${p.title}` : ''}</button></li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// Confirmation before an RMI is raised. A risk record is a real thing with a
// person's name on it, so it is not created by a single stray click — and the
// note is asked for here rather than left blank for someone to fill in later.
function HighRiskModal({ name, busy, error, onCancel, onConfirm }) {
  const [note, setNote] = useState('');
  return (
    <div className="c2-modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="c2-modal" onClick={e => e.stopPropagation()}>
        <h2>Mark {name} as high risk?</h2>
        <p className="c2-modal-note">
          This creates an active Risk Management record at High level of risk and opens it.
        </p>
        <label className="c2-label">Note of concern</label>
        <textarea className="c2-input c2-input--area" rows={4} autoFocus
          placeholder="What is the concern?" value={note} onChange={e => setNote(e.target.value)} />
        {error && <div className="c2-error">{error}</div>}
        <div className="c2-modal-actions">
          <button className="c2-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="c2-btn c2-btn--danger" disabled={busy} onClick={() => onConfirm(note.trim())}>
            {busy ? 'Creating…' : 'Create RMI'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Tab strip. Mirrors .ct-tabs on the original Contacts module — same
// underline-on-active treatment and the same count pill — so the two modules
// read as one product.
function Tabs({ tabs, active, onPick }) {
  return (
    <div className="c2-tabs" role="tablist">
      {tabs.map(t => (
        <button key={t.id} role="tab" aria-selected={active === t.id}
          className={`c2-tab${active === t.id ? ' on' : ''}`}
          onClick={() => onPick(t.id)}>
          {t.label}
          {t.count > 0 && <span className="c2-tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// One draggable method row — email only, for now (see ContactMethods). Same
// drag pattern as SortablePerson: a handle starts the drag, not the row, so
// the edit/remove buttons stay clickable.
function SortableMethodRow({ method, spec, busy, onEdit, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: method.id,
  });
  return (
    <li ref={setNodeRef}
      className={`c2-methodrow${isDragging ? ' dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}>
      <span className="c2-drag" title="Drag to reorder" {...attributes} {...listeners}>⠿</span>
      <span className="c2-methodtype">{method.type || '—'}</span>
      {spec.href
        ? <a className="c2-methodvalue" href={spec.href(method)}>{spec.show(method)}</a>
        : <span className="c2-methodvalue">{spec.show(method)}</span>}
      <button className="c2-mini" disabled={busy} onClick={() => onEdit(method.id)}>edit</button>
      <button className="c2-mini c2-mini--danger" disabled={busy} onClick={() => onRemove(method.id)}>remove</button>
    </li>
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
        <input key={f.key} className={`c2-input c2-input--inline${f.narrow ? ' c2-input--narrow' : ''}`} placeholder={f.label}
          autoFocus={i === 0} value={v[f.key]} onChange={e => set(f.key, e.target.value)} />
      ))}
      <button className="c2-btn c2-btn--primary" disabled={busy || !valid} onClick={() => onSave(v)}>Save</button>
      <button className="c2-btn" onClick={onCancel} disabled={busy}>Cancel</button>
    </div>
  );
}

function ContactMethods({ contact, busy, onAdd, onUpdate, onRemove, onReorder }) {
  // { kind, id } — id null means "adding". One form open at a time, so a
  // half-typed address can't be lost behind another one.
  const [form, setForm] = useState(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  return (
    <div className="c2-methods">
      {Object.entries(METHOD_SPEC).map(([kind, spec]) => {
        const rows = contact[spec.field] || [];
        // Drag-to-sort is email-only for now — that's the one Andy asked for,
        // and it's what Trainings reads "the first email" from (see
        // contactLookup.js's firstEmail option). Off while a row in this
        // group is mid-edit, so dragging never has to reconcile with the
        // inline form swapping a row's shape out from under it.
        const sortable = kind === 'email' && rows.length > 1 && form?.kind !== kind;
        return (
          <div className="c2-methodgroup" key={kind}>
            <h3>{spec.plural}</h3>
            {rows.length === 0 && !(form?.kind === kind && !form.id) && (
              <p className="c2-none">None recorded.</p>
            )}
            {sortable ? (
              <DndContext sensors={sensors} collisionDetection={closestCenter}
                onDragEnd={({ active, over }) => {
                  if (!over || active.id === over.id) return;
                  const from = rows.findIndex(m => m.id === active.id);
                  const to = rows.findIndex(m => m.id === over.id);
                  if (from < 0 || to < 0) return;
                  onReorder(kind, arrayMove(rows, from, to).map(m => m.id));
                }}>
                <SortableContext items={rows.map(m => m.id)} strategy={verticalListSortingStrategy}>
                  <ul className="c2-methodlist">
                    {rows.map(m => (
                      <SortableMethodRow key={m.id} method={m} spec={spec} busy={busy}
                        onEdit={id => setForm({ kind, id })} onRemove={id => onRemove(kind, id)} />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            ) : (
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
                    {spec.map?.(m) && (
                      <a className="c2-mini c2-mini--map" href={spec.map(m)}
                        target="_blank" rel="noreferrer" title="Open in Google Maps">Map</a>
                    )}
                    <button className="c2-mini" disabled={busy}
                      onClick={() => setForm({ kind, id: m.id })}>edit</button>
                    <button className="c2-mini c2-mini--danger" disabled={busy}
                      onClick={() => onRemove(kind, m.id)}>remove</button>
                  </li>
                )))}
              </ul>
            )}
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

// One modal for both kinds, with the choice made inside it.
//
// It used to be two buttons deciding for you before the modal opened, which
// meant getting it wrong cost a cancel and a restart. The kind is a control
// here, and the fields follow it.
//
// Deliberately the SHORTEST form that produces a valid record: an organization
// needs only its name, a person only a name and what they do. Everything else —
// status, type, site number, notes, and the phones, emails and addresses — is
// edited on the record once it exists, where there is room to show it properly.
// A create form that asks for everything gets abandoned or filled with guesses.
const CREATE_FIELDS = {
  person: PERSON_FORM.filter(f => ['first', 'last', 'title'].includes(f.key)),
  organization: ORG_FORM.filter(f => f.key === 'name'),
};
function CreateModal({ initialKind, onClose, onCreated }) {
  const [kind, setKind] = useState(initialKind === 'organizations' ? 'organization' : 'person');
  // One store across both kinds. `status` and `notes` are on both forms, so
  // switching keeps what was typed rather than quietly discarding it.
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setValues(p => ({ ...p, [k]: v }));

  const spec = CREATE_FIELDS[kind];
  const canSave = kind === 'person'
    ? !!(String(values.first || '').trim() || String(values.last || '').trim())
    : !!String(values.name || '').trim();

  async function save() {
    if (!canSave || busy) return;
    setBusy(true); setError(null);
    try {
      // Only the chosen kind's fields are sent. The shared store may hold a
      // name typed before switching to Person, and the endpoint rejects a field
      // it does not own rather than storing it quietly. Status is left out
      // entirely so the server applies its own default rather than an empty
      // string standing in for one.
      const payload = Object.fromEntries(spec.map(f => [f.key, values[f.key] ?? '']));
      const r = kind === 'person' ? await createPerson(payload) : await createOrganization(payload);
      onCreated(kind === 'person' ? r.person : r.organization, kind);
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="c2-overlay" onClick={onClose}>
      <div className="c2-modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <h2>New contact</h2>

        <div className="c2-kindpick" role="radiogroup" aria-label="What are you adding?">
          {[['person', 'Person'], ['organization', 'Organization']].map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k}
              className={kind === k ? 'active' : ''}
              disabled={busy} onClick={() => setKind(k)}>{label}</button>
          ))}
        </div>

        <Fields spec={spec} values={values} onChange={set} autoFocusFirst key={kind} />

        {error && <div className="c2-error">{error}</div>}
        <div className="c2-modal-actions">
          <button className="c2-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="c2-btn c2-btn--primary" onClick={save} disabled={busy || !canSave}>
            {busy ? 'Saving…' : `Create ${kind}`}
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
  // The FULL field set, not the short create form — everything the create modal
  // leaves out is meant to be filled in here.
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

export default function ContactsV2({ navTarget, onClearNav, onRecordSelect, onNavigateTo } = {}) {
  const [kind, setKind] = useState('people');
  const [people, setPeople] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(null);   // resolved detail
  const [orgPeople, setOrgPeople] = useState(null);
  const [creating, setCreating] = useState(null);
  const [editing, setEditing] = useState(false);
  // Which detail tab is showing. Resets to Overview whenever a different record
  // is opened — carrying "Estimates" across to a contact that has none would
  // land the reader on an empty pane with no idea why.
  const [tab, setTab] = useState('overview');
  // Mark-as-high-risk: null | 'asking' while the confirmation is open.
  const [riskAsk, setRiskAsk] = useState(null);
  const [riskBusy, setRiskBusy] = useState(false);
  const [riskError, setRiskError] = useState(null);
  // Distance / drive time to HQ, fetched per contact (api/contact-distance.js).
  const [distance, setDistance] = useState(null);
  // OE Training (WKSRG), the one work source with no Vibe-owned module behind
  // it — still a raw FileMaker portal on Contacts_New (Portal__Orders), so it
  // is fetched on demand rather than joining useRelatedRecords' module caches.
  // { id, rows } keyed by the open contact, fetched lazily on first visit to
  // the tab rather than on every record open.
  const [oeTraining, setOeTraining] = useState(null);
  // Sidebar width, dragged by the handle between the list and the record.
  // Persisted, unlike the other modules': the width someone picks is a
  // preference, and losing it on every reload is the reason nobody adjusts it.
  const [navWidth, setNavWidth] = useState(() => {
    const saved = Number(localStorage.getItem('contacts-v2-nav-width'));
    return saved >= 220 && saved <= 560 ? saved : 320;
  });
  const isResizing = useRef(false);

  const startResize = useCallback(e => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const startX = e.clientX;
    const startW = navWidth;
    const onMove = ev => {
      if (!isResizing.current) return;
      setNavWidth(Math.min(560, Math.max(220, startW + (ev.clientX - startX))));
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

  useEffect(() => { localStorage.setItem('contacts-v2-nav-width', String(navWidth)); }, [navWidth]);
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

  // Distance / drive time for the open contact. Keyed by id so switching
  // records reads as loading without an effect having to reset it first.
  const openId = selected?.kind === 'organization' ? selected.organization?.id : selected?.person?.id;
  useEffect(() => {
    if (!openId) return undefined;
    let alive = true;
    contactDistance(openId)
      .then(d => { if (alive) setDistance({ id: openId, ...d }); })
      .catch(() => { if (alive) setDistance({ id: openId, distance: null, driveTime: null }); });
    return () => { alive = false; };
  }, [openId]);
  const dist = distance?.id === openId ? distance : null;

  // OE Training rows, fetched only once the tab is actually opened — unlike
  // every other work source these come straight from FileMaker's own
  // Portal__Orders on Contacts_New, so opening it costs a live round trip: a
  // find by _kpt__Contact_ID (Vibe's contact id IS this field, verbatim) to
  // get the FileMaker recordId, then that record's portal data.
  useEffect(() => {
    if (tab !== 'oe_training' || !openId) return undefined;
    if (oeTraining?.id === openId) return undefined;
    let alive = true;
    (async () => {
      try {
        const found = await findInLayout('Contacts_New', [{ _kpt__Contact_ID: `==${openId}` }], { limit: 1 });
        const rec = found?.response?.data?.[0];
        const full = rec ? await getRecordWithPortals('Contacts_New', rec.recordId, { 'Portal__Orders': 200 }) : null;
        const rows = full?.response?.data?.[0]?.portalData?.['Portal__Orders'] || [];
        if (alive) setOeTraining({ id: openId, rows });
      } catch {
        if (alive) setOeTraining({ id: openId, rows: [] });
      }
    })();
    return () => { alive = false; };
  }, [tab, openId, oeTraining]);

  const records = kind === 'people' ? people : orgs;

  // Lifted out of the work tables so the tab strip can carry counts. One fetch
  // for the open contact, shared by every tab.
  const related = useRelatedRecords(selected, orgs);
  const selectedOrg = selected?.kind === 'organization' ? selected.organization : null;
  const sharedNames = selectedOrg ? sharedNameCount(selectedOrg, orgs) : 0;

  // Overview always; People only for an organization. Every work source gets a
  // tab on BOTH kinds, so the strip is the same shape on every record.
  //
  // People were once filtered to non-empty tabs, on the belief that a person's
  // work was rare. Measured, that was wrong: the foreign key names a PERSON on
  // four of the five sources — 1,090 of 1,091 inspection keys, 1,597 of 1,605
  // CCS, 1,170 of 1,176 training, 98 of 98 RMI (only estimates key to the
  // organization). 2,326 of 10,831 people, 21.5%, have work of their own, so
  // hiding an empty tab was hiding a real one just as often.
  const workTabs = (related.groups || [])
    .map(g => ({ id: g.src.id, label: g.src.label, count: g.rows.length }));

  const detailTabs = [
    { id: 'overview', label: 'Overview', count: 0 },
    ...(selected?.kind === 'organization'
      ? [{ id: 'people', label: 'People', count: orgPeople?.length || 0 }]
      : []),
    ...workTabs,
    // Not module-cache-backed like workTabs — see the oeTraining effect
    // above — so its count only appears once the tab has actually been
    // opened at least once for this contact.
    { id: 'oe_training', label: 'OE Trainings', count: oeTraining?.id === openId ? oeTraining.rows.length : 0 },
  ];

  // A tab can vanish between records (a person with no estimates). Falling back
  // rather than rendering nothing.
  const activeTab = detailTabs.some(t => t.id === tab) ? tab : 'overview';
  const activeGroup = (related.groups || []).find(g => g.src.id === activeTab);

  // An RMI already loads with the rest of a contact's work, so "has an active
  // risk item" costs nothing extra — Status is Active or Resolved, and only
  // Active earns the badge.
  const rmiRows = (related.groups || []).find(g => g.src.id === 'rmi')?.rows || [];
  const activeRmi = rmiRows.filter(r => String(r.fieldData?.Status || '').toLowerCase() === 'active');
  const highRisk = activeRmi.some(r => String(r.fieldData?.Level_of_Risk || '').toLowerCase() === 'high');

  // Sites belonging to this organization — the same parent link that makes a
  // district's work list include its schools, shown directly.
  const childSites = selectedOrg
    ? orgs.filter(o => String(o.parentOrganizationId ?? '') === String(selectedOrg.id))
    : [];

  // People already attached, so the picker cannot offer them again.
  const attachedIds = new Set((orgPeople || []).map(p => String(p.id)));

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
    setTab('overview');
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

  // Reorder optimistically, roll back if the write fails. The order is a
  // display preference, so a brief wrong order beats a frozen list.
  async function handleReorderPeople(next) {
    const before = orgPeople;
    setOrgPeople(next);
    try {
      await reorderOrgPeople(selectedOrg.id, next.map(p => p.affiliationId));
    } catch (e) {
      setOrgPeople(before);
      setActionError(e.message || 'Could not save that order.');
    }
  }

  // Mark a contact high risk: create an active RMI against it and open it.
  //
  // This writes to FILEMAKER, not Vibe — RMI_New is not Vibe-owned yet, so it
  // goes through createRecord exactly as RMI.jsx does. It therefore needs a real
  // FileMaker session and cannot run on the preview bypass. It moves to Vibe
  // with Phase A1 of docs/decoupling-plan.md.
  async function confirmHighRisk(note) {
    const id = selected?.kind === 'organization' ? selected.organization?.id : selected?.person?.id;
    if (!id) return;
    setRiskBusy(true); setRiskError(null);
    try {
      const fieldData = {
        _kft__Contact_ID: String(id),
        Status: 'Active',
        Level_of_Risk: 'High',
        Entry_Date: new Date().toLocaleDateString('en-US'),
      };
      if (note) fieldData.Note_Concern = note;
      const res = await createRecord('RMI_New', fieldData);
      const newId = res?.response?.recordId;
      if (!newId) throw new Error(res?.messages?.[0]?.message || 'Could not create the risk record');
      // Read it back so the RMI module opens a record that exists in its cache.
      await getRecord('RMI_New', newId).catch(() => {});
      setRiskAsk(null);
      onNavigateTo?.('rmi', newId);
    } catch (e) {
      setRiskError(e.message || 'Could not create the risk record.');
    } finally {
      setRiskBusy(false);
    }
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
      <aside className="c2-sidebar" style={{ width: navWidth }}>
        <div className="c2-sidebar-header">
          <div className="c2-sidebar-title">
            <div className="c2-sidebar-logo">H5</div>
            <div>
              <div className="c2-sidebar-module">Contacts</div>
              <div className="c2-sidebar-count">
                {loading ? 'Loading…' : `${(people.length + orgs.length).toLocaleString()} records`}
              </div>
            </div>
            <button className="c2-new-btn" onClick={() => setCreating(kind)}>＋ New</button>
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
          <button className="c2-btn" onClick={() => setCreating(kind)}>＋ New contact</button>
        </div>
      </aside>

      <div className="c2-resize-handle" onMouseDown={startResize} title="Drag to resize" />

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
                  <RiskBadge active={activeRmi} high={highRisk} onOpen={() => setTab('rmi')} />
                  <span className="c2-id">{person.id}</span>
                  <button className="c2-mini c2-mini--flush" onClick={() => setEditing(true)}>Edit</button>
                  {!highRisk && (
                    <button className="c2-mini c2-mini--danger c2-mini--flush"
                      onClick={() => { setRiskError(null); setRiskAsk('asking'); }}>Mark high risk</button>
                  )}
                </div>
                {actionError && <div className="c2-error">{actionError}</div>}

                <Tabs tabs={detailTabs} active={activeTab} onPick={setTab} />

                {activeTab === 'overview' && (<>
                {/* Notes live INSIDE Overview, not above the strip. Some run to
                    thousands of characters — one contact carries 4,303 — and
                    above the tabs that pushed the strip clean off the screen. */}
                {person.notes && (
                  <Section icon="✎" title="Notes"><p className="c2-notes">{person.notes}</p></Section>
                )}
                <Section icon="✉" title="Contact details">
                  <ContactMethods contact={person} busy={busy}
                    onAdd={(k, v) => act(() => addMethod(person.id, k, v))}
                    onUpdate={(k, id, v) => act(() => updateMethod(person.id, k, id, v))}
                    onRemove={(k, id) => act(() => removeMethod(person.id, k, id))}
                    onReorder={(k, order) => act(() => reorderMethods(person.id, k, order))} />
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
                </>)}

                {/* A person shows only what is keyed to them, not their
                    organization's whole history — see useRelatedRecords. */}
                {activeGroup && (
                  <Section icon="≡" title={activeGroup.src.label}>
                    <WorkTable src={activeGroup.src} rows={activeGroup.rows} onOpen={onNavigateTo} />
                  </Section>
                )}

                {activeTab === 'oe_training' && (
                  <Section icon="≡" title="OE Trainings">
                    <OeTrainingTable state={oeTraining} openId={openId} />
                  </Section>
                )}
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
                  <RiskBadge active={activeRmi} high={highRisk} onOpen={() => setTab('rmi')} />
                  <span className="c2-id">{org.id}</span>
                  <button className="c2-mini c2-mini--flush" onClick={() => setEditing(true)}>Edit</button>
                  {!highRisk && (
                    <button className="c2-mini c2-mini--danger c2-mini--flush"
                      onClick={() => { setRiskError(null); setRiskAsk('asking'); }}>Mark high risk</button>
                  )}
                </div>
                {actionError && <div className="c2-error">{actionError}</div>}

                <Tabs tabs={detailTabs} active={activeTab} onPick={setTab} />

                {activeTab === 'overview' && (<>
                {org.notes && (
                  <Section icon="✎" title="Notes"><p className="c2-notes">{org.notes}</p></Section>
                )}
                <Section icon="✉" title="Contact details">
                  <ContactMethods contact={org} busy={busy}
                    onAdd={(k, v) => act(() => addMethod(org.id, k, v))}
                    onUpdate={(k, id, v) => act(() => updateMethod(org.id, k, id, v))}
                    onRemove={(k, id) => act(() => removeMethod(org.id, k, id))}
                    onReorder={(k, order) => act(() => reorderMethods(org.id, k, order))} />
                </Section>

                <Section icon="⛗" title="Distance to HQ">
                  {/* Derived from the address, not stored: Contacts_New has a
                      drive_time field that is empty on every record, and no
                      distance field at all. Served from the same cache
                      distance-sync fills for CCS and trainings. */}
                  {!dist ? <p className="c2-none">Checking…</p>
                    : dist.distance || dist.driveTime ? (
                      <div className="c2-distance">
                        <div><span className="c2-dist-label">Distance</span>{dist.distance || '—'}</div>
                        <div><span className="c2-dist-label">Drive time</span>{dist.driveTime || '—'}</div>
                      </div>
                    ) : (
                      <p className="c2-none">
                        {dist.reason === 'no address' ? 'No address on this organization.' : 'Could not work out a route.'}
                      </p>
                    )}
                </Section>

                <Section icon="◫" title={`Affiliated sites${childSites.length ? ` (${childSites.length})` : ''}`}>
                {childSites.length === 0 ? (
                  <p className="c2-none">No sites belong to this organization.</p>
                ) : (
                  <ul className="c2-people">
                    {childSites.map(site => (
                      <li key={site.id}>
                        <button className="c2-link" onClick={() => goTo(site.id)}>{site.name}</button>
                        {site.type && <span className="c2-aff-title">{site.type}</span>}
                        {site.status && site.status !== 'Active' && <span className="c2-aff-title">{site.status}</span>}
                      </li>
                    ))}
                  </ul>
                )}
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
                </>)}

                {activeTab === 'people' && (
                  <Section icon="◎" title={`People${orgPeople ? ` (${orgPeople.length})` : ''}`}
                    aside={orgPeople && orgPeople.length > 1
                      ? <span className="c2-section-hint">drag ⠿ to reorder</span> : null}>
                    <OrgPeople people={orgPeople} busy={busy} onOpen={goTo} onReorder={handleReorderPeople} />
                    <div className="c2-picker-block">
                      <PersonPicker people={people} busy={busy} excludeIds={attachedIds}
                        placeholder="Attach a person…" actionLabel="Attach"
                        onPick={(p, title) => act(async () => {
                          await affiliate(p.id, org.id, title);
                          const op = await getOrganizationPeople(org.id);
                          setOrgPeople(op.people || []);
                        })} />
                    </div>
                  </Section>
                )}

                {activeGroup && (
                  <Section icon="≡" title={activeGroup.src.label}>
                    <WorkNotes shared={sharedNames} children={related.children || 0} />
                    {related.loading
                      ? <p className="c2-none">Loading…</p>
                      : <WorkTable src={activeGroup.src} rows={activeGroup.rows} onOpen={onNavigateTo} />}
                  </Section>
                )}

                {activeTab === 'oe_training' && (
                  <Section icon="≡" title="OE Trainings">
                    <OeTrainingTable state={oeTraining} openId={openId} />
                  </Section>
                )}
              </>
            )}
          </div>
        ) : null}
      </main>

      {riskAsk && (
        <HighRiskModal
          name={selected?.kind === 'organization' ? selected.organization?.name : selected?.person?.displayName}
          busy={riskBusy} error={riskError}
          onCancel={() => { setRiskAsk(null); setRiskError(null); }}
          onConfirm={confirmHighRisk} />
      )}

      {creating && (
        <CreateModal
          initialKind={creating}
          onClose={() => setCreating(null)}
          onCreated={(rec, madeKind) => {
            setCreating(null);
            // The modal reports which kind it made — the choice happens inside
            // it, so what was pre-selected when it opened means nothing here.
            if (madeKind === 'person') setPeople(p => [rec, ...p]);
            else setOrgs(o => [rec, ...o]);
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
