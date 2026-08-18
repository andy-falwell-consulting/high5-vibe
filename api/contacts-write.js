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
//     add-method           { contactId, kind: phone|email|address, fields }  → VM-…
//     update-method        { contactId, kind, methodId, fields }
//     remove-method        { contactId, kind, methodId }
//     reorder-methods      { contactId, kind, order: [methodId, …] }
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
import { normalisePhoneInput } from './_phone.js';
import {
  K, parse, nextId, getEntity, putEntity, readHash, writeHash,
  reindexPerson, reindexOrg, setOrgPeopleOrder, wouldCycle, displayName, isVibeId,
  METHODS, methodList, nextMethodId, tombstoneContact,
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
        qboId: '', phones: [], emails: [], addresses: [],
        createdAt: stamp.updatedAt, createdBy: session.email, ...stamp,
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
        phones: [], emails: [], addresses: [],
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

    // ── Contact methods ───────────────────────────────────────────
    //
    // Read-modify-write on the server rather than letting the client post the
    // whole array back. The client's copy can be stale, and a stale array
    // silently deletes whatever someone else added since it was read.
    if (action === 'add-method' || action === 'update-method' || action === 'remove-method') {
      const contactId = str(body.contactId);
      const kind = str(body.kind);
      const spec = METHODS[kind];
      if (!spec) return res.status(400).json({ error: `kind must be one of ${Object.keys(METHODS).join(', ')}` });

      const { kind: entityKind, entity } = await getEntity(db, contactId);
      if (!entityKind) return res.status(404).json({ error: 'no such contact' });
      const list = methodList(entity, kind);

      let next;
      if (action === 'remove-method') {
        const methodId = str(body.methodId);
        if (!list.some(m => String(m.id) === methodId)) {
          return res.status(404).json({ error: `no such ${kind} on this contact` });
        }
        next = list.filter(m => String(m.id) !== methodId);
      } else {
        const fields = body.fields || {};
        const unknown = Object.keys(fields).filter(f => !spec.keys.includes(f));
        if (unknown.length) return res.status(400).json({ error: `not part of a ${kind}: ${unknown.join(', ')}` });
        // An update carrying nothing writable is a caller bug, not a no-op to
        // wave through. Answering 200 to one hid a bulk repair of 102 phone
        // numbers that silently did nothing — every call reported success and
        // not a single record changed. `update` has had this guard all along.
        if (action === 'update-method' && !Object.keys(fields).length) {
          return res.status(400).json({ error: 'fields is empty' });
        }

        if (action === 'add-method') {
          const row = { id: await nextMethodId(db) };
          for (const k of spec.keys) row[k] = str(fields[k]);
          // Stored E.164, with the extension its own field — including one
          // typed inline as 'x261', which is how all 1,390 existing ones are
          // written. Normalising here rather than in the browser means a
          // number arrives in the same shape however it was sent.
          if (kind === 'phone') Object.assign(row, normalisePhoneInput(row.number, row.ext));
          const missing = Array.isArray(spec.required)
            ? !spec.required.some(k => row[k])
            : !row[spec.required];
          if (missing) {
            return res.status(400).json({
              error: Array.isArray(spec.required)
                ? `an address needs at least one of ${spec.required.join(', ')}`
                : `a ${kind} needs a ${spec.required}`,
            });
          }
          next = [...list, row];
        } else {
          const methodId = str(body.methodId);
          const current = list.find(m => String(m.id) === methodId);
          if (!current) return res.status(404).json({ error: `no such ${kind} on this contact` });
          const row = { ...current };
          for (const k of Object.keys(fields)) row[k] = str(fields[k]);
          if (kind === 'phone') Object.assign(row, normalisePhoneInput(row.number, row.ext));
          const missing = Array.isArray(spec.required)
            ? !spec.required.some(k => row[k])
            : !row[spec.required];
          if (missing) {
            return res.status(400).json({
              error: Array.isArray(spec.required)
                ? `an address needs at least one of ${spec.required.join(', ')}`
                : `a ${kind} needs a ${spec.required}`,
            });
          }
          next = list.map(m => (String(m.id) === methodId ? row : m));
        }
      }

      const updated = { ...entity, [spec.field]: next, ...stamp };
      await putEntity(db, entityKind === 'person' ? 'person' : 'organization', updated);
      return res.status(200).json({ contactId, kind, [spec.field]: next });
    }

    // Drag-to-sort for a contact's own phones/emails/addresses — same shape as
    // reorder-org-people, but the order lives directly in the array (no byOrg
    // index to consult) since a method belongs to exactly one contact.
    // Non-destructive like that one too: an id the caller omitted is appended
    // rather than dropped, so a stale client can't delete a method by sending a
    // short list.
    if (action === 'reorder-methods') {
      const contactId = str(body.contactId);
      const kind = str(body.kind);
      const spec = METHODS[kind];
      if (!spec) return res.status(400).json({ error: `kind must be one of ${Object.keys(METHODS).join(', ')}` });
      if (!Array.isArray(body.order)) return res.status(400).json({ error: 'order must be an array' });

      const { kind: entityKind, entity } = await getEntity(db, contactId);
      if (!entityKind) return res.status(404).json({ error: 'no such contact' });
      const list = methodList(entity, kind);
      const byId = new Map(list.map(m => [String(m.id), m]));

      const wanted = [];
      const seen = new Set();
      for (const id of body.order) {
        const s = str(id);
        if (!byId.has(s) || seen.has(s)) continue;
        seen.add(s); wanted.push(byId.get(s));
      }
      const next = [...wanted, ...list.filter(m => !seen.has(String(m.id)))];

      const updated = { ...entity, [spec.field]: next, ...stamp };
      await putEntity(db, entityKind === 'person' ? 'person' : 'organization', updated);
      return res.status(200).json({ contactId, kind, [spec.field]: next });
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
      // Report what was STORED. reindexPerson promotes a first affiliation to
      // primary, so returning the pre-reindex copy told the caller primary was
      // false when it had just been set true.
      const settled = await reindexPerson(db, personId);
      await reindexOrg(db, organizationId);
      return res.status(200).json({ affiliation: settled.find(a => a.id === aff.id) || aff });
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

    // Drag-to-sort for the people shown on an organization. The order lives in
    // the byOrg index that already drives the read, so this needs no new field
    // and no new store — only that reindexOrg stopped discarding it.
    if (action === 'reorder-org-people') {
      const organizationId = str(body.organizationId);
      const o = await getEntity(db, organizationId);
      if (o.kind !== 'organization') return res.status(400).json({ error: 'organizationId is not an organization' });
      if (!Array.isArray(body.affiliationIds)) return res.status(400).json({ error: 'affiliationIds must be an array' });
      const order = await setOrgPeopleOrder(db, organizationId, body.affiliationIds);
      return res.status(200).json({ organizationId, order });
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

    if (action === 'delete') {
      const id = str(body.id);
      const { kind, entity } = await getEntity(db, id);
      if (!kind) return res.status(404).json({ error: 'no such contact' });
      const all = await readHash(K.aff(db));
      const mine = [...all.values()].filter(a =>
        String(a.personId) === id || String(a.organizationId) === id);
      for (const a of mine) await redis.hdel(K.aff(db), a.id);
      // Reindex every counterpart, so no index is left pointing at a gone id.
      for (const pid of new Set(mine.map(a => String(a.personId)))) await reindexPerson(db, pid);
      for (const oid of new Set(mine.map(a => String(a.organizationId)))) await reindexOrg(db, oid);
      await redis.hdel(kind === 'person' ? K.person(db) : K.org(db), id);
      await redis.hdel(kind === 'person' ? K.byPerson(db) : K.byOrg(db), id);
      // A record born in Vibe has nothing to come back from, so only a
      // FileMaker-derived one is remembered.
      if (!isVibeId(id)) await tombstoneContact(db, id);

      // An organization that was somebody's parent would leave that child
      // pointing at nothing, which reads as "part of" with a blank name.
      let orphanedChildren = 0;
      if (kind === 'organization') {
        const orgs = await readHash(K.org(db));
        const writes = {};
        for (const o of orgs.values()) {
          if (String(o.parentOrganizationId ?? '') === id) {
            writes[o.id] = JSON.stringify({ ...o, parentOrganizationId: null, ...stamp });
            orphanedChildren++;
          }
        }
        if (orphanedChildren) await writeHash(K.org(db), writes);
      }

      return res.status(200).json({
        deleted: id, kind, affiliationsRemoved: mine.length, orphanedChildren,
        tombstoned: !isVibeId(id),
        was: entity?.name || displayName(entity || {}),
      });
    }

    return res.status(400).json({ error: `unknown action "${action}"` });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
