import { useEffect, useState } from 'react';
import { getAllRecords, subscribeCacheUpdates } from '../api/filemaker';
import { RELATED_SOURCES, isVibeMintedId } from '../config/relatedRecords';

// The five module caches, loaded once and shared by every contact opened after,
// so opening a contact never costs five reads. App.jsx has already prewarmed
// all of them, so the first load is served warm too.
//
// The memo SUBSCRIBES rather than snapshotting. Holding the array from the
// first read would mean an inspection edited in its own module still showed its
// old date here until a reload — which is the staleness this whole approach
// exists to remove, reintroduced one level up. subscribeCacheUpdates fires on
// patchCachedRecord, so the memo tracks the same cache the modules do, and
// `revision` lets an open contact recompute instead of waiting to be reopened.
const cache = new Map();      // layout -> records
const inflight = new Map();   // layout -> promise
const subscribed = new Set(); // layout
const listeners = new Set();
let revision = 0;

function bump() {
  revision++;
  for (const fn of listeners) fn(revision);
}

function watch(src) {
  if (subscribed.has(src.layout)) return;
  subscribed.add(src.layout);
  subscribeCacheUpdates(src.layout, src.cv, records => {
    cache.set(src.layout, records);
    bump();
  });
}

function load(src) {
  watch(src);
  if (cache.has(src.layout)) return Promise.resolve(cache.get(src.layout));
  if (inflight.has(src.layout)) return inflight.get(src.layout);
  const p = getAllRecords(src.layout, { cacheVersion: src.cv, batchSize: 100 })
    .then(r => {
      const records = r?.records || [];
      cache.set(src.layout, records);
      inflight.delete(src.layout);
      return records;
    })
    .catch(() => { inflight.delete(src.layout); return []; });
  inflight.set(src.layout, p);
  return p;
}

const norm = s => String(s ?? '').trim().toLowerCase();

// Which ids and names count as "this contact's".
//
// For an organization both matter, and neither is redundant. The id catches
// records that carry a proper foreign key. The name catches the case the id
// cannot: an inspection hangs off a separate *site* contact whose id differs
// from the organization a picker returns, but which carries the same
// organization name — the join trap in CLAUDE.md. On Inspections_New the FK is
// populated on only 42% of records, so dropping the name match would lose more
// than half of them.
//
// Child organizations are included because Vibe stores the school↔district
// hierarchy as a parent link: a district's own record holds no inspections, its
// schools do. Rows name their organization, and the caller is told how many
// children contributed, so a district's list stays readable rather than
// looking like its own.
function scopeFor(contact, orgs) {
  if (contact?.kind !== 'organization') {
    const id = contact?.person?.id;
    return { ids: id ? new Set([String(id)]) : new Set(), names: new Set(), children: 0 };
  }
  const org = contact.organization;
  const ids = new Set([String(org.id)]);
  const names = new Set([norm(org.name)].filter(Boolean));
  let children = 0;
  for (const o of orgs || []) {
    if (String(o.parentOrganizationId ?? '') !== String(org.id)) continue;
    ids.add(String(o.id));
    if (norm(o.name)) names.add(norm(o.name));
    children++;
  }
  return { ids, names, children };
}

export function useRelatedRecords(contact, orgs) {
  // Keyed by the contact it describes, so switching records reads as loading
  // without an effect having to reset it first. Setting state synchronously in
  // an effect triggers cascading renders (and the lint rule that says so), and
  // the empty and Vibe-minted cases need no state at all — they are facts about
  // the id, knowable during render.
  const [result, setResult] = useState(null);
  // Re-runs the filter when a module patches its cache, so a record edited
  // elsewhere in the app updates here without the contact being reopened.
  const [rev, setRev] = useState(0);
  useEffect(() => {
    listeners.add(setRev);
    return () => { listeners.delete(setRev); };
  }, []);

  const contactId = contact?.kind === 'organization' ? contact.organization?.id : contact?.person?.id;
  const kind = contact?.kind;
  // Nothing in FileMaker can belong to a contact FileMaker never had.
  const minted = contactId ? isVibeMintedId(contactId) : false;

  useEffect(() => {
    if (!contactId || minted) return undefined;

    let alive = true;

    Promise.all(RELATED_SOURCES.map(src => load(src).then(records => ({ src, records }))))
      .then(loaded => {
        if (!alive) return;
        const { ids, names, children } = scopeFor(contact, orgs);
        const groups = loaded.map(({ src, records }) => {
          const rows = records.filter(r => {
            const f = r.fieldData || {};
            const fk = String(f[src.fk] ?? '').trim();
            if (fk && ids.has(fk)) return true;
            // Only organizations match on a name — for a person, "its own" is
            // exactly what the foreign key says, and a name match would pull in
            // an organization's whole history under one employee.
            if (kind !== 'organization') return false;
            const on = norm(src.org(f));
            return !!on && names.has(on);
          });
          // Newest first: these read as a history, and the useful end is the
          // recent one. Undated rows sort last rather than sorting as epoch 0.
          rows.sort((a, b) => {
            const da = Date.parse(src.date(a.fieldData || {}) || '');
            const db = Date.parse(src.date(b.fieldData || {}) || '');
            if (isNaN(da) && isNaN(db)) return 0;
            if (isNaN(da)) return 1;
            if (isNaN(db)) return -1;
            return db - da;
          });
          return { src, rows };
        });
        setResult({ key: contactId, groups, children });
      })
      .catch(() => { if (alive) setResult({ key: contactId, groups: null, children: 0 }); });

    return () => { alive = false; };
  }, [contactId, kind, orgs, minted, rev]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!contactId) return { loading: false, groups: null };
  if (minted) return { loading: false, groups: RELATED_SOURCES.map(s => ({ src: s, rows: [] })), minted: true };
  // A result for the previously open contact is not this contact's answer.
  if (!result || result.key !== contactId) return { loading: true, groups: null };
  return { loading: false, groups: result.groups, children: result.children };
}

// 19 organization names are shared by more than one organization (39 records,
// 0.8%). Where a contact sits on one of those, its lists can legitimately
// include another organization's work — so the reader is told, rather than the
// overlap being left to look like fact.
export function sharedNameCount(org, orgs) {
  if (!org?.name) return 0;
  const n = norm(org.name);
  return (orgs || []).filter(o => norm(o.name) === n && String(o.id) !== String(org.id)).length;
}
