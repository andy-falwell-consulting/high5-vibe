// Rebuild, from Vibe's own contact model, the organization/contact names and
// billing address block that FileMaker used to supply — PHASE C1.
//
// Grounded in docs/derived-fields-audit.md, which measured all of this against
// production rather than inferring it. Three findings shape this file:
//
//   - People carry no address; organizations do. 15 of 15 sampled organizations
//     had one; the contact on a CCS project whose stored block has a full
//     address had none of her own. So resolving an address means walking
//     person → affiliation → organization.
//   - A person can be affiliated with several organizations at different
//     addresses. 698 people are, and `indexAffiliations` only marks an
//     affiliation primary when it is the ONLY one — so for exactly those people
//     nothing is primary and the model cannot choose. This resolver REFUSES to
//     guess and says `ambiguous` instead, because the failure mode of guessing
//     is a plausible-looking wrong address on a customer's work order.
//   - Address TYPE varies and is not sorted. One school's only address is typed
//     `Course`, another's is `Main`. `addresses[0]` is not the answer.
//
// Read-only. Nothing here writes; callers decide what to stamp and when.
import { Redis } from '@upstash/redis';
import { K, parse, displayName, methodList } from './_contacts.js';

const redis = Redis.fromEnv();

// Which address to use when a contact has more than one. FileMaker's field is
// called Address_Block_BILLING, but no address in the data is typed 'Billing' —
// the types actually in use are things like Main, Course, Shipping. So this is
// a preference order with a defined fallback rather than a lookup, and the
// chosen type is reported so a caller can tell an exact match from a fallback.
const TYPE_PREFERENCE = ['billing', 'main', 'office', 'course'];

export function pickAddress(addresses = []) {
  const list = addresses.filter(a => a && (a.street || a.city || a.zip));
  if (!list.length) return null;
  for (const want of TYPE_PREFERENCE) {
    const hit = list.find(a => String(a.type || '').trim().toLowerCase() === want);
    if (hit) return hit;
  }
  return list[0];
}

// The four-line block, in FileMaker's own shape — verified against production:
//   Needham High School / Kathy Pinkham / 609 Webster Street / Needham, MA 02494
// Empty lines are dropped rather than left blank, which is how the stored ones
// read for contacts with no person or no street.
export function composeAddressBlock({ organizationName, contactName, address }) {
  if (!address) return '';
  const cityLine = [address.city, [address.state, address.zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  return [organizationName, contactName, address.street, cityLine].filter(Boolean).join('\r');
}

// Resolve one contact id.
//
// `preferOrganizationId` / `preferOrganizationName` let a caller supply the
// organization it already knows about — a CCS record's own organization name,
// or Trainings' Vibe org override — which is what makes the multi-affiliation
// case resolvable at all. Neither is required, and neither is trusted blindly:
// a preference that does not match one of the person's affiliations is ignored
// and reported, rather than silently producing an address the person has no
// connection to.
export async function resolveContactDisplay(db, contactId, opts = {}) {
  const id = String(contactId ?? '').trim();
  if (!id) return { found: false, reason: 'no contact id' };

  const org = parse(await redis.hget(K.org(db), id));
  if (org) {
    const address = pickAddress(methodList(org, 'address'));
    return {
      found: true, kind: 'organization',
      organizationId: org.id, organizationName: org.name || '',
      contactName: '',
      address, addressType: address?.type || null,
      addressBlock: composeAddressBlock({ organizationName: org.name || '', contactName: '', address }),
      siteNumber: org.siteNumber || '',
      ambiguous: false,
    };
  }

  const person = parse(await redis.hget(K.person(db), id));
  if (!person) return { found: false, reason: 'no such contact' };

  const contactName = displayName(person);
  const affIds = parse(await redis.hget(K.byPerson(db), id)) || [];
  const affsRaw = affIds.length ? await redis.hmget(K.aff(db), ...affIds) : [];
  const affs = (Array.isArray(affsRaw) ? affsRaw : Object.values(affsRaw || {})).map(parse).filter(Boolean);

  let chosen = null, how = null;
  const wantId = String(opts.preferOrganizationId ?? '').trim();
  const wantName = String(opts.preferOrganizationName ?? '').trim().toLowerCase();

  const orgsRaw = affs.length ? await redis.hmget(K.org(db), ...affs.map(a => a.organizationId)) : [];
  const orgs = (Array.isArray(orgsRaw) ? orgsRaw : Object.values(orgsRaw || {})).map(parse).filter(Boolean);
  const orgById = new Map(orgs.map(o => [String(o.id), o]));

  if (wantId && affs.some(a => String(a.organizationId) === wantId)) {
    chosen = orgById.get(wantId); how = 'preferred id';
  } else if (wantName) {
    chosen = orgs.find(o => String(o.name || '').trim().toLowerCase() === wantName) || null;
    if (chosen) how = 'preferred name';
  }
  if (!chosen) {
    const primary = affs.find(a => a.primary);
    if (primary) { chosen = orgById.get(String(primary.organizationId)); how = 'primary'; }
  }
  if (!chosen && affs.length === 1) { chosen = orgById.get(String(affs[0].organizationId)); how = 'only affiliation'; }

  // More than one affiliation, none primary, and no usable hint: this is the
  // 698-person case. Return the name — which is never ambiguous — and no
  // address, flagged, so a caller can ask rather than print the wrong one.
  const ambiguous = !chosen && affs.length > 1;

  // A hint that matched nothing is not a mistake to correct — it is usually the
  // truth. Measured over 300 production CCS projects: 23 point at a person
  // whose ONLY affiliation is a different organization, because people run
  // programmes at sites other than their employer (a contact at Lincoln School
  // running a project for Scotia Glenville High School). FileMaker's
  // zz__Display_Organization__ct resolves through the RECORD's relationship,
  // not the person's employment, and it is right to.
  //
  // So the caller's organization wins the NAME, and the address is withheld
  // rather than taken from the person's employer — an address for the wrong
  // organization is exactly the plausible-looking wrong answer this file exists
  // to avoid.
  const hintUnmatched = !!(wantName || wantId) && how !== 'preferred name' && how !== 'preferred id';

  const own = pickAddress(methodList(person, 'address'));
  const orgAddress = chosen && !hintUnmatched ? pickAddress(methodList(chosen, 'address')) : null;
  const address = own || orgAddress;
  const organizationName = hintUnmatched
    ? String(opts.preferOrganizationName ?? '').trim()
    : (chosen?.name || '');

  return {
    found: true, kind: 'person',
    organizationId: hintUnmatched ? null : (chosen?.id || null), organizationName,
    contactName,
    address, addressType: address?.type || null,
    addressBlock: composeAddressBlock({ organizationName, contactName, address }),
    siteNumber: hintUnmatched ? '' : (chosen?.siteNumber || ''),
    ambiguous,
    hintUnmatched,
    chosenBy: hintUnmatched ? 'caller organization (no matching affiliation)' : how,
    affiliationCount: affs.length,
    addressFrom: own ? 'person' : (address ? 'organization' : null),
  };
}
