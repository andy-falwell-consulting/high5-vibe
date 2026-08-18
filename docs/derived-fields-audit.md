# Derived-fields audit — the Phase C1 survey

**Measured 2026-08-18 against production** (`High5_Core4`), read-only. The
decoupling plan asks for this before any C1 code is written, on the grounds that
it is "the phase most likely to surface something that changes the plan." It
did — see *What this changes* at the end.

---

## 1. What the app actually reads

Every FileMaker-computed or related value the front end displays, by how often
it appears in `src/`:

| Field | Uses | Kind |
|---|---:|---|
| `zz__Display_Organization__ct` | 71 | calculation |
| `zz__Display_Contact__ct` | 61 | calculation |
| `zz__Display__ct` | 26 | calculation |
| `Address_Block_Billing` | 13 | **stored** — see §3 |
| `zz__Total__xn` / `zz__Subtotal__xn` / `zz__Tax__xn` | 12 | calculation (estimates) |
| `zz__Address__ct` | 7 | calculation |
| `inspt_CNTCT__site::Name_Organization` | 14 | related |
| `inspt_CNTCT__site::Site Number` | 6 | related |
| `inspt_CNTCT::NameFirstLast` | 3 | related |
| `rcd_cntct_PHONE__work::Number`, `…__mobile::Number` | 6 | related |
| `rcd_cntct_INADR__email::zz__Address__ct` | 3 | related |
| `trnpp_cntct_PHONE::Number`, `…_mobile::Number` | 6 | related |
| `trnpp_cntct_INADR__email::zz__Address__ct` | 3 | related |

---

## 2. Which of them are actually populated

Fill rates over a 1,000-record production sample per layout (119 for RMI).
**This is the part that cannot be guessed from the code** — a related field is
readable and present whether or not it has ever held a value.

| Layout | Field | Populated |
|---|---|---:|
| CCS | `zz__Display_Contact__ct` | 100% |
| CCS | `zz__Display_Organization__ct` | 99% |
| CCS | `Address_Block_Billing` | 81% |
| CCS | `rcd_cntct_PHONE__work::Number` | **0%** |
| CCS | `rcd_cntct_PHONE__mobile::Number` | **0%** |
| CCS | `rcd_cntct_INADR__email::zz__Address__ct` | **0%** |
| Inspections | `Organization` | 100% |
| Inspections | `inspt_CNTCT__site::Name_Organization` | 100% |
| Inspections | `inspt_CNTCT__site::Site Number` | 98% |
| Inspections | `Address_Block_Billing` | 84% |
| Inspections | `inspt_CNTCT::NameFirstLast` | 37% |
| Estimates | `zz__Display_Contact__ct` | 100% |
| Estimates | `Address_Block_Billing` | 100% |
| Trainings | `zz__Display_Contact__ct` | 100% |
| Trainings | `Address_Block_Billing` | 98% |
| Trainings | `zz__Display_Organization__ct` | 97% |
| Trainings | `trnpp_cntct_PHONE::Number` | 92% |
| Trainings | `trnpp_cntct_INADR__email::zz__Address__ct` | **0%** |
| RMI | `zz__Display_Contact__ct` | 100% |
| RMI | `zz__Display_Organization__ct` | 97% |
| RMI | `zz__Address__ct` | **0%** |

**Five fields the UI displays are empty on every single production record.**
Three were already known (the CCS work-order phone/cell/e-mail, which is why
every work order ever generated printed "—" for them). Two are new here:
Trainings' e-mail and RMI's address. Trainings' *phone* works (92%) while its
*e-mail* is dead, so this is per-field breakage, not a broken layout.

**These five should be deleted from the UI, not reproduced in Vibe.** Migrating
a field that has never had a value is work spent carrying a bug forward.

`inspt_CNTCT::NameFirstLast` at 37% is not broken, just sparse — inspections
often point at a site with no named person. It should degrade quietly, not show
an empty label.

---

## 3. `Address_Block_Billing` is stored, not calculated

This corrects an assumption carried into the last few changes.

Two independent pieces of evidence:

1. **The app writes it.** `INSPECTION_COPY_FIELDS` in
   `src/config/inspectionCopy.js` includes `Address_Block_Billing`, and copying
   an inspection has always written it through the Data API. FileMaker rejects a
   write to a calculation outright with `201 Field cannot be modified` — which is
   exactly what the estimate totals do.
2. **It disagrees with current contact data.** On CCS project "Bernice A Ray
   School" the stored block reads `Clare Brauch` / `26 Reservoir Road`, while
   that contact in Vibe is now `Clare Brauch Herman` / `7 Woodmore Drive`. A live
   calculation could not lag; a snapshot can.

So the address block is **ordinary stored data**. It replicates correctly, it
survives cutover untouched, and it needs no C1 work for existing records. What
it needs is composing *once at creation* for records born in Vibe — the same
shape of fix as `contactDisplay.js` (v1.0.379), which is why those records
currently print a blank address.

