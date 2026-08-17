// Build Vibe's contact entities from FileMaker.
//
//   POST /api/contacts-migrate?db=…&step=contacts&offset=1   → one page of contacts
//   POST /api/contacts-migrate?db=…&step=relationships&offset=1
//   POST /api/contacts-migrate?db=…&step=finish              → fold, index, report
//   POST /api/contacts-migrate?db=…&step=phones&offset=1     → one page of phones
//   POST /api/contacts-migrate?db=…&step=emails&offset=1
//   POST /api/contacts-migrate?db=…&step=addresses&offset=1
//   POST /api/contacts-migrate?db=…&step=methods-finish      → fold onto contacts
//   GET  /api/contacts-migrate?db=…                          → the last report
//
// Driven a page at a time from the client, for the same reason the backup
// export is: paging 15,590 contacts and 23,302 relationship rows out of the
// FileMaker Data API takes several minutes, well past Vercel's 300s ceiling.
// Per-page calls are resumable, show real progress, and keep peak memory to one
// page.
//
// Re-runnable. Every step overwrites by id, and `finish` rebuilds the derived
// affiliations and indexes from scratch, so a partial run is fixed by running
// it again rather than by cleaning up.
import { fmpToken, ALLOWED_DBS } from './_fmp.js';
import { getGoogleSession } from './_googleSession.js';
import { isAdminEmail } from './_admin.js';
import { Redis } from '@upstash/redis';
import {
  K, readHash, writeHash, isOrgRow, toOrganization, toPerson,
  foldRelationships, resolveParents, indexAffiliations, isVibeId, contactTombstones,
} from './_contacts.js';

const redis = Redis.fromEnv();
const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const PAGE = 1000;

const CONTACTS_LAYOUT = 'Contacts_New_vibe';   // has Name_First / Name_Last
const RELATIONS_LAYOUT = 'Contact_rltn';       // base table is the join itself

// Raw relationship rows are staged rather than folded page by page: the
// deduplication and the parent/child inference both need the WHOLE set, and the
// kind of each end is only known once every contact has been classified.
const stageKey = db => `vibe:${db}:contacts:staged_rels`;
const methodKey = (db, kind) => `vibe:${db}:contacts:staged_${kind}`;

// The three child tables. Andy placed every field on a layout per table
// (2026-08-07); before that they had only script-use layouts carrying no fields
// at all, so the API could count 36,663 rows and read none of them.
const METHOD_STEPS = {
  phones: { layout: 'Phones_vibe', kind: 'phone' },
  emails: { layout: 'Emails_vibe', kind: 'email' },
  addresses: { layout: 'Addresses_vibe', kind: 'address' },
};
const METHOD_FIELD = { phone: 'phones', email: 'emails', address: 'addresses' };

const s = v => String(v ?? '').trim();

// FileMaker's own `_kpt__` id is kept as the method id, so a re-run overwrites
// rather than duplicates, and a row stays traceable to the record it came from.
function toMethodRow(kind, f) {
  const base = { contactId: s(f._kft__Contact_ID), sort: s(f.Sort_Order) };
  if (kind === 'phone') {
    return { ...base, method: { id: s(f._kpt__Phone_ID), type: s(f.Type), number: s(f.Number) } };
  }
  if (kind === 'email') {
    return { ...base, method: { id: s(f._kpt__Internet_Address_ID), type: s(f.Type), address: s(f.Address) } };
  }
  return {
    ...base,
    method: {
      id: s(f._kpt__Address_ID), type: s(f.Type), street: s(f.Street),
      city: s(f.City), state: s(f.State), zip: s(f.Zip), country: s(f.Country),
    },
  };
}

