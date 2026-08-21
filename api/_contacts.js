// Vibe's own contact model. Files starting with _ are not Vercel routes.
//
// PHASE 2 of docs/vibe-owns-the-record.md, designed in docs/contacts-model.md.
//
// FileMaker keeps 4,751 organizations and 10,839 people in ONE table told apart
// by a boolean, linked through a join table. That single compromise is the
// shared cause of a run of bugs: a person filed as an organization, that record
// then rendering blank, Ian's CCS report, and the site-vs-organization join trap
// in CLAUDE.md. Vibe splits it into three things that can each say what they
// mean.
//
//   vibe:{db}:org      id → { name, status, parentOrganizationId, … }
//   vibe:{db}:person   id → { first, last, title, status, … }
//   vibe:{db}:aff      affiliationId → { personId, organizationId, title, primary }
//   vibe:{db}:aff:byPerson   personId → [affiliationId, …]
//   vibe:{db}:aff:byOrg      organizationId → [affiliationId, …]
//
// Ids are FileMaker's `_kpt__Contact_ID` and `_kpt__Contact_Relationship_ID`,
// kept verbatim so every existing foreign key — `_kft__Contact_ID` on projects,
// inspections, estimates — keeps resolving with nothing rewritten.
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export const K = {
  org: db => `vibe:${db}:org`,
  person: db => `vibe:${db}:person`,
  aff: db => `vibe:${db}:aff`,
  byPerson: db => `vibe:${db}:aff:byPerson`,
  byOrg: db => `vibe:${db}:aff:byOrg`,
  report: db => `vibe:${db}:contacts:report`,
};

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
export { parse };

export async function readHash(key) {
  const raw = (await redis.hgetall(key)) || {};
  const out = new Map();
  for (const [k, v] of Object.entries(raw)) { const p = parse(v); if (p) out.set(String(k), p); }
  return out;
}

// Write in chunks: HSET with 15,000 fields in one call is a request body no
// Upstash plan will accept.
export async function writeHash(key, entries) {
  const all = Object.entries(entries);
  for (let i = 0; i < all.length; i += 500) {
    await redis.hset(key, Object.fromEntries(all.slice(i, i + 500)));
  }
  return all.length;
}

// ── Shaping FileMaker rows into Vibe entities ─────────────────────

export const isOrgRow = f => f.Organization === 1 || f.Organization === '1';

// zz__* are FileMaker's own provenance stamps. Carried through both
// projections so a contact can show the same footer every other record shows —
// they were being dropped here, which is why Contacts was the one record page
// with no "created by" line rather than an oversight in the component.
const provenance = f => ({
  createdOn: f.zz__Created_On || '',
  createdBy: f.zz__Created_By || '',
  modifiedOn: f.zz__Modified_On || '',
  modifiedBy: f.zz__Modified_By || '',
});

export function toOrganization(f) {
  return {
    ...provenance(f),
    id: String(f._kpt__Contact_ID),
    name: f.Name_Organization || '',
    status: f.Status || '',
    type: f.Type || '',
    notes: f.Notes || '',
    siteNumber: f['Site Number'] || '',
    qboId: f._kaf__qbo_id || '',
    // Filled in a second pass, once every id's kind is known.
    parentOrganizationId: null,
  };
}

export function toPerson(f) {
  return {
    ...provenance(f),
    id: String(f._kpt__Contact_ID),
    first: f.Name_First || '',
    last: f.Name_Last || '',
    // Kept because it is what FileMaker displays today, so a migration can be
    // checked against it. Vibe derives its own display name from first/last.
    fmDisplay: f['zz__Display__ct'] || '',
    title: f.Title || '',
    status: f.Status || '',
    notes: f.Notes || '',
    qboId: f._kaf__qbo_id || '',
  };
}

export const displayName = p =>
  [p.first, p.last].map(s => String(s || '').trim()).filter(Boolean).join(' ') || p.fmDisplay || '';