It also means the historical blocks are *deliberately* historical. Recomposing
them from today's contact data would silently rewrite where past work was
invoiced. **Do not backfill them.**

---

## 4. Can Vibe's own contact model supply the rest?

Yes — and it is richer than what it replaces. But not by a naive lookup.

Contacts v2 in production: **4,751 organizations, 10,831 people, 10,675
affiliations.** Entities carry `phones`, `emails`, `addresses` (structured:
type/street/city/state/zip), `siteNumber`, `qboId`, `parentOrganizationId`.
Organizations are keyed by the **same FileMaker contact id** the records already
hold in `_kft__Contact_ID`, so the join needs no new key.

Three traps, each found by trying it rather than reading it:

- **People carry no address; organizations do.** 15 of 15 sampled organizations
  had addresses. Kathy Pinkham — the contact on a CCS project whose stored block
  has a full address — has **zero** of her own. Composition must walk
  person → affiliation → organization.
- **A person can be affiliated with more than one organization.** Kathy Pinkham
  has two: Needham High School (73553) and Pollard Middle School (72062). Each
  has a different address in the same town. Nothing on the person says which one
  a given project belongs to, so the organization has to be *chosen* — from the
  record's own organization name, or from Vibe's org override where one exists
  (Trainings already has `trainingOrgs.orgIdFor`).
- **Address type varies and is not sorted.** Needham High School's only address
  is typed `Course`; Pollard's is `Main`. Taking `addresses[0]` and hoping is
  wrong; the type has to be part of the choice.

Composed correctly, the data matches: Needham High School's `Course` address is
`609 Webster Street, Needham MA 02494`, exactly what the stored block on that
project says.

---

## 5. The blocker

**Contacts v2 is empty in Dev — 0 organizations, 0 people, 0 affiliations —
while production has all 26,257 entities.**

Every verification in this programme is done against Dev, deliberately, because
probing production is not acceptable. C1 is the first phase whose code cannot be
exercised there at all: a name/address resolver has nothing to resolve against.

**Running the contacts migration against Dev is a prerequisite for C1**, not a
tidy-up. Doing C1 without it means writing the riskiest code in the plan and
testing it only in production.

---

## 6. The resolver, and how it measured

`api/_contactDisplay.js` (v1.0.385–386) rebuilds the names and the address block
from Vibe's contact model. Checked against **300 production CCS projects**,
read-only, passing each record's own organization name as the hint:

| | Result |
|---|---|
| Contact name | **295 of 295** found contacts. 0 mismatches. |
| Organization name | **294 of 295.** |
| Address block produced | 283 of 300 (94%) |
| Not found in Vibe | 5 — every one of which FileMaker itself shows as `<deleted>` |
| Ambiguous | **67 without the record's organization, 2 with it** |

Two things this measured that could not have been reasoned out:

- **The hint is what makes it work.** 22% of projects point at a person with
  several affiliations and none marked primary. Passing the record's own
  organization resolves 97% of them. Without it, a fifth of all records would
  have needed a guess.
- **The record's organization and the contact's employer legitimately
  disagree** — 22 of 300. Someone employed at Lincoln School runs a project for
  Scotia Glenville High School. FileMaker resolves the name through the
  *record's* relationship, not the person's employment, and is right to. The
  resolver now keeps the caller's organization for the name and **withholds the
  address** rather than taking the employer's, because an address for the wrong
  organization is the plausible-looking wrong answer worth most avoiding.

The six "mismatches" in the first run were all FileMaker double-spacing
(`Kevin  Kennedy`); Vibe's version is cleaner, and they are counted as matches
above.

### A divergence worth knowing about

The write path and the migration disagree about primary affiliations.
`reindexPerson` (used by every write) promotes the first affiliation to primary
if none is set; `indexAffiliations` (used by the migration) marks primary only
when there is exactly ONE. So "no primary organization" means *the migration
declined to choose*, and can never arise from a contact created in the app. That
is why the 698-person case cannot be reproduced in Dev by seeding — it was
validated against production instead.

---

## What this changes

1. **C1 is smaller than the plan assumes.** The address block — the scariest
   item, because it prints on customer documents — is stored data that needs no
   migration. Only the display *names* are genuinely calculated, and new records
   already carry them (v1.0.379).
2. **Part of C1 is deletion, not migration.** Five displayed fields have never
   held a value in production. They should come out of the UI.
3. **C1 has a hard prerequisite** — populating Contacts v2 in Dev.
4. **The contact-reassignment handlers** on CCS and Trainings, still on
   FileMaker for exactly this reason, are unblocked *once* the person → org
   walk exists. They need the names and the address block recomposed on
   reassignment — which is the same resolver, used at a second call site.
5. **Do not backfill historical address blocks.** They are snapshots of where
   work was actually invoiced, and today's contact data disagrees with them by
   design.
