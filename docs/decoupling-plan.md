# Decoupling Vibe from FileMaker — the whole programme

**Written 2026-08-17.** A plan, not a record of work done. Figures are measured
against production on that date unless marked otherwise.

The goal: Vibe owns every record, every field and every process. FileMaker keeps
exactly one job until cutover — **being refreshable INTO Vibe**. Nothing is ever
written back to it.

---

## The mechanism already exists

Two Redis keyspaces, deliberately separate (see `api/_vibeStore.js`):

```
repl:{db}:{layout}:recs    FileMaker's copy. A sync REPLACES it wholesale.
vibe:{db}:{layout}:recs    Vibe's own fragments. A sync NEVER touches it.
```

A read merges the two, Vibe winning field by field. Decoupling is therefore not
an architecture change — it is moving each thing along the same three steps:

1. read `repl:`, write FileMaker
2. read `repl:` + `vibe:`, write `vibe:`   ← where the moved pieces are now
3. read `vibe:` only                        ← cutover

Because the keyspaces are separate, *a refresh cannot destroy Vibe's work* is
true by construction rather than by carefulness. That is what makes the one
capability we are keeping cheap to keep.

**One-way only.** No write-back to FileMaker is planned or wanted, which removes
conflict resolution and reconciliation entirely — the hardest part of a
migration like this, simply absent.

---

## Status at a glance

Reviewed against the code and against production on **2026-08-18**. Entries
below carry their own dates; where an older paragraph was proved wrong it has
been corrected rather than deleted, because the wrong version is usually the
more instructive one.

| | State |
|---|---|
| **A1** record creation | **done** — 4 layouts moved via one shared component |
| **A2** deletion | **done** — tombstones, all 8 layouts, one change |
| **A3** edit ownership | **done as far as it goes** — 6 of 8; the other two are decided against or need a feature built |
| **A4** delete the write token | **one thing away** — only the legacy Contacts module still writes |
| **B1** estimate line items | **done** — migrated, wired, FileMaker module deleted |
| **B2** bill of materials | **done** (2026-08-19) — tail migrated, 10 runaway parents left behind. See b2-bom-scope.md |
| **B3** OE training | **done** (2026-08-19) — 5,142 workshops across 2,689 contacts |
| **B4** retire legacy Contacts | **gap closed** — invoices migrated; only the deletion itself remains |
| **B5** search + agent | **done** — both repointed at Vibe's contact model |
| **C1** derived fields | **audited; resolver and both write paths shipped**; existing records not backfilled |
| **C2/C3/C4** | untouched — C4 is the largest unknown |
| **D** cutover | untouched |

---

## Where we are

Eight layouts are replicated (`api/_replica.js`).

| Layout | Records | Edits owned by | Creation | Deletion |
|---|---:|---|---|---|
| `RCD_New` (CCS) | 6,436 | **Vibe** | **Vibe** (2026-08-18) | **Vibe** (2026-08-18) |
| `Inspections_New` | ~4,900 | **Vibe** | **Vibe** | **Vibe** (2026-08-18) |
| `trainings_New` | 2,478 | **Vibe** (2026-08-18) | — *(no create path exists)* | **Vibe** (2026-08-18) |
| `Contacts_New` | 15,582 | FileMaker | **Vibe** (`V-` ids) | **Vibe** (tombstone) |
| `Estimates_New` | 2,817 | **Vibe** (2026-08-18) | **Vibe** (2026-08-18) | **Vibe** (2026-08-18) |
| `Products & Services_New` | 1,267 | **Vibe** (2026-08-18) | **Vibe** (2026-08-19) | **Vibe** (2026-08-18) |
| `OELookup_New` | 1,247 | FileMaker | FileMaker | **Vibe** (2026-08-18) |
| `RMI_New` | 117 | **Vibe** (2026-08-18) | **Vibe** (2026-08-18) | **Vibe** (2026-08-18) |

Child collections:

| Collection | Rows | Home |
|---|---:|---|
| Contact phones / emails / addresses | 36,663 | **Vibe** |
| Inspection line items | 208,068 | **Vibe** |
| Attachments (all modules) | — | **Vibe** (Drive + Redis) |
| Estimate line items (`estmt_ESTLI`) | 10,858 | **Vibe** (2026-08-19) |
| Bill of materials (`item_ITMLI`) | 10,116 migrated *(of 125,047)* | **Vibe** (2026-08-19) |
| Contact relationships (`cntct_RLTN`) | 23,302 | FileMaker (superseded by Vibe affiliations) |
| Invoices (`Invoices_New`) | 13,141 | **Vibe** (2026-08-19) |
| OE training (`Workshops_New`) | 5,142 | **Vibe** (2026-08-19) |
| Certifications (`CTFC`) | 3 | FileMaker — out of scope (Andy, 2026-08-19) |

