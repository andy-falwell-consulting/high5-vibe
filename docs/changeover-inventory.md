# What breaks when FileMaker stops computing

**Written 2026-08-06.** Input to the changeover date decision.

FileMaker does not only store the data — it *derives* a slice of what the app
displays, and it *hosts* every photo and attachment. The final refresh gets Vibe
correct data on day one; after that, anything FileMaker was computing freezes at
its last synced value and silently rots.

This is the list of what that actually covers. Field classifications come from
asking FileMaker's own layout metadata, not from reading code.

---

## Headline

**The calculation problem is much smaller than feared.** Across all eight
replicated layouts there are 413 fields, of which 40 are computed — and the app
reads only **six distinct derivations**, four of which are the same idea
repeated.

**Both of those turned out smaller than this document first assumed.** The
file problem was 130 files totalling 41 MB and is now done. The portal problem
is 3 tables needing a layout, not 23 — see docs/changeover-portals.md.

| | Count | Assessment |
|---|---|---|
| Distinct computed values the app reads | 6 | tractable — Vibe can compute all six |
| Portals the app reads | 26 | swept 2026-08-07 — 23 need nothing, 3 need FileMaker work (docs/changeover-portals.md) |
| Layouts with container (file) fields | 3 with data | **done** — 130 files, 41 MB, migrated and hash-verified (v1.0.305) |

---

## 1. Computed fields — tractable

Per layout, as FileMaker reports it:

| Layout | Fields | Stored | Computed | Computed *and read by the app* |
|---|---|---|---|---|
| RCD_New | 100 | 92 | 8 | 3 |
| Contacts_New | 51 | 35 | 16 | 4 |
| trainings_New | 113 | 107 | 6 | 6 |
| RMI_New | 34 | 30 | 4 | 4 |
| Estimates_New | 31 | 29 | 2 | 1 |
| Inspections_New | 37 | 36 | 1 | 1 |
| Products & Services_New | 31 | 28 | 3 | 0 |
| OELookup_New | 16 | 16 | 0 | 0 |

Collapsed, the app depends on six things:

**A. Related-record display names** — `zz__Display_Organization__ct` (13 files),
`zz__Display_Contact__ct` (12), `zz__Display__ct` (6), and the
`zz__Address__ct` email variants (up to 4).

All the same shape: *show the name of a linked contact or organisation*. Vibe can
compute every one of them, on the condition that it holds the link. That
condition is Phase 2 — it is another reason contacts come next.

**B. Trainings money** — `TOTAL COSTS`, `Act ProgTotal`. Arithmetic over stored
fields on the same record. Trivial for Vibe once the formulas are transcribed
from FileMaker.

That is the whole calculation exposure. It is a day or two of work, not a
project.

---

## 2. Portals — the real work

23 portals are read by the app. They are one-to-many relationships, and **Vibe
has no way to store one-to-many data today.** Fragments hold flat `fieldData`.

Three groups:

**Already broken, so nothing is lost.** `Portal__Invoices`, `Portal__Payments`
and `Portal__Estimates 2` on RCD are filtered by FileMaker *global* fields, which
a Data API session never receives — they return hollow rows and no payments.
That is why the CCS financials were rewired to read live from QuickBooks. These
can be deleted rather than migrated.

**Genuinely live and needed:**

| Portal | Where | Note |
|---|---|---|
| `cntct_PHONE`, `cntct_INADR`, `cntct_ADDR` | Contacts | phones, emails, addresses — the core of a contact |
| `Portal__Contacts` | Contacts | people at an organisation |
| `estmt_ESTLI` | Estimates | line items, 11 fields |
| `inspt_INSPLI` | Inspections | inspection lines |
| `Portal__Bill_of_Materials 4` | Products | BOM |
| 14 portals total on Contacts_New | Contacts | by far the heaviest layout |

**Contacts alone reads 14 portals.** That is where the one-to-many design has to
be settled, and it is the largest single piece of the migration. It is not in
[the plan](vibe-owns-the-record.md) yet.

---

## 3. Files — not in the plan at all

Every photo and attachment lives in a FileMaker **container field**, served
through `/Streaming_SSL` and uploaded via `uploadContainer`. Eight modules touch
them:

`Inspections`, `ProductsAndServicesV2`, `AttachmentsPanel`, plus
`ccsAttachments`, `recordAttachments`, `inspectionAttachments`,
`trainingAttachments`.

Portals `RCD_Pics` and `Inspections_Pics` are container-backed.

**When FileMaker goes away, so do the files** — not just their metadata, the
bytes. Nothing in the current plan moves them, and a final data refresh does not
either, because the sync only ever copies `fieldData`.

This needs its own decision: object storage, Drive, or accept losing them. It
should be costed before a changeover date is committed to, because it is likely
the longest lead item here.

---

## 4. What this changes

**Sequencing.** Contacts is now clearly next, for three reasons that all point
the same way: it unblocks adding a person, it holds the links the display-name
derivations need, and it is where one-to-many must be solved.

**Scope.** Two things are missing from the plan and should be added before a date
is set:

1. A one-to-many model for Vibe (portals)
2. A home for files (containers)

**Reassurance.** The calculation exposure — the thing that looked most alarming —
is six values, and Vibe can compute all six. That was worth checking rather than
assuming.

---

## Open decisions

| Decision | Needed before |
|---|---|
| Where files live after FileMaker | setting a changeover date |
| How Vibe stores one-to-many data | Phase 2 (contacts) |
| Transcribe the two trainings formulas | Phase 3 |
| Whether the three hollow RCD portals are simply deleted | Phase 2 |

## Method

Field classification came from `GET /fmi/data/v2/databases/{db}/layouts/{layout}`
against production, which returns `fieldMetaData` (with FileMaker's own
`normal` / `calculation` / `summary` classification) and `portalMetaData`. Usage
counts come from matching each field and portal name against every `.js`/`.jsx`
file under `src/`. Read-only throughout.
