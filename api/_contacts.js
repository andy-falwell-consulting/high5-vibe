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

export function toOrganization(f) {
  return {
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
