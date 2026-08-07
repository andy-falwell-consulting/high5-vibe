// Read Vibe's contact entities.
//
//   GET /api/contacts?db=…&id=71501          → one person or organization, resolved
//   GET /api/contacts?db=…&org=69026         → an organization with its people
//   GET /api/contacts?db=…&list=people&cursor=0        → one page of people
//   GET /api/contacts?db=…&list=organizations&cursor=0 → one page of organizations
//   GET /api/contacts?db=…&stats=1           → counts, for verifying a migration
//
// Read-only. The write path and the UI come after this is proven against real
// data — see docs/contacts-model.md.
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { Redis } from '@upstash/redis';
import { K, displayName, methodList } from './_contacts.js';

const redis = Redis.fromEnv();
const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

// Contacts migrated before methods existed have no such keys at all. Filling
// them in here means the UI never has to ask whether an array is really an
// array, and no write has to backfill 15,590 records to make reads safe.
const withMethods = e => ({
  ...e,
  phones: methodList(e, 'phone'),
  emails: methodList(e, 'email'),
  addresses: methodList(e, 'address'),
});

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await getGoogleSession(req))) return res.status(401).json({ error: 'Not authenticated' });
  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  try {
    // Cursor-paged, the same shape as /api/records, so the client accumulates
    // pages until the cursor comes back '0' and then searches locally — which
    // is how every other list in this app already works.
    //
    // Deliberately NOT a maintained search index: one more thing every write
    // would have to keep in step, and the pattern that already exists here has
    // the advantage of being the one people know.
    const list = String(req.query?.list || '');
    if (list) {
      if (list !== 'people' && list !== 'organizations') {
        return res.status(400).json({ error: "list must be 'people' or 'organizations'" });
      }
      const key = list === 'people' ? K.person(db) : K.org(db);
      const [next, flat] = await redis.hscan(key, String(req.query?.cursor ?? '0'), { count: 1000 });
      const records = [];
      for (let i = 1; i < flat.length; i += 2) {
        const e = parse(flat[i]);
        if (!e) continue;
        // Phones and emails ride along so the sidebar filter can find someone
        // by number or address. The client already holds every contact, so this
        // replaces a server-side search index entirely — and as arrays they
        // both search (String() joins them) and display (take the first).
        // Web addresses are left out: nobody looks a person up by their URL.
        const contactable = {
          phones: methodList(e, 'phone').map(p => p.number).filter(Boolean),
          emails: methodList(e, 'email').filter(m => m.type !== 'Web').map(m => m.address).filter(Boolean),
        };
        records.push(list === 'people'
          ? { id: e.id, first: e.first, last: e.last, name: displayName(e), title: e.title, status: e.status, ...contactable }
          : { id: e.id, name: e.name, status: e.status, type: e.type, parentOrganizationId: e.parentOrganizationId, ...contactable });
      }
      res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
      return res.status(200).json({ list, records, cursor: String(next), count: records.length });
    }

    if (req.query?.stats) {
      const [organizations, people, affiliations] = await Promise.all([
        redis.hlen(K.org(db)), redis.hlen(K.person(db)), redis.hlen(K.aff(db)),
      ]);
      return res.status(200).json({ db, organizations, people, affiliations, report: await redis.get(K.report(db)) });
    }

    const orgId = req.query?.org && String(req.query.org);
    if (orgId) {
      const org = parse(await redis.hget(K.org(db), orgId));
      if (!org) return res.status(404).json({ error: 'no such organization' });
      const affIds = parse(await redis.hget(K.byOrg(db), orgId)) || [];
      const affs = affIds.length ? (await redis.hmget(K.aff(db), ...affIds)) : [];
      const rows = (Array.isArray(affs) ? affs : Object.values(affs || {})).map(parse).filter(Boolean);
      const people = rows.length ? (await redis.hmget(K.person(db), ...rows.map(a => a.personId))) : [];
      const byId = new Map((Array.isArray(people) ? people : Object.values(people || {}))
        .map(parse).filter(Boolean).map(p => [p.id, p]));
      const parent = org.parentOrganizationId ? parse(await redis.hget(K.org(db), org.parentOrganizationId)) : null;
      return res.status(200).json({
        organization: { ...withMethods(org), parent: parent ? { id: parent.id, name: parent.name } : null },
        people: rows.map(a => {
          const p = byId.get(a.personId);
          return { id: a.personId, name: p ? displayName(p) : null, title: a.title || p?.title || '', affiliationId: a.id, primary: !!a.primary };
        }).filter(p => p.name !== null),
      });
    }

    const id = req.query?.id && String(req.query.id);
    if (!id) return res.status(400).json({ error: 'pass id, org or stats' });

    const org = parse(await redis.hget(K.org(db), id));
    if (org) {
      const parent = org.parentOrganizationId ? parse(await redis.hget(K.org(db), org.parentOrganizationId)) : null;
      const affIds = parse(await redis.hget(K.byOrg(db), id)) || [];
      return res.status(200).json({
        kind: 'organization',
        organization: { ...withMethods(org), parent: parent ? { id: parent.id, name: parent.name } : null },
        peopleCount: affIds.length,
      });
    }

    const person = parse(await redis.hget(K.person(db), id));
    if (!person) return res.status(404).json({ error: 'no such contact' });
    const affIds = parse(await redis.hget(K.byPerson(db), id)) || [];
    const affs = affIds.length ? (await redis.hmget(K.aff(db), ...affIds)) : [];
    const rows = (Array.isArray(affs) ? affs : Object.values(affs || {})).map(parse).filter(Boolean);
    const orgs = rows.length ? (await redis.hmget(K.org(db), ...rows.map(a => a.organizationId))) : [];
    const orgById = new Map((Array.isArray(orgs) ? orgs : Object.values(orgs || {}))
      .map(parse).filter(Boolean).map(o => [o.id, o]));
    const affiliations = rows.map(a => ({
      id: a.id, organizationId: a.organizationId,
      organization: orgById.get(a.organizationId)?.name || null,
      title: a.title || '', primary: !!a.primary,
    }));
    return res.status(200).json({
      kind: 'person',
      person: { ...withMethods(person), displayName: displayName(person) },
      affiliations,
      // Null rather than a guess when nothing is marked primary.
      //
      // This used to fall back to whichever affiliation came first, which read
      // as an answer while being an arbitrary pick — fine for the 92.7% with a
      // single affiliation, misleading for the 698 people with more. Primary is
      // now something set explicitly (see contacts-write.js), so an absent one
      // means "nobody has chosen", which is worth showing as such.
      primaryOrganization: affiliations.find(a => a.primary)?.organization ?? null,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
