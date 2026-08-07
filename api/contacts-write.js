// Write Vibe's contact entities.
//
//   POST /api/contacts-write?db=…   { action, … }
//
//     create-person        { first, last, title?, status?, notes? }      → V-…
//     create-organization  { name, status?, type?, notes? }              → V-…
//     update               { id, fields }                               (kind inferred)
//     affiliate            { personId, organizationId, title?, primary? } → VA-…
//     unaffiliate          { affiliationId }
//     set-primary          { personId, affiliationId }
//     set-parent           { organizationId, parentOrganizationId|null }
//
// PHASE 2b of docs/vibe-owns-the-record.md. Writes go to Vibe only — FileMaker
// is not touched, and needs only a Google session rather than a per-user
// FileMaker account.
//
// This is what makes "add a person" possible at all. FileMaker's contacts layout
// has one name field and a type flag, which is how a person called Ryan Doak
// ended up filed as an organization and then rendered blank everywhere. Here a
// person has a first and last name because a person is its own kind of thing.
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { Redis } from '@upstash/redis';
import {
  K, parse, nextId, getEntity, putEntity, readHash, writeHash,
  reindexPerson, reindexOrg, wouldCycle, displayName,
} from './_contacts.js';

const redis = Redis.fromEnv();
const str = v => String(v ?? '').trim();

