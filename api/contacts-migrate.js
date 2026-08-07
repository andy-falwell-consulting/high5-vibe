// Build Vibe's contact entities from FileMaker.
//
//   POST /api/contacts-migrate?db=…&step=contacts&offset=1   → one page of contacts
//   POST /api/contacts-migrate?db=…&step=relationships&offset=1
//   POST /api/contacts-migrate?db=…&step=finish              → fold, index, report
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
  foldRelationships, resolveParents, indexAffiliations,
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
      const orgs = {}, people = {};
      for (const r of rows) {
        const f = r.fieldData;
        if (!f._kpt__Contact_ID) continue;
        if (isOrgRow(f)) orgs[String(f._kpt__Contact_ID)] = JSON.stringify(toOrganization(f));
        else people[String(f._kpt__Contact_ID)] = JSON.stringify(toPerson(f));
      }
      if (Object.keys(orgs).length) await writeHash(K.org(db), orgs);
      if (Object.keys(people).length) await writeHash(K.person(db), people);
      return res.status(200).json({
        step, offset, total, read: rows.length,
        organizations: Object.keys(orgs).length, people: Object.keys(people).length,
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

    return res.status(400).json({ error: "step must be 'contacts', 'relationships' or 'finish'" });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