// Fold relationship rows into affiliations and org hierarchy.
//
// The join table stores EVERY link twice, once in each direction — 10,912
// person→org rows and exactly 10,912 org→person. A naive import would create
// 21,350 affiliations where there are 10,675, so pairs are deduplicated by
// their unordered ends, keeping the lowest relationship id for stability across
// re-runs.
export function foldRelationships(rows, kindOf) {
  const affiliations = new Map();   // `${personId}|${orgId}` → { id, personId, organizationId }
  const parents = new Map();        // childOrgId → Set(parentOrgId)
  const stats = { personOrg: 0, orgOrg: 0, personPerson: 0, dangling: 0 };

  for (const r of rows) {
    const a = String(r._kft__Contact_ID || '');
    const b = String(r._kft__Contact_ID_Related || '');
    const id = String(r._kpt__Contact_Relationship_ID || '');
    const ka = kindOf(a), kb = kindOf(b);
    if (!ka || !kb) { stats.dangling++; continue; }

    if (ka !== kb) {
      const personId = ka === 'person' ? a : b;
      const organizationId = ka === 'person' ? b : a;
      const key = `${personId}|${organizationId}`;
      const prev = affiliations.get(key);
      if (!prev || id < prev.id) {
        affiliations.set(key, { id: prev ? (id < prev.id ? id : prev.id) : id, personId, organizationId });
      }
      stats.personOrg++;
    } else if (ka === 'org') {
      // Hierarchy, not a peer link: schools belong to a district. Direction is
      // not reliable in the raw rows, so it is resolved by child count below.
      if (!parents.has(a)) parents.set(a, new Set());
      if (!parents.has(b)) parents.set(b, new Set());
      parents.get(a).add(b);
      parents.get(b).add(a);
      stats.orgOrg++;
    } else {
      stats.personPerson++;
    }
  }
  return { affiliations, parents, stats };
}

// Which end of an org↔org pair is the parent?
//
// The rows carry no direction and `Relationship` is 99.94% blank, so it is
// inferred structurally: in a district-and-its-schools pair the district is the
// one with many links and the school has few. Ties are left unset rather than
// guessed — an unset parent is visibly missing, a wrong one is not.
export function resolveParents(parents) {
  const degree = new Map([...parents].map(([id, s]) => [id, s.size]));
  const resolved = new Map();
  const ambiguous = [];
  for (const [child, candidates] of parents) {
    let best = null, bestDeg = -1, tie = false;
    for (const cand of candidates) {
      const d = degree.get(cand) || 0;
      if (d > bestDeg) { best = cand; bestDeg = d; tie = false; }
      else if (d === bestDeg) tie = true;
    }
    if (best == null) continue;
    if ((degree.get(child) || 0) >= bestDeg) continue;   // this one is the parent
    if (tie) { ambiguous.push(child); continue; }
    resolved.set(child, best);
  }
  return { resolved, ambiguous };
}

export function indexAffiliations(affiliations) {
  const byPerson = {}, byOrg = {};
  for (const a of affiliations.values()) {
    (byPerson[a.personId] ??= []).push(a.id);
    (byOrg[a.organizationId] ??= []).push(a.id);
  }
  // Exactly one affiliation → it is the primary, which covers 92.7% of people
  // and keeps a single "organization" column honest for them.
  for (const a of affiliations.values()) a.primary = byPerson[a.personId].length === 1;
  return { byPerson, byOrg };
}

// ── Writes ────────────────────────────────────────────────────────
//
// Records born in Vibe get a `V-` id (`VA-` for affiliations), allocated from a
// counter. Deliberately obvious at a glance rather than blended in: FileMaker
// ids are bare integers, so anything prefixed is unambiguously Vibe's and, when
// FileMaker is retired, the set with no counterpart to reconcile.
//
// Ids are opaque STRINGS everywhere. A codebase-wide audit before this shipped
// found no numeric coercion of record ids, so nothing breaks on the prefix —
// but that property has to be preserved, not assumed.
const SEQ_START = 100000;

export async function nextId(db, prefix = 'V') {
  const n = await redis.incr(`vibe:${db}:seq:contact`);
  return `${prefix}-${SEQ_START + n}`;
}

export const isVibeId = id => /^V[A]?-/.test(String(id));

// Deleting a contact that came from FileMaker has to be REMEMBERED, not just
// done. Its FileMaker row still exists and `step=contacts` writes every row it
// reads, so without this the next migration run would faithfully restore
// someone deliberately removed. Same shape as the file store's tombstones
// (api/_vibeFiles.js), which hit this first.
export const contactTombKey = db => `vibe:${db}:contact:deleted`;
export const tombstoneContact = (db, id) => redis.sadd(contactTombKey(db), String(id));
export const contactTombstones = db => redis.smembers(contactTombKey(db));
export const untombstoneContact = (db, id) => redis.srem(contactTombKey(db), String(id));

// ── Contact methods: phones, emails and addresses ─────────────────
//
// Stored as arrays ON the contact, not as their own keyspaces. Unlike an
// affiliation — which joins two things that each exist independently — a phone
// number belongs to exactly one contact, has no identity apart from it, and is
// never read without it. Embedding means one read returns everything, there is
// no index for a write to fall out of step with, and an orphan row cannot
// exist. FileMaker's own separate tables are an artefact of the relational
// model, not something the data requires.
//
// The trade accepted: editing one phone rewrites the contact record, and
// "who has this number" is a scan. Both are fine at 15,590 contacts.
export const METHODS = {
  phone: { field: 'phones', keys: ['type', 'number', 'ext'], required: 'number' },
  email: { field: 'emails', keys: ['type', 'address'], required: 'address' },
  address: {
    field: 'addresses',
    keys: ['type', 'street', 'city', 'state', 'zip', 'country'],
    // An address with only a type is not an address. Any one line will do,
    // because plenty of real ones are a PO box or a city with no street.
    required: ['street', 'city', 'state', 'zip'],
  },
};