// Only fields Vibe owns can be written. An unknown key is rejected rather than
// quietly stored, so a typo shows up now instead of as a field that silently
// never displays.
const PERSON_FIELDS = new Set(['first', 'last', 'title', 'status', 'notes']);
const ORG_FIELDS = new Set(['name', 'status', 'type', 'notes', 'siteNumber']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const db = str(req.query?.db);
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const action = str(body.action);
  const stamp = { updatedAt: new Date().toISOString(), updatedBy: session.email };

  try {
    if (action === 'create-person') {
      const first = str(body.first), last = str(body.last);
      // A person with no name at all is the failure this whole phase exists to
      // stop, so it is refused rather than stored as a blank row.
      if (!first && !last) return res.status(400).json({ error: 'a person needs a first or last name' });
      const person = {
        id: await nextId(db), first, last, fmDisplay: '',
        title: str(body.title), status: str(body.status) || 'Active', notes: str(body.notes),
        qboId: '', createdAt: stamp.updatedAt, createdBy: session.email, ...stamp,
      };
      await putEntity(db, 'person', person);
      return res.status(200).json({ kind: 'person', person: { ...person, displayName: displayName(person) } });
    }

    if (action === 'create-organization') {
      const name = str(body.name);
      if (!name) return res.status(400).json({ error: 'an organization needs a name' });
      const org = {
        id: await nextId(db), name,
        status: str(body.status) || 'Active', type: str(body.type), notes: str(body.notes),
        siteNumber: str(body.siteNumber), qboId: '', parentOrganizationId: null,
        createdAt: stamp.updatedAt, createdBy: session.email, ...stamp,
      };
      await putEntity(db, 'organization', org);
      return res.status(200).json({ kind: 'organization', organization: org });
    }

    if (action === 'update') {
      const id = str(body.id);
      const { kind, entity } = await getEntity(db, id);
      if (!kind) return res.status(404).json({ error: 'no such contact' });
      const allowed = kind === 'person' ? PERSON_FIELDS : ORG_FIELDS;
      const fields = body.fields || {};
      const unknown = Object.keys(fields).filter(f => !allowed.has(f));
      if (unknown.length) return res.status(400).json({ error: `not writable on a ${kind}: ${unknown.join(', ')}` });
      if (!Object.keys(fields).length) return res.status(400).json({ error: 'fields is empty' });

      const next = { ...entity, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, str(v)])), ...stamp };
      if (kind === 'person' && !next.first && !next.last) {
        return res.status(400).json({ error: 'a person needs a first or last name' });
      }
      if (kind === 'organization' && !next.name) return res.status(400).json({ error: 'an organization needs a name' });
      await putEntity(db, kind === 'person' ? 'person' : 'organization', next);
      return res.status(200).json({ kind, entity: kind === 'person' ? { ...next, displayName: displayName(next) } : next });
    }

    if (action === 'affiliate') {
      const personId = str(body.personId), organizationId = str(body.organizationId);
      const p = await getEntity(db, personId), o = await getEntity(db, organizationId);
      if (p.kind !== 'person') return res.status(400).json({ error: 'personId is not a person' });
      if (o.kind !== 'organization') return res.status(400).json({ error: 'organizationId is not an organization' });

      const all = await readHash(K.aff(db));
      const existing = [...all.values()].find(a =>
        String(a.personId) === personId && String(a.organizationId) === organizationId);
      if (existing) return res.status(200).json({ affiliation: existing, alreadyExisted: true });

      const aff = {
        id: await nextId(db, 'VA'), personId, organizationId,
        title: str(body.title), primary: false, ...stamp,
      };
      await writeHash(K.aff(db), { [aff.id]: JSON.stringify(aff) });
      if (body.primary === true) {
        for (const a of all.values()) if (String(a.personId) === personId && a.primary) a.primary = false;
        aff.primary = true;
        const writes = { [aff.id]: JSON.stringify(aff) };
        for (const a of all.values()) if (String(a.personId) === personId) writes[a.id] = JSON.stringify(a);
        await writeHash(K.aff(db), writes);
      }
      await reindexPerson(db, personId);
      await reindexOrg(db, organizationId);
      return res.status(200).json({ affiliation: aff });
    }

    if (action === 'unaffiliate') {
      const affiliationId = str(body.affiliationId);
      const aff = parse(await redis.hget(K.aff(db), affiliationId));
      if (!aff) return res.status(404).json({ error: 'no such affiliation' });
      await redis.hdel(K.aff(db), affiliationId);
      // Reindex promotes a replacement primary if the removed one held it, so a
      // person is never left with affiliations and no primary among them.
      const remaining = await reindexPerson(db, aff.personId);
      await reindexOrg(db, aff.organizationId);
      return res.status(200).json({ removed: affiliationId, remaining: remaining.length });
    }

    if (action === 'set-primary') {
      const personId = str(body.personId), affiliationId = str(body.affiliationId);
      const all = await readHash(K.aff(db));
      const target = all.get(affiliationId);
      if (!target || String(target.personId) !== personId) {
        return res.status(400).json({ error: 'that affiliation does not belong to that person' });
      }
      const writes = {};
      for (const a of all.values()) {
        if (String(a.personId) !== personId) continue;
        const primary = a.id === affiliationId;
        if (a.primary !== primary) { a.primary = primary; writes[a.id] = JSON.stringify(a); }
      }
      if (Object.keys(writes).length) await writeHash(K.aff(db), writes);
      return res.status(200).json({ personId, primaryAffiliationId: affiliationId });
    }

    if (action === 'set-parent') {
      const organizationId = str(body.organizationId);
      const parentId = body.parentOrganizationId == null ? null : str(body.parentOrganizationId);
      const o = await getEntity(db, organizationId);
      if (o.kind !== 'organization') return res.status(400).json({ error: 'organizationId is not an organization' });
      if (parentId) {
        if (parentId === organizationId) return res.status(400).json({ error: 'an organization cannot be its own parent' });
        const parent = await getEntity(db, parentId);
        if (parent.kind !== 'organization') return res.status(400).json({ error: 'parentOrganizationId is not an organization' });
        if (await wouldCycle(db, organizationId, parentId)) {
          return res.status(400).json({ error: 'that would make the hierarchy circular' });
        }
      }
      const next = { ...o.entity, parentOrganizationId: parentId, ...stamp };
      await putEntity(db, 'organization', next);
      return res.status(200).json({ organization: next });
    }

    return res.status(400).json({ error: `unknown action "${action}"` });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
