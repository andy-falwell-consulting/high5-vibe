// Read Vibe's contact entities.
//
//   GET /api/contacts?db=…&id=71501          → one person or organization, resolved
//   GET /api/contacts?db=…&org=69026         → an organization with its people
//   GET /api/contacts?db=…&stats=1           → counts, for verifying a migration
//
// Read-only. The write path and the UI come after this is proven against real
// data — see docs/contacts-model.md.
import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { Redis } from '@upstash/redis';
import { K, displayName } from './_contacts.js';

const redis = Redis.fromEnv();
const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await getGoogleSession(req))) return res.status(401).json({ error: 'Not authenticated' });
  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  try {
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
        organization: { ...org, parent: parent ? { id: parent.id, name: parent.name } : null },
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
        organization: { ...org, parent: parent ? { id: parent.id, name: parent.name } : null },
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
      person: { ...person, displayName: displayName(person) },
      affiliations,
      // The single value 92.7% of people have, without discarding the rest.
      primaryOrganization: affiliations.find(a => a.primary)?.organization ?? affiliations[0]?.organization ?? null,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
