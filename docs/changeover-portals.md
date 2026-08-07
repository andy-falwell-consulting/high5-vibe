# Every portal, and what FileMaker work is left

**Written 2026-08-07.** Answers the question "what else will Claude need from
FileMaker before the changeover" in one pass, instead of discovering it a table
at a time.

Method: read the portal metadata from all eight layouts the app replicates, then
scan **all 512 layouts** for one whose own (unqualified) fields match each
portal's field set. A portal is migratable when its child table has a layout of
its own carrying the keys — because the Data API can only read fields placed on
a layout, and a *related* field on a parent layout returns only the first
related row.

26 portals. **23 need nothing. 3 need work.**

---

## The three that need work

### 1. Estimate line items — no layout at all

`estmt_ESTLI` on `Estimates_New`. 2,815 estimates, roughly nine lines each.

No layout anywhere in the file sits on this table. It looked at first like it
shared the inspection line-item table, but that table has **no
`_kft__Estimate_ID`** — the two are genuinely separate.

**Needed:** a layout on the estimate line-item table with its primary key, the
estimate foreign key, and `Description`, `Quantity`, `Unit_Price`, `Amount`,
`Markup`, `Taxable`, `Total_Input`, `Item_Name`, `Sort_Order`.

Worth pairing with the known trap in CLAUDE.md: the parent totals
(`zz__Subtotal__xn`, `zz__Tax__xn`, `zz__Total__xn`) **cannot be written over the
Data API** — they return `201 Field cannot be modified`. Vibe will have to
compute estimate totals itself.

### 2. Bill of materials — layout is on the wrong table

`Portal__Bill_of_Materials 4` on `Products & Services_New`, and `Items_Portal`.

`item_itmli_ITEM_billOfMaterials` exists but sits on the **Item** table (1,267
rows) with related `item_ITMLI__billOfMaterials::` fields on it — so it returns
one component per item no matter how many a product has.

**Needed:** a layout on the item line-item table itself, with its primary key,
the parent item foreign key, and `Quantity`, `Total`, `Cost`, `Total_Cost`.

### 3. Inspection line items — one field short

`inspt_INSPLI` on `Inspections_New`. The table is
`Script_Use__Inspections_Line_Items` — **208,316 rows, the largest child table in
the file** — and it already carries `_kft__Inspection_ID`,
`_kpt__Inspection_Line_Item_ID`, `_kft__Item_ID` and every data field but one.

**Needed:** place `Element_Grade` on that layout. It exists in the table and is
populated; it is simply not on the layout.

`Name` in that portal is not a field on the line item; it comes from the related
item, and `Item_Name` is already there.

---

## The 23 that need nothing

**Already have a base-table layout with keys** — these are parent records shown
as lists on a contact, so each already has its own layout the app reads:
`Portal__Estimates` (Trainings_New), `Portal__Estimates 2` (Estimates_New),
`Portal__Estimates 3` (RMI_New), `Portal__Opportunities` (Inspections_New),
`Portal__Orders` (Workshops_New), `Portal__Orders 2` (RCD_New),
`Portal__Invoices` (Invoices_New), `Portal__Payments`, `Portal__Projects`,
plus the `Copy`/`Copy 2` duplicates of the same.

**Done in this changeover already:** `cntct_PHONE` → `Phones_vibe`,
`cntct_INADR` → `Emails_vibe`, `cntct_ADDR` → `Addresses_vibe`,
`RCD_Pics`, `Inspections_Pics`, `Training_Pics`.

**`Portal__Contacts`** shows related contacts with their phone and email. Its
join is `Contact_rltn` and its data is the phone/email tables — all three
migrated, so it is covered without further work.

**Display-only, nothing to migrate:** the `CNTCT` and `RMI` portals contain only
`zz__` display calculations.

---

## The rule, for next time

Anything Vibe must migrate needs **a layout whose base table is the table holding
the rows**, with the keys and data fields placed directly on it.

- A related field (`Table::field`) on a parent layout returns only the **first**
  related row.
- A field can be **queryable without being readable**: a find on `RCD_Pics` by
  `rcd_id` matches records, and the field is absent from every row returned.
- Layouts named `Script_Use__…` usually have **no fields on them at all**, even
  though the table behind them is full.