async function fmPage(db, layout, offset, token) {
  const r = await fetch(
    `${FMP_HOST}/fmi/data/v2/databases/${db}/layouts/${encodeURIComponent(layout)}/records?_limit=${PAGE}&_offset=${offset}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const j = await r.json().catch(() => ({}));
  return { rows: j?.response?.data || [], total: j?.response?.dataInfo?.foundCount ?? null, msg: j?.messages?.[0]?.message };
}

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'Admins only.' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  if (req.method === 'GET') {
    return res.status(200).json((await redis.get(K.report(db))) || { note: 'no migration has run for this database' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const step = String(req.query?.step || '');
  const offset = Math.max(1, Number(req.query?.offset) || 1);

  try {
    const token = await fmpToken(db);

    if (step === 'contacts') {
      const { rows, total, msg } = await fmPage(db, CONTACTS_LAYOUT, offset, token);
      if (!rows.length) return res.status(200).json({ step, offset, done: true, total, msg });
      // A contact deleted in Vibe still has its FileMaker row, and this step
      // writes every row it reads — so without checking, a re-run would restore
      // it. `ignoreTombstones=1` is the way back from a mistaken delete.
      const deleted = req.query?.ignoreTombstones ? new Set() : new Set((await contactTombstones(db)).map(String));
      const orgs = {}, people = {};
      let tombstoned = 0;
      for (const r of rows) {
        const f = r.fieldData;
        if (!f._kpt__Contact_ID) continue;
        if (deleted.has(String(f._kpt__Contact_ID))) { tombstoned++; continue; }
        if (isOrgRow(f)) orgs[String(f._kpt__Contact_ID)] = JSON.stringify(toOrganization(f));
        else people[String(f._kpt__Contact_ID)] = JSON.stringify(toPerson(f));
      }
      if (Object.keys(orgs).length) await writeHash(K.org(db), orgs);
      if (Object.keys(people).length) await writeHash(K.person(db), people);
      return res.status(200).json({
        step, offset, total, read: rows.length,
        organizations: Object.keys(orgs).length, people: Object.keys(people).length, tombstoned,
        nextOffset: offset + rows.length, done: rows.length < PAGE,
      });
    }

    if (step === 'relationships') {
      const { rows, total, msg } = await fmPage(db, RELATIONS_LAYOUT, offset, token);
      if (!rows.length) return res.status(200).json({ step, offset, done: true, total, msg });
      if (offset === 1) await redis.del(stageKey(db));
      const staged = {};
      for (const r of rows) {
        const f = r.fieldData;
        const id = String(f._kpt__Contact_Relationship_ID || r.recordId);
        staged[id] = JSON.stringify({
          _kpt__Contact_Relationship_ID: id,
          _kft__Contact_ID: String(f._kft__Contact_ID || ''),
          _kft__Contact_ID_Related: String(f._kft__Contact_ID_Related || ''),
        });
      }
      await writeHash(stageKey(db), staged);
      return res.status(200).json({ step, offset, total, read: rows.length, nextOffset: offset + rows.length, done: rows.length < PAGE });
    }

    // ── Phones, emails and addresses ──────────────────────────────
    //
    // Staged like relationships rather than written per page, because the rows
    // land ON the contact: writing them a page at a time would mean reading and
    // rewriting the same contact once per phone it owns.
    if (METHOD_STEPS[step]) {
      const { layout, kind } = METHOD_STEPS[step];
      const { rows, total, msg } = await fmPage(db, layout, offset, token);
      if (!rows.length) return res.status(200).json({ step, offset, done: true, total, msg });
      if (offset === 1) await redis.del(methodKey(db, kind));
      const staged = {};
      let orphan = 0;
      for (const r of rows) {
        const row = toMethodRow(kind, r.fieldData);
        // No contact id means nothing can own it. 2,915 rows across the three
        // tables are in this state; they are counted, not silently dropped.
        if (!row.contactId) { orphan++; continue; }
        staged[row.method.id] = JSON.stringify(row);
      }
      if (Object.keys(staged).length) await writeHash(methodKey(db, kind), staged);
      return res.status(200).json({
        step, offset, total, read: rows.length, staged: Object.keys(staged).length, orphan,
        nextOffset: offset + rows.length, done: rows.length < PAGE,
      });
    }

    if (step === 'methods-finish') {
      const orgs = await readHash(K.org(db));
      const people = await readHash(K.person(db));
      const report = { db, at: new Date().toISOString(), by: session.email, kinds: {} };
      const touched = new Map();   // contactId → { phones, emails, addresses }

      for (const [kind, field] of Object.entries(METHOD_FIELD)) {
        const staged = await readHash(methodKey(db, kind));
        let dangling = 0;
        for (const row of staged.values()) {
          const id = String(row.contactId);
          if (!orgs.has(id) && !people.has(id)) { dangling++; continue; }
          if (!touched.has(id)) touched.set(id, {});
          const bucket = touched.get(id);
          (bucket[field] ??= []).push(row);
        }
        report.kinds[kind] = { staged: staged.size, dangling };
      }

      // Sort_Order is what FileMaker displays by; the row id breaks ties so a
      // re-run produces the same order rather than whatever the hash yielded.
      const ordered = rows => rows
        .sort((a, b) => (Number(a.sort || 0) - Number(b.sort || 0)) || String(a.method.id).localeCompare(String(b.method.id)))
        .map(r => r.method);

      const orgWrites = {}, personWrites = {};
      let contactsUpdated = 0;
      for (const [id, buckets] of touched) {
        const isOrg = orgs.has(id);
        const entity = isOrg ? orgs.get(id) : people.get(id);
        const next = { ...entity };
        for (const field of Object.values(METHOD_FIELD)) {
          const fromFm = ordered(buckets[field] || []);
          // Anything added in Vibe carries a VM- id and is kept. Only the rows
          // this migration owns are replaced, so re-running it never destroys a
          // number somebody typed into the app.
          const mine = (Array.isArray(entity[field]) ? entity[field] : []).filter(m => isVibeId(m.id));
          next[field] = [...fromFm, ...mine];
        }
        (isOrg ? orgWrites : personWrites)[id] = JSON.stringify(next);
        contactsUpdated++;
      }
      if (Object.keys(orgWrites).length) await writeHash(K.org(db), orgWrites);
      if (Object.keys(personWrites).length) await writeHash(K.person(db), personWrites);
      for (const kind of Object.keys(METHOD_FIELD)) await redis.del(methodKey(db, kind));

      report.contactsUpdated = contactsUpdated;
      report.organizations = Object.keys(orgWrites).length;
      report.people = Object.keys(personWrites).length;
      await redis.set(K.report(db) + ':methods', report);
      return res.status(200).json(report);
    }

    if (step === 'finish') {
      const orgs = await readHash(K.org(db));
      const people = await readHash(K.person(db));
      const staged = await readHash(stageKey(db));
      const kindOf = id => (orgs.has(id) ? 'org' : people.has(id) ? 'person' : null);

      const { affiliations, parents, stats } = foldRelationships([...staged.values()], kindOf);
      const { resolved, ambiguous } = resolveParents(parents);
      const { byPerson, byOrg } = indexAffiliations(affiliations);

      // Parent links live on the organization record itself, so reading an org
      // never needs a second lookup to know its district.
      const orgUpdates = {};
      for (const [id, org] of orgs) {
        const parent = resolved.get(id) ?? null;
        if (org.parentOrganizationId !== parent) orgUpdates[id] = JSON.stringify({ ...org, parentOrganizationId: parent });
      }
      if (Object.keys(orgUpdates).length) await writeHash(K.org(db), orgUpdates);

      await redis.del(K.aff(db), K.byPerson(db), K.byOrg(db));
      await writeHash(K.aff(db), Object.fromEntries([...affiliations.values()].map(a => [a.id, JSON.stringify(a)])));
      await writeHash(K.byPerson(db), Object.fromEntries(Object.entries(byPerson).map(([k, v]) => [k, JSON.stringify(v)])));
      await writeHash(K.byOrg(db), Object.fromEntries(Object.entries(byOrg).map(([k, v]) => [k, JSON.stringify(v)])));
      await redis.del(stageKey(db));

      const affCounts = Object.values(byPerson).map(a => a.length);
      const report = {
        db, at: new Date().toISOString(), by: session.email,
        organizations: orgs.size,
        people: people.size,
        relationshipRowsRead: staged.size,
        affiliations: affiliations.size,
        peopleWithAffiliation: Object.keys(byPerson).length,
        peopleWithNone: people.size - Object.keys(byPerson).length,
        peopleWithMultiple: affCounts.filter(n => n > 1).length,
        mostAffiliations: affCounts.length ? Math.max(...affCounts) : 0,
        organizationsWithParent: resolved.size,
        // Left unset rather than guessed: an org whose parent could not be
        // inferred is visibly missing one, which a wrong parent would not be.
        parentAmbiguous: ambiguous.length,
        edgeKinds: stats,
      };
      await redis.set(K.report(db), report);
      return res.status(200).json(report);
    }

    return res.status(400).json({
      error: `step must be one of contacts, relationships, finish, ${Object.keys(METHOD_STEPS).join(', ')}, methods-finish`,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
