import { useState, useEffect, useRef } from 'react';
import ListToolbar, { useListControls, ListBody } from './ListControls';
import {
  listPeople, listOrganizations, getContact, getOrganizationPeople,
  createPerson, createOrganization, affiliate, setPrimary, unaffiliate,
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

export default function ContactsV2() {
  const [kind, setKind] = useState('people');
  const [people, setPeople] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(null);   // resolved detail
  const [orgPeople, setOrgPeople] = useState(null);
  const [creating, setCreating] = useState(null);
  const [busy, setBusy] = useState(false);
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

  const records = kind === 'people' ? people : orgs;

  const controls = useListControls({
    records,
    // These are flat records, not FileMaker's { fieldData } envelope.
    fields: r => r,
    storageKey: `contacts-v2-${kind}`,
    name: r => (kind === 'people' ? r.name : r.name) || '',
    searchKeys: kind === 'people' ? ['name', 'first', 'last', 'title'] : ['name', 'type'],
    sorts: [
      { id: 'name', label: 'Name', value: r => (r.name || '').toLowerCase(), alpha: true },
      { id: 'status', label: 'Status', value: r => r.status || '' },
    ],
    defaultSort: 'name',
    defaultOrder: 'asc',
  });

  async function open(rec) {
    selectedId.current = rec.id;
    setSelected({ loading: true, id: rec.id });
    setOrgPeople(null);
    try {
      const d = await getContact(rec.id);
      if (selectedId.current !== rec.id) return;
      setSelected(d);
      if (d.kind === 'organization') {
        const op = await getOrganizationPeople(rec.id);
        if (selectedId.current === rec.id) setOrgPeople(op.people || []);
      }
    } catch (e) {
      if (selectedId.current === rec.id) setSelected({ error: e.message, id: rec.id });
    }
  }

  async function act(fn) {
    setBusy(true);
    try { await fn(); if (selectedId.current) await open({ id: selectedId.current }); }
    catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  const person = selected?.kind === 'person' ? selected.person : null;
  const org = selected?.kind === 'organization' ? selected.organization : null;

  return (
    <div className="c2-container">
      <aside className="c2-sidebar">
        <div className="c2-kindtabs">
          <button className={kind === 'people' ? 'active' : ''} onClick={() => { setKind('people'); setSelected(null); }}>
            People <span>{people.length.toLocaleString()}</span>
          </button>
          <button className={kind === 'organizations' ? 'active' : ''} onClick={() => { setKind('organizations'); setSelected(null); }}>
            Organizations <span>{orgs.length.toLocaleString()}</span>
          </button>
        </div>

        <ListToolbar c={controls} />

        {loading ? (
          <div className="c2-loading">{Array.from({ length: 10 }, (_, i) => <div key={i} className="c2-skeleton" />)}</div>
        ) : loadError ? (
          <div className="c2-empty">Couldn’t load contacts.<br /><span>{loadError}</span></div>
        ) : (
          <ListBody c={controls} renderItem={r => (
            <div key={r.id}
              className={`c2-row${selected?.id === r.id ? ' active' : ''}`}
              onClick={() => open(r)}>
              <div className="c2-row-name">{r.name || <em>(no name)</em>}</div>
              {kind === 'people' && r.title && <div className="c2-row-sub">{r.title}</div>}
              {kind === 'organizations' && r.parentOrganizationId && <div className="c2-row-sub">has a parent organization</div>}
            </div>
          )} />
        )}

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
            <h1>{person.displayName}</h1>
            <div className="c2-meta">
              <span className="c2-chip">Person</span>
              {person.title && <span>{person.title}</span>}
              {person.status && <span>{person.status}</span>}
              <span className="c2-id">{person.id}</span>
            </div>

            <h3>Affiliations</h3>
            {selected.affiliations.length === 0 ? (
              <p className="c2-none">Not attached to any organization.</p>
            ) : (
              <ul className="c2-affs">
                {selected.affiliations.map(a => (
                  <li key={a.id}>
                    <span className="c2-aff-org">{a.organization || a.organizationId}</span>
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

            <AddAffiliation orgs={orgs} busy={busy} onAdd={(orgId, title) => act(() => affiliate(person.id, orgId, title))} />
          </div>
        ) : org ? (
          <div className="c2-detail">
            <h1>{org.name}</h1>
            <div className="c2-meta">
              <span className="c2-chip c2-chip--org">Organization</span>
              {org.status && <span>{org.status}</span>}
              <span className="c2-id">{org.id}</span>
            </div>
            {org.parent && (
              <p className="c2-parent">Part of <strong>{org.parent.name}</strong></p>
            )}

            <h3>People {orgPeople ? `(${orgPeople.length})` : ''}</h3>
            {!orgPeople ? <p className="c2-none">Loading…</p>
              : orgPeople.length === 0 ? <p className="c2-none">Nobody attached yet.</p>
              : (
                <ul className="c2-people">
                  {orgPeople.map(p => (
                    <li key={p.affiliationId}>
                      <span className="c2-aff-org">{p.name}</span>
                      {p.title && <span className="c2-aff-title">{p.title}</span>}
                      {p.primary && <span className="c2-primary">primary</span>}
                    </li>
                  ))}
                </ul>
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

function AddAffiliation({ orgs, busy, onAdd }) {
  const [q, setQ] = useState('');
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState(null);
  const matches = q.trim().length < 2 ? [] : orgs
    .filter(o => (o.name || '').toLowerCase().includes(q.trim().toLowerCase()))
    .slice(0, 8);

  return (
    <div className="c2-addaff">
      <h3>Attach to an organization</h3>
      {picked ? (
        <div className="c2-picked">
          <strong>{picked.name}</strong>
          <input className="c2-input c2-input--inline" placeholder="Title at this organization"
            value={title} onChange={e => setTitle(e.target.value)} />
          <button className="c2-btn c2-btn--primary" disabled={busy}
            onClick={() => { onAdd(picked.id, title); setPicked(null); setQ(''); setTitle(''); }}>Attach</button>
          <button className="c2-btn" onClick={() => setPicked(null)}>Cancel</button>
        </div>
      ) : (
        <>
          <input className="c2-input" placeholder="Search organizations…" value={q} onChange={e => setQ(e.target.value)} />
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
