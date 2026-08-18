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

## Where we are

Eight layouts are replicated (`api/_replica.js`).

| Layout | Records | Edits owned by | Creation | Deletion |
|---|---:|---|---|---|
| `RCD_New` (CCS) | 6,436 | **Vibe** | FileMaker | FileMaker |
| `Inspections_New` | ~4,900 | **Vibe** | FileMaker | FileMaker |
| `trainings_New` | 2,478 | **Vibe** (2026-08-18) | FileMaker | FileMaker |
| `Contacts_New` | 15,582 | FileMaker | **Vibe** (`V-` ids) | **Vibe** (tombstone) |
| `Estimates_New` | 2,817 | FileMaker | FileMaker | FileMaker |
| `Products & Services_New` | 1,267 | **Vibe** (2026-08-18) | FileMaker | FileMaker |
| `OELookup_New` | 1,247 | FileMaker | FileMaker | FileMaker |
| `RMI_New` | 117 | **Vibe** (2026-08-18) | **Vibe** (2026-08-18) | FileMaker |

Child collections:

| Collection | Rows | Home |
|---|---:|---|
| Contact phones / emails / addresses | 36,663 | **Vibe** |
| Inspection line items | 208,068 | **Vibe** |
| Attachments (all modules) | — | **Vibe** (Drive + Redis) |
| Estimate line items (`estmt_ESTLI`) | ~25,000 | FileMaker |
| Bill of materials (`item_ITMLI`) | — | FileMaker |
| Contact relationships (`cntct_RLTN`) | 23,302 | FileMaker (superseded by Vibe affiliations) |
| OE training (`cntct_WKSRG`) | — | FileMaker, no module |
| Certifications (`cntct_CTFC`) | — | FileMaker, no module |

Roughly: **5 of 8 layouts own their edits (1 of those — RMI — also owns
creation); 3 of 8 child collections have moved.**

Products & Services' move was scoped narrower than the others on purpose:
field edits (including the Shopify/QuickBooks id write-backs after a sync
push, which are just field writes) went to Vibe, but its Bill-of-Materials
portal writes and record creation are deliberately still FileMaker — BOM is
its own migration (B2 below), and creation is entangled with SKU assignment
plus live Shopify/QBO pushes, which deserves dedicated attention rather than
being carried along incidentally.

---

## Phase A — Close the write paths

Nothing can be decoupled while FileMaker is still the writer.

**A1. Generalise record creation — done.** `api/vibe-record.js`'s `{create:
true, fieldData}` path is live, writing `__created: true` via the same
per-table id allocator `api/_contacts.js` uses (`VIBE_PK`, checked in
`api/_vibeStore.js`). Two modules call it today — Inspections (first) and RMI
(2026-08-18) — both confirmed skipping the FileMaker create round-trip and its
per-user-FMP-account requirement entirely. Remaining: wire the other Vibe-owned
modules (RCD_New, trainings_New) onto it too — they still create via FileMaker
even though their edits don't.

**A2. Generalise deletion.** Tombstones (`__deleted`) instead of `deleteRecord`.
The store supports them; `DeleteRecordButton` is one shared component, so this is
a single change covering every module. Still open even for the four
edit-owning layouts — deleting a CCS project, inspection, training or RMI
inquiry all still call FileMaker today.

**A3. Extend `VIBE_OWNED`** to the remaining layouts, one module per change.
5 of 8 done (RCD_New, Inspections_New, trainings_New, RMI_New, Products &
Services_New — the last one edits-only, see the note above the table).
Remaining: `Estimates_New` (carries the known totals-can't-be-written trap,
see B1), `OELookup_New` (currently read-only — no edit or create path exists
in the UI at all, so "extending" it is really "building one," a bigger job
than the others), `Contacts_New` (edits only — its creation and deletion are
already Vibe's, per the table above; also see B5 on why Contacts_New's
*edit* path may not even be the right thing to extend — B4 wants the whole
legacy module retired instead once B3 lands).

**A4. Delete the FileMaker write token.** `getToken({ write: true })` in
`src/api/filemaker.js` is the single chokepoint every mutating call routes
through. Removing it makes "we still write to FileMaker" *impossible* rather
than merely untrue, and retires the per-user-FMP-account failure class.

---

## Phase B — Move the remaining child collections

**B1. Estimate line items.** Layouts already created. Carries a known trap: the
parent totals (`zz__Subtotal__xn`, `zz__Tax__xn`, `zz__Total__xn`) cannot be
written over the Data API at all — they return `201 Field cannot be modified` —
so an app-added line leaves the stored total stale today. Moving to Vibe *fixes*
this, because Vibe computes the total itself.

**B2. Bill of materials** (Products).

**B3. OE training and certifications.** No module and no data source today.
These two are the only reason the old Contacts page still exists.

**B4. Retire the old Contacts module** once B3 lands.

**B5. Repoint search and the agent to the new contacts model.** Contacts v2
(organizations, people and affiliations as separate Vibe entities —
`api/_contacts.js`, `api/contacts.js`, `api/contacts-write.js`) shipped
2026-08-06/07, ahead of where `contacts-model.md` says it stands. But two
other subsystems still only know about the pre-rebuild world:

- **Global search (`⌘K`).** `src/config/recordSources.js`'s `contacts`
  entry reads the old `Contacts_New` FileMaker replica (`layout:
  'Contacts_New', cv: 2`), not Vibe's own `vibe:{db}:person` /
  `vibe:{db}:org` stores. Reported 2026-08-18: **a global search finds
  organizations but not people.** Needs a source pointed at the new model
  (or a second one added alongside), same repointing C1 already calls for
  on derived fields — this is the search index's version of that problem.
- **The agent** (`api/agent.js`). Still references `layout: 'Contacts_New'`
  and carries no context describing the org/person/affiliation split, so it
  has no way to answer a contact question using Contacts v2's real data or
  to explain the new structure to whoever asks it something.

Same root cause as B4: two Contacts systems exist right now, and most of
the app outside `ContactsV2.jsx` itself still assumes the old one.

---

## Phase C — Remove FileMaker from the read path

The highest-risk phase, and the risk is not the record data.

**C1. Derived fields.** The app displays FileMaker calculations everywhere —
`zz__Display_Organization__ct`, `zz__Display_Contact__ct`, `zz__Display__ct`,
`Address_Block_Billing`. These are not decoration: the entire Contacts v2
related-work join runs on organization *name*, because the foreign key never
names the organization (0 of 3,862 inspections, 0 of 6,329 CCS projects). When
FileMaker goes, none of these compute. Every one must be derived from Vibe's own
contact model first, and every consumer repointed.

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

## Decisions wanted before Phase A finishes

**Id scheme.** Contacts born in Vibe get `V-100001`. An inspection number is
printed on the report that goes to customers, where a prefixed id would look
wrong. Continue FileMaker's numeric sequence for those, or accept the prefix?

**Scripts and integrations.** What runs inside FileMaker today, and does anything
other than Vibe read that database?

**Who still opens FMP Pro, and for what.** Every module already moved shows them
values that stopped updating.

---

## Rough size

Eight to ten working sessions, sequenced A → B → C → D strictly, since each
depends on the last. Phase C's derived-field audit should be done as its own
piece of work before any code is written for it — it is the phase most likely to
surface something that changes the plan.
