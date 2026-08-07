# Contacts in Vibe — organizations, people, and one-to-many

**Written 2026-08-06.** Design proposal for Phase 2. Nothing built yet.

Two questions to settle before contacts move: how Vibe stores one-to-many data
at all, and whether to keep FileMaker's contact model or do better.

The answer to the second is *do better*, and the data says so quite loudly.

---

## What FileMaker actually has

Measured against production, not inferred:

| | |
|---|---|
| Organizations (`Organization = 1`) | **4,752** |
| People (`Organization = 0`) | **10,831** |
| Table they live in | **the same one** — `Contacts_New` |
| What distinguishes them | a boolean |
| How they link | a join table (`cntct_RLTN`), surfaced as `Portal__Contacts` |

An organization stores its name in `Name_Organization` and leaves the person
fields empty. A person does the reverse and gets its organization's name through
the join — `zz__Display_Organization__ct` is *derived*, not stored.

### The link is many-to-many, and genuinely used

Sampling 300 people and counting their related-contact rows:

| Relations | People | |
|---|---|---|
| 0 | 14 | 4.7% |
| 1 | 167 | 55.7% |
| 2 | 101 | 33.7% |
| 3–8 | 18 | 6.0% |

**Roughly 40% of people are attached to more than one organization** — about
4,300 of 10,831. One person in the sample covers three schools; another covers
eight.

This matters more than it looks. Modelling this as a one-to-many — a person
having *an* organization — would silently discard the extra affiliations for two
in five people. That is the single most important finding here, and it is the
opposite of what the shape suggests at a glance.

The join is also not purely org↔person: one sampled person links to an
organization *and* to another person. The table is a general contact-to-contact
relation.

---

## Why the current model keeps producing bugs

Nearly every contact-shaped problem hit recently traces back to one table doing
two jobs:

- **"Ryan Doak" was filed as an organization.** The create form has a single
  "Name / Organization" field and a Type selector defaulting to Organization, so
  a person's name lands in `Name_Organization`.
- **That record then displays as blank**, because `zz__Display__ct` builds from
  `NameFirst`/`NameLast` for an individual — and those are not on the layout at
  all, so nothing in Vibe can write them.
- **Ian's CCS report** — a new project from Contacts takes the site name as the
  contact and won't accept an organization — is the same confusion surfacing
  through the project link.
- **The site-vs-organization join trap** already documented in CLAUDE.md
  (inspections hang off a *site* contact that is a different record from the
  *organization* contact) is this model leaking again.
- **49 places read `zz__Display_Organization__ct`**, every one of them relying on
  a derivation through the join.

None of these are careless code. They are what happens when the schema cannot
say what the business means.

---

## Proposal: three entities

**Organization** — name, status, addresses, phones, notes.
**Person** — first name, last name, title, emails, phones, notes.
**Affiliation** — a link between a person and an organization, carrying the role
or title *at that organization* and an optional `primary` flag.

Affiliation is a first-class thing rather than a foreign key because the data is
many-to-many. It also gives a natural home for something FileMaker has nowhere to
put: a person's title is often **per organization**, not per person.

`primary` is what makes a single "organization" column still displayable for the
60% of people with exactly one, without lying about the other 40%.

### What this fixes for free

- Adding a person becomes possible — separate first/last fields, no FileMaker
  layout change needed, because Vibe owns the schema.
- `zz__Display_Organization__ct` and friends become derivations Vibe computes
  from the affiliation, replacing five of the six FileMaker calculations
  identified in [the changeover inventory](changeover-inventory.md).
- The CCS organization field stops being a special case — a project references an
  organization directly instead of inferring one through a contact.

---

## How Vibe stores one-to-many

The other half of the question, and it applies beyond contacts.

**One children hash per record**, fields are collection names, values are JSON
arrays:

```
vibe:{db}:person:71501:children
    phones     [{id, type, number}, …]
    emails     [{id, type, address}, …]
    affiliations [{id, organizationId, title, primary}, …]
```

One `HGETALL` when a record is opened, rather than a read per collection. A
contact detail view currently pulls from several portals; this makes that one
round trip. Rewriting a whole collection to add one row is fine at these sizes —
a person has a handful of phones, not thousands.

### The distinction that shrinks the work

The changeover inventory counted **23 portals**. They are not all the same kind
of thing:

**Owned children** — data that belongs to the record and exists nowhere else.
Phones, emails, addresses, affiliations, estimate line items, inspection lines,
bill-of-materials. These need storing. There are about **seven**.

**Derived lists** — "every inspection for this contact", "every project for this
organization", "every invoice". These are *queries over other records*, not child
data. Vibe should compute them on read, exactly as it already computes the CCS
financials from QuickBooks. They need **no storage at all** — just an index by
parent id.

So the one-to-many work is seven collections, not twenty-three.

---

## Migration

Every existing contact becomes an Organization or a Person according to its
`Organization` flag, **keeping `_kpt__Contact_ID` as its id**, so every existing
reference — `_kft__Contact_ID` on projects, inspections, estimates — keeps
resolving without rewriting a single foreign key.

That needs one lookup Vibe can answer: *is id 69026 an organization or a person?*
A single set of organization ids is enough.

Affiliations are built from the `cntct_RLTN` join rows, which requires a layout
exposing that table over the Data API. **That layout does not exist yet** — same
class of blocker as `NameFirst`/`NameLast` not being on `Contacts_New`. Worth
confirming early, because it gates the migration rather than the design.

---

## Open decisions

| Decision | Note |
|---|---|
| Three entities, or keep one with a type flag? | Recommending three. The flag is what produces the bugs above. |
| Are person↔person relations kept? | They exist in the data. Out of scope for Phase 2 unless anyone uses them. |
| Does a project reference an organization, a person, or both? | Today it is one contact link doing both jobs. Ian's bug is exactly this. |
| Which title wins when a person has three affiliations? | The `primary` one, unless shown in an organization's context. |

## Needed from FileMaker before migration

1. A Data API layout exposing `cntct_RLTN` (the join), or another route to the
   affiliations.
2. `NameFirst` / `NameLast` on `Contacts_New` — needed to *read* existing people,
   even though Vibe will own them afterwards.

Both are layout additions, not schema changes, and neither is Claude-doable.