Roughly: **6 of 8 layouts own their edits, 6 of 8 own creation, 8 of 8 own
deletion; 6 of 8 child collections have moved.**

Deletion is the only column that is finished, and it finished in one change
because every module deletes through one shared control.

Two of the three layouts that don't own creation *can't* be given it by
rewiring, because they have no create path to rewire: nothing anywhere in the
app creates a `trainings_New` or an `OELookup_New` record. Building one is a
feature, not a migration, and needs its own design. The third, Products &
Services, is deliberate — see below.

Products & Services' and Estimates' moves were both scoped narrower than the
first three, on purpose:

- **Products & Services**: fully Vibe as of 2026-08-19 — field edits, the
  Bill-of-Materials (B2) and creation. The creation note here used to say it was
  "entangled with SKU assignment plus live Shopify/QBO pushes"; reading the code
  showed that overstated it. The SKU comes from the Tray counter and never had
  anything to do with FileMaker, `pushToShopify` takes a `recordId` and never
  reads it, and `pushToQBO` is not given one. Neither push cares where the
  record lives.
- **Estimates**: top-level record field edits (Title, Status, Class, the
  QBO-push id write-back) went to Vibe. Line items and the stored totals did
  not — the totals reject direct writes (`201 Field cannot be modified`) and
  only a FileMaker script corrects them, which the app had to call after every
  line change. **That is no longer the blocker it reads as here:** measured
  2026-08-18, tax is 0 on all 2,818 estimates and no line is taxable, so the
  totals are a sum. **B1 is done (2026-08-19)** — see
  [b1-estimate-lines-scope.md](b1-estimate-lines-scope.md).

---

## Phase A — Close the write paths

Nothing can be decoupled while FileMaker is still the writer.

**A1. Generalise record creation — done, and now fully wired.**
`api/vibe-record.js`'s `{create: true, fieldData}` path is live, writing
`__created: true` via the same per-table id allocator `api/_contacts.js` uses
(`VIBE_PK`, checked in `api/_vibeStore.js`).

Completed 2026-08-18. Wiring it up turned out to be smaller and wider than this
plan assumed, because **creation is not per-module code** — most of it lives in
one shared component, `QuickAddFromContact.jsx` (the "+ New ▾" button on a
contact), which creates CCS projects, Inspections *and* Estimates. Converting
that one component plus one call site in `ContactsV2.jsx` (which created RMI
records directly) moved four layouts' creation at once.

That also closed a gap this plan had recorded as done: Inspections' *module*
create moved to Vibe first, but the shared quick-add path still went to
FileMaker, so an inspection created from a contact bypassed Vibe entirely. Two
read-backs disappeared with it — the minted `V-` id is already the table's
primary key, so neither the inspection line-item copy nor the list-cache seed
needs a round trip any more.

Not wired, and not wirable by this route: `trainings_New` and `OELookup_New`
have no create path anywhere in the app, and Products & Services' creation is
deliberately still FileMaker's (see the note above the table).

**A2. Generalise deletion — done 2026-08-18.** Tombstones (`__deleted`) instead
of `deleteRecord`, across all eight layouts in one change, because
`DeleteRecordButton` is the single control every module uses.

What deleting now means, decided rather than inherited: the record disappears
from Vibe for everyone and stays gone across syncs, and **FileMaker's row is
left alone**. Two consequences, both said plainly in the confirmation dialog
rather than buried here — anyone still working in FileMaker Pro keeps seeing
records that are gone from Vibe, and a deletion is now recoverable by hand
(drop the tombstone) in a way the old FileMaker delete never was.

Three implementation notes that are easy to get wrong:

- `VIBE_DELETES` is a **separate list** from `VIBE_OWNED`, and wider.
  `OELookup_New` and `Contacts_New` can be deleted through Vibe while still
  being edited through FileMaker. Folding the two sets together would silently
  grant edit ownership nobody decided on.
- The route's `DELETE` verb and its `{ delete: true }` body do **opposite**
  things — `DELETE` drops a fragment and hands the record back to FileMaker,
  `{ delete: true }` hides it. They are kept on different verbs so neither is
  reachable by accident.