export const methodList = (entity, kind) => {
  const v = entity?.[METHODS[kind].field];
  return Array.isArray(v) ? v : [];
};

// Every method carries an id so the UI can edit one without rewriting the rest.
// Migrated rows keep FileMaker's own `_kpt__` value; ones born here get `VM-`.
export async function nextMethodId(db) {
  return nextId(db, 'VM');
}

export async function getEntity(db, id) {
  const [org, person] = await Promise.all([
    redis.hget(K.org(db), String(id)),
    redis.hget(K.person(db), String(id)),
  ]);
  if (org) return { kind: 'organization', entity: parse(org) };
  if (person) return { kind: 'person', entity: parse(person) };
  return { kind: null, entity: null };
}

export async function putEntity(db, kind, entity) {
  const key = kind === 'organization' ? K.org(db) : K.person(db);
  await redis.hset(key, { [entity.id]: JSON.stringify(entity) });
  return entity;
}

// Rebuild one person's affiliation index and settle which is primary.
//
// Primary is STORED, not inferred at read time. The migration guessed it for
// anyone with a single affiliation, and the read endpoint used to fall back to
// "whichever came first" for everyone else — which presented an arbitrary pick
// as an answer. Here the rule is explicit: an existing primary is kept, and if
// there is none the sole (or first) affiliation becomes it.
export async function reindexPerson(db, personId) {
  const all = await readHash(K.aff(db));
  const mine = [...all.values()].filter(a => String(a.personId) === String(personId));
  if (!mine.length) {
    await redis.hdel(K.byPerson(db), String(personId));
    return [];
  }
  if (!mine.some(a => a.primary)) mine[0].primary = true;
  const writes = {};
  for (const a of mine) writes[a.id] = JSON.stringify(a);
  await writeHash(K.aff(db), writes);
  await redis.hset(K.byPerson(db), { [String(personId)]: JSON.stringify(mine.map(a => a.id)) });
  return mine;
}

// The byOrg array is the ORDER an organization's people are shown in, and that
// order is dragged by hand (see the reorder-org-people action). So this
// preserves it: ids already stored keep their positions, newly affiliated
// people are appended, and people no longer affiliated drop out. Rebuilding the
// array from the hash — which is what this used to do — silently threw the
// team's ordering away the next time anyone was attached or detached.
export async function reindexOrg(db, organizationId) {
  const all = await readHash(K.aff(db));
  const live = new Set([...all.values()]
    .filter(a => String(a.organizationId) === String(organizationId))
    .map(a => String(a.id)));

  const stored = parse(await redis.hget(K.byOrg(db), String(organizationId))) || [];
  const kept = stored.map(String).filter(id => live.has(id));
  const seen = new Set(kept);
  const ids = [...kept, ...[...live].filter(id => !seen.has(id))];

  if (ids.length) await redis.hset(K.byOrg(db), { [String(organizationId)]: JSON.stringify(ids) });
  else await redis.hdel(K.byOrg(db), String(organizationId));
  return ids;
}

// Store an explicit order for one organization's people. Only ids that really
// belong to the organization are accepted, and any it holds that the caller
// omitted are appended rather than dropped — a stale client must not be able to
// delete affiliations by sending a short list.
export async function setOrgPeopleOrder(db, organizationId, affiliationIds) {
  const all = await readHash(K.aff(db));
  const live = new Set([...all.values()]
    .filter(a => String(a.organizationId) === String(organizationId))
    .map(a => String(a.id)));

  const wanted = [];
  const seen = new Set();
  for (const id of affiliationIds || []) {
    const s = String(id);
    if (!live.has(s) || seen.has(s)) continue;
    seen.add(s); wanted.push(s);
  }
  const ids = [...wanted, ...[...live].filter(id => !seen.has(id))];
  if (ids.length) await redis.hset(K.byOrg(db), { [String(organizationId)]: JSON.stringify(ids) });
  return ids;
}

// Walking up rather than trusting the input: an organization made its own
// ancestor would make every "all work for this district" query loop forever.
export async function wouldCycle(db, childId, parentId) {
  let cursor = String(parentId);
  const seen = new Set([String(childId)]);
  for (let i = 0; i < 50 && cursor; i++) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    const org = parse(await redis.hget(K.org(db), cursor));
    cursor = org?.parentOrganizationId ? String(org.parentOrganizationId) : null;
  }
  return false;
}
