# OE Lookups — creation scope

**Status:** scoped, not built. Measured against FileMaker Production
(`High5_Core4`) on 2026-08-19.

Creating an OE Lookup is one of the two remaining prerequisites for the Phase D
cutover (the other is `trainings_New`). Both are *features*, not migrations —
nothing anywhere in the app has ever created either record type, so there is no
create path to rewire. On cutover day FileMaker goes read-only, and without
this nobody can add a program at all.

---

## Is it actually needed? Yes — measured

`OELookup_New` is not a dormant table. Records by `Program Start Date` year:

| Years | Records/yr |
|---|---|
| 2000–2019 | ~25–60, steady |
| 2020–2023 | 54, 57, 54, 33 |
| 2024 / 2025 | 34 / 40 |
| **2026** | **37** |
| **2027** | **38** |

1,241 records total. **2027 is already populated**, so next season's catalogue
is being planned in this table right now. Roughly **40 new records a year** —
low volume, but continuous and forward-looking.

---

## What creation actually involves

Structurally this is the **simplest creation we have built**. The layout is 16
flat fields: no portals, no child collections, no line items.

```
Program Type          Program Code            Open Enrollment or Custom
Program Start Date    Program End Date        Program Start/End Time
Lead Facilitator      Co Trainer 1 / 2        Custom Site:
Tuition (n)  Food (n)  Lodging (n)  Hours     Facilitator's Notes
```

Compare: Estimates needed line items *and* a totals rewrite; Products needed a
BOM *and* SKU assignment. This needs neither.

There are four real problems, and none of them is the form.

---

### 1. There is no primary key — a decision is required

`OELookup_New` exposes **no `_kpt__` field at all**, and `VIBE_PK` has no entry
for it. `createVibeRecord` would throw `no primary key known for OELookup_New`.
Every other Vibe-owned layout keys on a business id that survives FileMaker's
retirement. This one has nothing to key on but FileMaker's own recordId, which
is exactly the internal that dies at cutover.

Two ways out:

- **(a) Ask Ian to add `_kpt__OELookup_ID`** to the table and layout, then
  backfill it. Consistent with all seven other layouts, keeps the replica join
  clean, and makes Vibe-born `V-` ids reconcilable. **Recommended.** Note this
  needs a `full=1` re-sync afterwards — incremental sync keys on
  `zz__Modified_On` and a schema change does not touch it (the same trap that
  hid `_kft__Contact_ID` on Estimates for a day).
- **(b) Vibe mints `V-` ids; FileMaker-born rows keep keying on recordId.**
  No FileMaker work, but it leaves one layout keyed differently from every
  other, and the join gets fragile precisely when FileMaker is being retired.

### 2. `Program Code` has to be generated, and it is the SKU problem again

Codes look like `AB-0003`, `AGI-0001`, `MAP-0001` — a per-program-type prefix
plus a 4-digit sequence. 1,238 of 1,241 rows carry one; **1,232 are unique**,
so there are already 6 collisions and one row whose code is literally `"AB-"`
with no number.

This is the same shape as product SKUs, which we already solved: a single
authoritative counter (`api/next-sku.js`) rather than a FileMaker script
trigger. The same pattern applies — a per-prefix counter in Redis, seeded from
the current maximum per prefix. **Do not** derive the next code by scanning the
replica at write time; that is how the 6 existing collisions happen.

Open question for Ian: are the 6 duplicate codes meaningful, or dirt?

### 3. `Open Enrollment or Custom` is a dirty free-text vocabulary

Actual stored values:

```
"Open Enrollment" | "Custom" | "OPEN ENROLLMENT" | "Open Enrollement" | "Open Enrollment  " | ""
```

Five spellings of two concepts, including a typo and a trailing-space variant.
The layout declares **no value list**, so nothing constrains it.

Creation must write one canonical value. This is a **C3 overlap** — it is
exactly the "FileMaker value lists become Vibe-held vocabularies" work, and
doing it here means C3 gets slightly smaller. Existing rows should be
normalised in the same pass, or filtering by this field stays unreliable.

### 4. Vibe does not own edits on this layout

`OELookup_New` is in `VIBE_DELETES` but **not** in `VIBE_OWNED` — deletion moved
in A2, edits never did. Shipping creation alone would let someone create a
record in Vibe and then be unable to correct a typo in it.

**Creation must come with edit ownership**, i.e. the A3 step this layout never
got. That is small — the module is 295 lines and already uses the shared
controls — but it is not zero, and it belongs in this scope rather than after it.

---

## What this scope does NOT include

**The workshop confirmation email** (Andy, 2026-08-19: a new feature for OE
Lookups, to be built after creation). Scoped out, but two findings from this
investigation should be recorded now because they shape it:

- **Registrations do not link to OE Lookups by any key.** `Workshops_New` has no
  FK to `OELookup_New`. It carries `Course Number` in a *different* scheme —
  `AB-2026-5` (`prefix-year-sequence`) versus the lookup's `AB-0003`
  (`prefix-sequence`). Verified: searching `Workshops_New` for the first six
  Program Codes returned **0 matches each**. So "who registered for this
  program" is not currently an answerable query, by id or by code. Any email
  feature has to establish that link first — a real design question, not
  plumbing.
- **The registrant's email address is not reachable on the Workshops layout.**
  `wkshp_cntct_INADR__email::zz__Address__ct` is present and **empty on all 400
  sampled rows** — the same "related field present, readable and empty" trap C2
  warns about. The good news: the address is reachable from Vibe's own contact
  model via `_kft__Contact_ID`, which B4/B5 already moved. So the email feature
  should resolve recipients through Vibe, not through FileMaker's relationship.
- `email_version_sent` records which template went out — values seen are
  `Training`, `Exam_L1`, `Exam_L2`, `Exam_L3`. So there are at least four
  variants to rebuild, not one.

---

## Proposed order

1. Decide the key (§1). If (a), Ian adds the field — everything else can proceed
   meanwhile.
2. Give the layout edit ownership (§4) — the missing A3 step.
3. Canonicalise `Open Enrollment or Custom` and normalise existing rows (§3).
4. Program Code counter, seeded per prefix from the current max (§2).
5. The create form itself — 16 flat fields, the smallest part of the work.

Steps 2–5 are one focused session. Step 1 is the only one that can block, and
only under option (a).