- `/api/replica-delete` is gone from this path. It existed because an
  incremental sync only ever upserts and never sees deletions, so a deleted row
  kept returning from the replica. A tombstone survives every sync by
  construction, and leaving `repl:` intact is exactly what keeps the record
  restorable.

**A3. Extend `VIBE_OWNED`** to the remaining layouts, one module per change.

**Decided 2026-08-18: A3 is finished as far as it will go.** `Contacts_New` will
NOT be extended — the legacy module is to be retired (B4), so giving its edit
path Vibe ownership would be work on something scheduled for deletion. That
leaves only `OELookup_New`, which has no edit or create path in the UI at all;
"extending" it means building a feature, not moving a write. Neither is a
blocker for A4.

6 of 8 done: RCD_New, Inspections_New, trainings_New, RMI_New, Products &
Services_New, Estimates_New — the last two edits-only, see the notes above the
table.

**A4. Delete the FileMaker write token.** `getToken({ write: true })` in
`src/api/filemaker.js` is the single chokepoint every mutating call routes
through. Removing it makes "we still write to FileMaker" *impossible* rather
than merely untrue, and retires the per-user-FMP-account failure class.

**One thing away.** As of 2026-08-19 the ONLY remaining FileMaker write in the
app is the legacy Contacts module:

| Still writes to FileMaker | Why it hasn't moved |
|---|---|
| Legacy Contacts module — edits, creation, portals, `Contact_rltn` | B4 wants the module retired instead |

`TandD.jsx` and `EOL.jsx` also still call `updateRecord`, but both set
`RECORDS_LOCKED = true` and are view-only, so those calls are unreachable. They
should be removed with the placeholder modules rather than counted as writes.

---

## Phase B — Move the remaining child collections

**B1. Estimate line items — DONE 2026-08-19, see
[b1-estimate-lines-scope.md](b1-estimate-lines-scope.md).** The trap is real and
the fix stands, but two things measured against production change this entry:

- **The totals are trivial.** Tax is 0 on all 2,818 estimates, no line has
  `Taxable` set, and `Total = Subtotal + Tax` with zero exceptions. "Vibe
  computing the totals first" is summing line amounts — not the blocker this
  plan assumed. (Compute tax from taxable lines anyway, so it stays correct the
  day someone charges it. The rate is not stored anywhere — needs Ian.)
- **The stale total is not hypothetical.** 2 of 60 sampled estimates already
  disagree with their own lines, by +$50.00 and −$406.00. Roughly 3%, in
  production, today.

**The prerequisite is met.** The migration needs a layout on the line-item
TABLE, because the replica's list scan carries no portal data and per-record
portal reads both cost one round trip per estimate and truncate at 50 rows.
That layout is **`est_li_vibe_2`** — 10,858 rows carrying `_kft__Estimate_ID`,
confirmed by peeking it. (`estimate_li_vibe`, one character away, is the Items
catalogue; peek caught that before anything was written.)

**Built so far:** `api/_estimateLines.js` (store + computed totals),
`api/estimate-lines.js` (runtime read/write), `api/estimate-lines-migrate.js`
(paged migration with a read-only `peek`), `src/api/estimateLinesVibe.js`.
**Remaining:** point `Estimates.jsx` at them instead of portalData and
`RECALC_SCRIPT`, then run the migration.

**B2. Bill of materials** (Products) — **DONE 2026-08-19. See
[b2-bom-scope.md](b2-bom-scope.md).**

10,116 lines across 311 products migrated; the ten runaway parents holding
114,150 rows were deliberately left behind. `ProductsAndServicesV2.jsx` reads
and writes through Vibe, and its three portal writes are gone.

The layout exists and carries the right keys (`Item_ITMLI_billOfMaterials`), and
there are **125,047 rows**. But it cannot be paged: a 1,000-row page takes over
30 seconds, because the layout carries table-wide aggregate calculations
(`s_Cost`, `s_Total`) that FileMaker recomputes per row. 126 pages of that is
about an hour of continuous load.

**Needs a lean layout** — just `_kpt__Item_Line_Item_ID`,
`_kft__Item_ID__parent`, `_kft__Item_ID__assemblyLine` and `Quantity`, with no
aggregate calcs — exactly as `est_li_vibe_2` provided for B1. With that, B2 is
the same routine job B1 was.

**B3. OE training** — **scoped 2026-08-19, blocked on a layout. See
[b3-oe-training-scope.md](b3-oe-training-scope.md).** Certifications are out of
scope (Andy, 2026-08-19).

