// Organization and contact NAMES on a record that hangs off a contact.
//
// FileMaker calculated these on the child record from its related contact, so
// they were never stored. A record born in Vibe has no FileMaker row for that
// calculation to run against, which means the name comes back empty — and the
// consequence is worse than a blank label: CCSv2, Estimates and RMI all *search*
// these very fields, so a record created in Vibe could not be found by typing
// its organization's name. See Phase C1 of docs/decoupling-plan.md.
//
// Stamping the names at creation stores what FileMaker would have derived. This
// is a stopgap for records born in Vibe, not the C1 fix: it pins a copy that
// won't follow a later rename of the contact, where the calculation would have.
// Safe to pin, though, precisely because these records have NO FileMaker
// counterpart — there is no future recalculation for the fragment to shadow.
//
// The mapping below was verified against a real linked pair rather than inferred
// (CCS project 10237 → contact 82454, "Needham High School" / "Kathy Pinkham"):
// the child's `zz__Display_Organization__ct` is the contact's field of the SAME
// name, and its `zz__Display_Contact__ct` is the contact's `zz__Display__ct`.
//
// `Name_Organization` is deliberately NOT used as a source. It was empty on that
// contact even though the organization name was present, so it silently produces
// blanks on exactly the records this is meant to fix.
//
// Inspections is the odd one out by design, not by oversight: it keeps the
// organization in its own real `Organization` field, which is what its own
// create form already writes (Inspections.jsx, `orgField: 'Organization'`). This
// follows that precedent instead of introducing a second convention.
//
// Addresses are deliberately absent. `Address_Block_Billing` cannot be derived
// this way — the contact replica's address fields read back empty, because
// contact addresses now live in Vibe's own store. Printed work orders on
// Vibe-born records still need the real C1 work.
const FIELDS_BY_LAYOUT = {
  'RCD_New':         { org: 'zz__Display_Organization__ct', person: 'zz__Display_Contact__ct' },
  'RMI_New':         { org: 'zz__Display_Organization__ct', person: 'zz__Display_Contact__ct' },
  'Estimates_New':   {                                      person: 'zz__Display_Contact__ct' },
  'Inspections_New': { org: 'Organization' },
};

// Build the name fields to stamp onto a new record on `layout`.
//
// `names` is `{ org, person }` already extracted by the caller, because the two
// callers hold a contact in different shapes — the legacy Contacts_New
// fieldData, and Contacts v2's own organization/person objects.
//
// Empty values are omitted rather than written as '': a stored empty string is
// indistinguishable from a real one downstream, and would pin a blank in the
// fragment where leaving the key out lets anything better win later.
export function contactDisplayFields(layout, { org = '', person = '' } = {}) {
  const map = FIELDS_BY_LAYOUT[layout];
  if (!map) return {};
  const out = {};
  if (map.org && org) out[map.org] = org;
  if (map.person && person) out[map.person] = person;
  return out;
}

/** Pull `{ org, person }` out of a legacy Contacts_New record's fieldData. */
export function namesFromContactRecord(fieldData = {}) {
  return {
    org: fieldData['zz__Display_Organization__ct'] || '',
    person: fieldData['zz__Display__ct'] || '',
  };
}
