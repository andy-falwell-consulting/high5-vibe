import { getCurrentEnv } from '../config/fmpEnvironments';

// The organization/contact names and billing address block a record shows.
//
// PHASE C1. These were FileMaker calculations resolved through the record's
// contact relationship, so a record born in Vibe — which has no FileMaker row
// for them to run against — showed nothing. v1.0.379 stamped the NAMES from the
// contact in hand; this replaces that with the server resolver, which also
// supplies the address block and is the version measured in
// docs/derived-fields-audit.md (295/295 names, 294/295 organizations over 300
// production projects).
//
// The mapping stays here rather than on the server because it is per-LAYOUT
// knowledge — which field each table keeps these in — while the resolver is per
// CONTACT. Inspections is the odd one out by design: it keeps the organization
// in its own real `Organization` field, which is what its create form already
// writes.
//
// Address_Block_Billing is listed only for the layouts that actually have it.
// RMI displays `zz__Address__ct`, which is empty on all 119 production records,
// so there is nothing to reproduce there — see the audit.
const FIELDS_BY_LAYOUT = {
  'RCD_New':         { org: 'zz__Display_Organization__ct', person: 'zz__Display_Contact__ct', address: 'Address_Block_Billing' },
  'trainings_New':   { org: 'zz__Display_Organization__ct', person: 'zz__Display_Contact__ct', address: 'Address_Block_Billing' },
  'Estimates_New':   {                                      person: 'zz__Display_Contact__ct', address: 'Address_Block_Billing' },
  'Inspections_New': { org: 'Organization',                                                    address: 'Address_Block_Billing' },
  'RMI_New':         { org: 'zz__Display_Organization__ct', person: 'zz__Display_Contact__ct' },
};

export const layoutHasDisplayFields = layout => !!FIELDS_BY_LAYOUT[layout];

// Ask the server what this contact resolves to.
//
// `organizationName` is the organization the CALLER already knows about, and it
// matters: 22% of records point at a person with several affiliations and none
// marked primary, and passing it resolves 97% of those. Pass it whenever the
// record already has one; omit it when the contact IS the starting point, as it
// is when creating from a contact.
export async function resolveContactDisplay(contactId, { organizationName } = {}) {
  const db = getCurrentEnv().db;
  const id = String(contactId ?? '').trim();
  if (!id) return null;
  const url = `/api/contacts?db=${encodeURIComponent(db)}&resolve=${encodeURIComponent(id)}`
    + (organizationName ? `&org=${encodeURIComponent(organizationName)}` : '');
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) return null;
  const body = await res.json().catch(() => ({}));
  const r = body?.resolved?.[id];
  return r?.found ? r : null;
}

// Map a resolved contact onto one layout's field names.
//
// Empty values are omitted rather than written as '': a stored empty string is
// indistinguishable from a real one downstream, and would pin a blank where
// leaving the key out lets something better win later. `clearAddress` is the
// exception and is deliberate — see the reassignment callers, where the address
// already on the record belongs to the PREVIOUS contact and leaving it is worse
// than clearing it.
export function contactDisplayFields(layout, resolved, { clearAddress = false } = {}) {
  const map = FIELDS_BY_LAYOUT[layout];
  if (!map || !resolved) return {};
  const out = {};
  if (map.org && resolved.organizationName) out[map.org] = resolved.organizationName;
  if (map.person && resolved.contactName) out[map.person] = resolved.contactName;
  if (map.address) {
    if (resolved.addressBlock) out[map.address] = resolved.addressBlock;
    else if (clearAddress) out[map.address] = '';
  }
  return out;
}

// One call for the common case: resolve, then map. Returns {} rather than
// throwing if the contact can't be resolved — a record that saves with a blank
// name is recoverable, one that fails to save is not.
export async function displayFieldsForContact(layout, contactId, opts = {}) {
  try {
    const resolved = await resolveContactDisplay(contactId, opts);
    return { fields: contactDisplayFields(layout, resolved, opts), resolved };
  } catch {
    return { fields: {}, resolved: null };
  }
}