This is now the blocker for A4, via a short chain: only the legacy Contacts
module still writes to FileMaker, B4 wants it retired rather than moved, and it
cannot be retired while it is the only home for OE training.

The data is small — ~5% of contacts, roughly 780 contacts and ~2,600 rows — but
there is **no readable layout on the WKSRG table**. `Script_Use__Orders` exists
and reports 17 rows while exposing zero fields, which is the same state the
contact-method tables were in before fields were added to them. Needs a layout
carrying `_kpt__Workshop_ID`, **`_kft__Contact_ID`**, Course Number/Name and the
start/end dates and times — and only those, since B2 showed an aggregate
calculation on a layout makes paging 18x slower.

It is NOT the OE Lookup module: `OELookup_New` is a catalogue of programmes with
no contact link of any kind.

**B4. Retire the old Contacts module** — **scoped 2026-08-19, see
[b4-retire-legacy-contacts.md](b4-retire-legacy-contacts.md).** B3 has landed,
so this is now the last domino before A4.

Contacts v2 covers every legacy tab except **invoices** (certifications are out
of scope at 3 rows). The legacy tab reads `Portal__Invoices`; `Invoices_New` is
the layout to migrate from — 13,140 rows, carrying `_kft__Contact_ID`, the
totals and the paid flag, and peeking in 659ms with no aggregate-calc problem.

Worth deciding first: FileMaker's INVO is HISTORICAL. The QBO invoice mirror
writes into it and is deferred in production, so live invoices are in
QuickBooks and surface through Transactions. Migrating `Invoices_New` preserves
history; a live per-contact QBO view is a different feature needing a
contact→QBO customer mapping that is not finished for production.

**B5. Repoint search and the agent to the new contacts model.** Contacts v2
(organizations, people and affiliations as separate Vibe entities —
`api/_contacts.js`, `api/contacts.js`, `api/contacts-write.js`) shipped
2026-08-06/07, ahead of where `contacts-model.md` says it stands. But two
other subsystems still only know about the pre-rebuild world:

- **Global search (`⌘K`) — DONE 2026-08-18.** Worth recording that the
  symptom written here was **wrong**, and building from it would have fixed
  nothing: `zz__Display__ct`, the only field the palette matched contacts on,
  is populated on 9,511 of 9,512 production people, and searching a person's
  name found them. The real defect was that search could not see contacts
  that live **only in Vibe** — so every person and organization created in
  Contacts v2 since 2026-08-06 was invisible, and creating one produced a
  contact nobody could find.

  Vibe's people and organizations are now sources in their own right. The
  legacy `Contacts_New` source is kept and deduped **per record** on the
  shared `_kpt__Contact_ID` — not suppressed wholesale, which was the first
  attempt and which four seeded contacts in Dev were enough to break by
  hiding all 15,450 real ones. Verified in production: a contact in both
  stores appears exactly once. `RecordPicker` gets the same fix from the
  shared config. Goes away entirely with B4.
- **The agent** (`api/agent.js`) — **DONE 2026-08-19.** It had the same blind
  spot search did, and for the same reason: its `contacts` module is a FileMaker
  find against `Contacts_New`. It now has two tools reading Vibe's model —
  `search_contacts` (organizations and people, by name/phone/email) and
  `get_contact` (an organization with its addresses, or a person with their
  affiliations and which is primary) — and prompt text explaining the split,
  including that addresses hang off the ORGANIZATION so answering "where is X"
  for a person means finding their organization first.

  The FileMaker module is deliberately KEPT alongside rather than replaced: the
  legacy table is still the only home for OE training and certifications (B3),
  so the agent needs both until B4 retires it.

Same root cause as B4: two Contacts systems exist right now, and most of
the app outside `ContactsV2.jsx` itself still assumes the old one.

---

## Phase C — Remove FileMaker from the read path

The highest-risk phase, and the risk is not the record data.

**The C1 audit is done — see [derived-fields-audit.md](derived-fields-audit.md)**
(2026-08-18, measured against production). It changed this phase materially, so
read it before acting on the C1 text below, which predates it:

- `Address_Block_Billing` is **stored data, not a calculation** — it replicates
  correctly and needs no migration. Only the display *names* are genuinely
  calculated. C1 is smaller than written here.
- **Five displayed fields have never held a value in production.** Part of C1 is
  deleting them from the UI, not migrating them.
- Vibe's contact model can supply the rest and joins on the id records already
  hold, but composition must walk person → organization, choose between multiple
  affiliations, and respect address *type*.
