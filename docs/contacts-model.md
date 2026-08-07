# Contacts in Vibe — organizations, people, and one-to-many

**Written 2026-08-06.** Design proposal for Phase 2. Nothing built yet.

Two questions to settle before contacts move: how Vibe stores one-to-many data
at all, and whether to keep FileMaker's contact model or do better.

The answer to the second is *do better* — though the margin is narrower than a
first look suggested. See the correction below.

---

## What FileMaker actually has

Measured against production, not inferred:

| | |
|---|---|
| Organizations (`Organization = 1`) | **4,751** |
| People (`Organization = 0`) | **10,839** |
| Table they live in | **the same one** — `Contacts_New` |
| What distinguishes them | a boolean |
| How they link | a join table (`cntct_RLTN`), surfaced as `Portal__Contacts` |

An organization stores its name in `Name_Organization` and leaves the person
fields empty. A person does the reverse and gets its organization's name through
the join — `zz__Display_Organization__ct` is *derived*, not stored.

### The link is many-to-many — but only just

The join table stores **every link twice**, once in each direction: 10,912
`person→org` rows and exactly 10,912 `org→person` rows. Deduplicated, the real
picture across all 23,302 rows is:

| | |
|---|---|
| Distinct person↔organization affiliations | **10,675** |
| People with at least one | 9,619 of 10,832 |
| People with **exactly one** | **8,921 — 92.7%** |
| People with more than one | **698 — 7.3%** |
| Most affiliations held by one person | 13 (Chris Wanner) |

**Correction.** An earlier draft of this document said ~40% of people belong to
more than one organization. That was wrong. It came from counting
`Portal__Contacts` rows, which mix organization links with person-to-person
links and count each direction — not distinct affiliations. The real figure is
**7.3%**.

That materially weakens the argument for many-to-many, so it is worth being
precise about what survives it: **698 people hold 1,754 affiliations that a
one-to-many model would silently discard.** Chris Wanner covering 13
organizations is a fact about the business, not a data-entry error. There is no
reason to lose it, and no cost to keeping it.

But the design emphasis flips. With 92.7% holding exactly one affiliation, the
UI should treat "this person's organization" as a single value in the ordinary
case, and the multi-affiliation case as the exception it is — rather than making
9,000 people's records look like a list to serve 698.

That is what the `primary` flag below is for, and it matters more given these
numbers, not less.

### Two other shapes in the same table

**Organization ↔ organization: 691 distinct links — and they are a hierarchy.**
Every one of twenty sampled pairs is a school and its district:

```
Read School                  ↔  Bridgeport Board of Education
Wilbur Cross School          ↔  Bridgeport Board of Education
Harding High School          ↔  Bridgeport Board of Education
Barnum School                ↔  Bridgeport Board of Education
…
```

This is the **site-vs-organization join trap** already documented in CLAUDE.md,
seen from the other end: an inspection hangs off the *site* (Read School) while
the *organization* is the district (Bridgeport Board of Education), and matching
on the contact id alone silently finds nothing.

It is also, almost certainly, the root of Ian's CCS report. A project points at a
site; the "organization" people expect to see is the parent.

So this is not a peer relationship and should not be modelled as one. See
`parentOrganizationId` below.

**Person ↔ person: 32 distinct links.** One is labelled "Spouse". Small enough
to defer.

**`Relationship` carries nothing.** Now that it is readable: **23,288 of 23,302
rows are blank — 99.94%.** The fourteen that are filled hold job titles
("Executive Director", "Camp Director", "Student") and one "Spouse". Not one of
the 1,382 organization rows has a value.

So there is no link *type* to model, and the handful of values that do exist are
titles — which is where the design already puts them. Worth having checked
rather than guessed, even though the answer was "ignore this field".

**1,213 people have no organization at all**, and 32 relationship rows point at
contact ids that no longer exist.

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

**Organization** — name, status, addresses, phones, notes, and
`parentOrganizationId` for the district→school hierarchy above. A single parent
rather than a set: every sampled school belongs to exactly one district. Worth
confirming no organization has two parents before building.
**Person** — first name, last name, title, emails, phones, notes.
**Affiliation** — a link between a person and an organization, carrying the role
or title *at that organization* and an optional `primary` flag.

Affiliation is a first-class thing rather than a foreign key because the data is
many-to-many. It also gives a natural home for something FileMaker has nowhere to
put: a person's title is often **per organization**, not per person.

`primary` is what keeps a single "organization" column displayable for the 92.7%
of people with exactly one, without discarding the 698 who have more.

### What this fixes for free

- Adding a person becomes possible — separate first/last fields, no FileMaker
  layout change needed, because Vibe owns the schema.
- `zz__Display_Organization__ct` and friends become derivations Vibe computes
  from the affiliation, replacing five of the six FileMaker calculations
  identified in [the changeover inventory](changeover-inventory.md).
- The CCS organization field stops being a special case — a project references an
  organization directly instead of inferring one through a contact.
- The site-vs-organization trap becomes answerable: "all work for Bridgeport
  Board of Education" is a walk up `parentOrganizationId`, rather than a join
  that has to be got exactly right each time and currently is not.

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

Affiliations are built from the `cntct_RLTN` join rows, read through the
**`Contact_rltn`** layout — which already existed, exposing
`_kpt__Contact_Relationship_ID`, `_kft__Contact_ID`, `_kft__Contact_ID_Related`
and a display name across 23,302 rows.

**The migration must deduplicate.** Every link is stored in both directions, so
a naive import creates 21,350 affiliations where there are 10,675.

**Names are solved.** `Name_First` and `Name_Last` are now on
`Contacts_New_vibe` (note the underscores — not `NameFirst`), populated for
10,788 and 10,755 of 10,839 people, or ~99.5%. This removes a real risk: the
contact whose display name reads `"Sargent Jose  Limone"` splits to
`Name_First = "Sargent Jose "`, `Name_Last = "Limone"`. Parsing the display
string would have made the first name "Sargent" — and would have quietly
mangled a few hundred records that nobody would have spotted.

`Contact_rltn` now also exposes `Relationship` and `zz__Sort_Order__cn`, so
nothing further is needed from FileMaker. `Relationship` turned out to be 99.94%
blank and is ignored; the sort calculation covers ordering without the raw `Sort`
field.

---

## Open decisions

| Decision | Note |
|---|---|
| Three entities, or keep one with a type flag? | Recommending three. The flag is what produces the bugs above. |
| ~~How are organization↔organization links modelled?~~ | **Settled** — a district→school hierarchy, modelled as `parentOrganizationId`. |
| Are person↔person relations kept? | They exist in the data. Out of scope for Phase 2 unless anyone uses them. |
| Does a project reference an organization, a person, or both? | Today it is one contact link doing both jobs. Ian's bug is exactly this. |
| Which title wins when a person has three affiliations? | The `primary` one, unless shown in an organization's context. |

## Needed from FileMaker before migration

Nothing blocks the migration. Two things would make it cleaner, both layout
additions:

Nothing. Everything the migration needs is now readable:

- `Name_First` / `Name_Last` on `Contacts_New_vibe` — **done**, ~99.5% populated
- `Relationship` on `Contact_rltn` — **done**, and it turned out to be empty
- `zz__Sort_Order__cn` on `Contact_rltn` — covers ordering

Phase 2 is unblocked.
