import { getCurrentEnv } from '../config/fmpEnvironments';

// Client for Vibe's own contact entities (api/contacts*.js).
//
// Separate from src/api/filemaker.js on purpose: these records are not
// FileMaker's, do not go through the replica, and have no fieldData shape. Two
// stores that behave differently should not share one module — that conflation
// is what produced the Kanban bugs.

const qs = extra => `db=${encodeURIComponent(getCurrentEnv().db)}${extra ? `&${extra}` : ''}`;

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// Pages until the cursor returns '0', the same way the replica read does. The
// caller then searches locally, which is how every other list in this app works.
async function listAll(kind, onProgress) {
  const out = [];
  let cursor = '0';
  let pages = 0;
  do {
    const body = await json(await fetch(`/api/contacts?${qs(`list=${kind}&cursor=${encodeURIComponent(cursor)}`)}`,
      { credentials: 'include' }));
    out.push(...(body.records || []));
    cursor = body.cursor;
    pages++;
    onProgress?.(out.length);
  } while (cursor && cursor !== '0' && pages < 200);
  return out;
}

export const listPeople = onProgress => listAll('people', onProgress);
export const listOrganizations = onProgress => listAll('organizations', onProgress);

export const getContact = id =>
  fetch(`/api/contacts?${qs(`id=${encodeURIComponent(id)}`)}`, { credentials: 'include' }).then(json);

export const getOrganizationPeople = orgId =>
  fetch(`/api/contacts?${qs(`org=${encodeURIComponent(orgId)}`)}`, { credentials: 'include' }).then(json);

export const contactStats = () =>
  fetch(`/api/contacts?${qs('stats=1')}`, { credentials: 'include' }).then(json);

function write(body) {
  return fetch(`/api/contacts-write?${qs()}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json);
}

export const createPerson = fields => write({ action: 'create-person', ...fields });
export const createOrganization = fields => write({ action: 'create-organization', ...fields });
export const updateContact = (id, fields) => write({ action: 'update', id, fields });
export const affiliate = (personId, organizationId, title) =>
  write({ action: 'affiliate', personId, organizationId, title });
export const unaffiliate = affiliationId => write({ action: 'unaffiliate', affiliationId });
export const setPrimary = (personId, affiliationId) => write({ action: 'set-primary', personId, affiliationId });
// null clears the parent. The server refuses a link that would make the
// hierarchy circular, so the caller shows that error rather than pre-checking.
export const setParent = (organizationId, parentOrganizationId) =>
  write({ action: 'set-parent', organizationId, parentOrganizationId });
export const deleteContact = id => write({ action: 'delete', id });

// Drag-to-sort order for an organization's people. Persisted in the same byOrg
// index that drives the read, so no extra field was introduced.
export const reorderOrgPeople = (organizationId, affiliationIds) =>
  write({ action: 'reorder-org-people', organizationId, affiliationIds });

// Driving distance and time from this contact's address to HQ. Served from the
// address cache distance-sync already fills, so a site High 5 has driven to for
// a project costs nothing to show here.
export const contactDistance = id =>
  fetch(`/api/contact-distance?${qs(`id=${encodeURIComponent(id)}`)}`, { credentials: 'include' }).then(json);

// Phones, emails and addresses. `kind` is 'phone' | 'email' | 'address'; the
// server owns the array and returns the whole of it back, so the caller never
// posts a list it might have read before someone else changed it.
export const addMethod = (contactId, kind, fields) =>
  write({ action: 'add-method', contactId, kind, fields });
export const updateMethod = (contactId, kind, methodId, fields) =>
  write({ action: 'update-method', contactId, kind, methodId, fields });
export const removeMethod = (contactId, kind, methodId) =>
  write({ action: 'remove-method', contactId, kind, methodId });

// Drag-to-sort a contact's own phones/emails/addresses. `order` is the full
// list of method ids in the wanted order — same non-destructive semantics as
// reorderOrgPeople, an id left out is appended rather than dropped.
export const reorderMethods = (contactId, kind, order) =>
  write({ action: 'reorder-methods', contactId, kind, order });