- **Contacts v2 is empty in Dev** (0 of 26,257 entities), and **decided
  2026-08-18: the four `_vibe` layouts will NOT be created in Dev.** So Vibe's
  contact model has no data there and cannot get any. C1 work is therefore
  verified by READING production, which is what the resolver's 300-record
  measurement did. The standing consequence: anything needing a populated
  contact model cannot be exercised end-to-end in Dev, and that limitation
  should be stated rather than worked around.
- Historical address blocks must **not** be backfilled — they are snapshots of
  where work was actually invoiced.

**What has shipped against C1 (2026-08-18):** `api/_contactDisplay.js` rebuilds
the organization/contact names and address block from Vibe's contact model,
measured at 295/295 names and 294/295 organizations over 300 production
projects. Both write paths use it — records created from a contact, and the
contact-reassignment handlers on CCS and Trainings, which were the last
FileMaker writes on Vibe-owned layouts. RMI's e-mail and phones, blank on all
119 records, now read Vibe. **Still open:** existing records keep the names
FileMaker gave them (nothing was backfilled, deliberately), and the remaining
C1 items below are untouched.

**C1. Derived fields.** The app displays FileMaker calculations everywhere —
`zz__Display_Organization__ct`, `zz__Display_Contact__ct`, `zz__Display__ct`,
`Address_Block_Billing`. These are not decoration: the entire Contacts v2
related-work join runs on organization *name*, because the foreign key never
names the organization (0 of 3,862 inspections, 0 of 6,329 CCS projects). When
FileMaker goes, none of these compute. Every one must be derived from Vibe's own
contact model first, and every consumer repointed.

**This stopped being a future risk on 2026-08-18.** Now that CCS projects,
inspections and estimates are born in Vibe, every newly created record has a
correct `_kft__Contact_ID` and a blank organization/contact *name*, because the
name was never stored — it was calculated by FileMaker, which has no row to
calculate it from. Observed directly: a test CCS project created from a contact
showed "No contact" on its own record while holding that contact's id. The
records are correct; the display is not. Worse than a blank label: CCS,
Estimates and RMI all *search* those fields, so such a record could not be found
by typing its organization's name.

**Stopgapped the same day (v1.0.379), not fixed.** `src/config/contactDisplay.js`
stamps the names onto a record as it is created, from the contact already in
hand — so Vibe-born records display and search normally again. That pins a copy
which won't follow a later rename of the contact, where the calculation would
have; it is safe to pin only because these records have no FileMaker counterpart
to recalculate. Two things it deliberately does NOT cover, both still real C1
work: **addresses** (`Address_Block_Billing` can't be derived this way — the
contact replica's address fields read back empty, since contact addresses now
live in Vibe's own store, so printed work orders on Vibe-born records are still
blank), and **every record that already exists**. C1 remains the first thing
worth doing after Phase A.

**C2. Audit the calculations before trusting any of them.** `Sort_Order` on
inspection line items evaluates to `"?"` on every row — a broken calculation
that has been silently determining the order of printed customer reports.
Related fields can also be present, readable and empty on every record:
`rcd_cntct_PHONE__work::Number` and its siblings are populated on 0 of 1,000
CCS projects, so every work order ever generated printed "—" for Phone, Cell and
E-mail. Assume more of this exists and look before relying.

**C3. Value lists.** `useValueLists` (3 modules) reads FileMaker's own value
lists at runtime. These become Vibe-held vocabularies.

**C4. FileMaker scripts.** Script triggers do not fire over the Data API, so any
logic living in scripts has never run for a Vibe write and will not exist after
cutover. **This cannot be inventoried from the codebase — it needs Ian.** It is
the largest unknown in this plan.

---

## Phase D — Cutover

1. **Final refresh** from FileMaker. The channel works right up to this moment.
2. **Freeze FileMaker** to read-only for people. Divergence ends here; until
   then anyone editing in FMP Pro creates it, which is already true for CCS and
   Inspections.
3. **Promote `repl:` into `vibe:`** so reads stop merging. **This is the
   irreversible step and must be last** — it is what ends the refresh ability.

---

## Keeping the refresh working until then

This is the one capability to preserve, and it is mostly already right.

- `/api/sync?db=…&layout=…` runs incrementally on `zz__Modified_On`.
- `/api/sync?db=…&layout=…&full=1` re-pages a layout in full. **Required after
  adding a FIELD to a layout**: incremental sync keys on each record's
  modification date, which a schema change does not touch, so a new field
  otherwise never reaches the replica. This was not hypothetical —
  `_kft__Contact_ID` was added to `Estimates_New` on 2026-08-17 and stayed
  invisible to the app until `full=1` existed.
- Bumping a module's `CACHE_VERSION` is also needed after a field change, in all
  four places that name it (the module, `App.jsx` prewarm, `recordSources.js`,
  `relatedRecords.js`). A cached copy predating the field is otherwise served
  indefinitely.
- Refreshes cost Redis commands against a **hard monthly cap**. Exhausting it
  takes down everything Redis-backed including login, as happened on
  2026-07-19. Full re-pages are cheap one-offs; do not schedule them.

---

## Decisions

**Settled 2026-08-18**

- **Id scheme — accept the prefix.** Records born in Vibe get `V-100001`, shown
  wherever the id is shown including printed reports. Live since A1.
- **No `_vibe` layouts in Dev.** So Vibe's contact model has no data there and
  never will. Anything needing a populated contact model is verified by READING
  production instead, and that limitation gets stated rather than worked around.
- **Legacy Contacts will be retired, not extended** (B4). That is what finishes
  A3 — its edit path is deliberately staying on FileMaker until the module goes.
- **Delete means hide in Vibe, leave FileMaker alone** (A2). People working in
  FileMaker Pro keep seeing records that are gone from Vibe; the deletion is
  recoverable by hand.

**Settled 2026-08-19**

- **Only FileMaker Production is referenced from here on.** It is the current
  but soon-to-be-retired source of truth, and keeping three environments
  coherent costs more than it returns. Dev and Staging had already diverged —
  Dev never got the Contacts v2 `_vibe` layouts, and its `BOM` layout lacks
  `_kft__Item_ID__assemblyLine` which production has. Consequence worth stating:
  there is no longer a safe environment to rehearse a WRITE in, so production
  writes are verified on records created and then removed, or on obviously-test
  records — never by exercising a button that pushes to QuickBooks or Shopify.

- **QuickBooks and Shopify have ONE environment, shared by every FileMaker
  database.** So `CreateInQBO` hardcoding `env="production"` and Shopify's single
  `SHOPIFY_STORE` are correct, not gaps — a push from a Dev record reaching the
  live QuickBooks or Shopify is intended. Recorded because it looks like a
  cross-environment leak on inspection, and is not one. (The
  `QBO_SYNC_ALLOW_PROD` guard on the *sync* jobs is a separate thing: it stops
  bulk background syncs, not deliberate one-off pushes.)

**Still open**

- **A tax rate.** Estimate tax is 0 on all 2,818 production estimates and no line
  is taxable, so nothing is wrong today — but `Taxable` is a live checkbox and no
  rate is stored anywhere in the file. B1 computes tax from taxable lines times a
  rate, which is 0 until someone supplies one. **Needs Ian.**
- **Scripts and integrations.** What runs inside FileMaker today, and does
  anything other than Vibe read that database? Still the largest unknown — C4.
  One instance is already retired: B1 removes the app's only script dependency.
- **Who still opens FMP Pro, and for what.** Sharper now than when written: every
  module already moved shows them values that stopped updating, and since A2 they
  also see records that Vibe considers deleted.

---

## Rough size

Originally eight to ten working sessions, sequenced A → B → C → D strictly.
Two of those assumptions did not survive contact with the data:

- **The strict sequence did not hold, and did not need to.** C1's resolver was
  built before Phase B finished, because A4 was blocked on it — the contact
  reassignment handlers could not leave FileMaker until something could rebuild
  the names they re-derive. Phases describe dependencies, not an order to be
  obeyed when the dependency runs the other way.
- **The audit-first rule earned its keep.** Phase C's derived-field audit was
  done as its own piece of work, and it changed the phase: the address block
  turned out to be stored data needing no migration, and part of C1 turned out
  to be deleting fields rather than moving them. The same habit caught
  `estimate_li_vibe` being the wrong table before 1,267 product records were
  written into the estimate-lines store.

**Where the remaining work sits:** A is done except A4, and A4 is now gated on
exactly ONE thing — the legacy Contacts module, which B4 wants retired rather
than moved. B1, B2 and B5 are done; B3 (OE training and certifications, the only
reason that module still exists) is the real prerequisite. `TandD.jsx` and
`EOL.jsx` still call `updateRecord`, but both are `RECORDS_LOCKED` and
unreachable — they should go with the placeholder modules. C1 has shipped its resolver and both write paths; C2/C3/C4 are
untouched, and C4 remains the largest unknown because it cannot be inventoried
from the codebase.
