# OE Trainings — module scope

**Status:** scoped, not built. Measured against FileMaker Production
(`High5_Core4`) on 2026-08-19.

A new module over `Workshops_New`, the other half of OE Lookups.

---

## What a row is

**One person registered on one course session.** Verified directly — course
`AB-2026-1` has six rows: six different people from six different organizations,
each paying the same $835.

| | Value |
|---|---:|
| Rows | **5,217** |
| With a Course Number | 5,024 |
| Linked to a contact | 5,142 |
| Distinct course numbers (recent 1,200 rows) | 155 |
| Registrants per session | min 1, **avg 7.6**, max 105 |
| Registrations with a balance owing | **1,225** |
| Cancelled | 302 |

---

## How it relates to OE Lookups

Parent and child, and **FileMaker states the relationship explicitly**: the
`Course Number` field carries a value list literally named **`OELookup`**.
Choosing a course number on a registration means choosing an OE Lookup record.

| | OE Lookups | OE Trainings |
|---|---|---|
| What it is | the offering — a scheduled session | the roster — who signed up |
| Rows | 1,247 | 5,217 |
| Key | `Program Code` | `Course Number` |
| Example | *Adventure Basics L1, June 2026, Phil Brown, $835* | *Colin Whiston, $835, paid* |

Joined on `Program Code` = `Course Number`. Both converged on `PREFIX-YYYY-N`
around 2020; **33 of the first 40 modern OE Lookup codes match a Course Number
exactly.** (An earlier draft claimed they did not link — that test used
year-2000 legacy codes, which match nothing. Corrected 2026-08-19.)

The asymmetry between the two is the business rhythm: **OE Lookup holds 38
programs starting in 2027; Workshops holds 0 registrations for them.** The
catalogue runs ahead, the roster fills in behind.

---

## What the module does

Organised **by session, not by registration** — the sidebar lists course
sessions, selecting one shows its roster. That is how the work is actually done
("who is coming to Adventure Basics in June?"), and it makes the pairing
obvious: OE Lookups is where you create the offering, OE Trainings is where you
manage who is on it.

Each registration carries real operational weight:

- **Money** — Tuition / Food / Lodging / Extra Lodging, Fee Total, Deposit Due,
  Deposit Received, Balance Due, Check Number, PO #, payment method
  (Check / Amex / Discover / MasterCard / Visa).
- **Admin flags** — Release Form Received, Lead Letter Sent, deposit invoice
  sent, Invoice Sent.
- **QuickBooks** — invoice and estimate ids (235 of the recent 1,200).
- Diet restrictions, notes, site, instructor, hours.

---

## The four things to settle

### 1. The store is keyed by the wrong thing

B3 migrated all 5,142 workshops into `vibe:{db}:oetrn` — a hash **keyed by
contact**, because it was built to fill a tab on a contact record. A
session-centric page needs to read **by course number**, and against this store
that means pulling all 2,689 contact buckets and regrouping on every load.

**Note `Workshops_New` is NOT replicated** (`api/_replica.js`). There is no
`repl:` copy to fall back to — the B3 store is already the only copy Vibe has,
and therefore already the system of record for this data. Whatever the module
writes, it writes there.

Two ways forward:

- **(a) Normalise: one hash keyed by `_kpt__Workshop_ID`, plus two id-list
  indexes (by contact, by course).** Both pages then read one index and one
  batch. Costs a rebuild pass over 5,142 rows — cheap, and the rows are already
  in Redis so FileMaker is not involved. **Recommended.**
- **(b) Add a by-course index alongside the existing by-contact hash.** Less
  work now, but the same row is then stored twice and the two copies can drift —
  the failure mode is a roster that disagrees with a contact's own tab.

### 2. The money fields are FileMaker calculations — and they are solved

`Fee Total`, `Balance Due` and `Deposit Due` are calculations, so they freeze at
cutover (the C2 class). Same shape as estimate totals, which B1 fixed by
computing on read.

**The arithmetic is fully determined.** Measured over 1,500 recent rows:

| Field | Rule | Agreement |
|---|---|---:|
| `Fee Total` | Tuition + Food + Lodging + Extra Lodging | **1500 / 1500** |
| `Balance Due` | Fee Total − Deposit Received | **1500 / 1500** |
| `Deposit Due` | Fee Total ÷ 2 | **1397 / 1397** *(103 rows have a zero fee)* |

No exceptions, no rounding drift. Compute all three on read and they can never
go stale — unlike the stored estimate totals, which had already drifted on ~3%
of records before B1.

### 3. 75 registrations are invisible to Vibe, and 3 of them are current

B3 attaches rows to contacts, so the 75 rows with no `_kft__Contact_ID` were
dropped. Most are historical junk — only 9 of the 75 even have a course number,
the rest have neither.

But **three are 2026 registrations**, including two on `L2-2026-1` at $235 each.
A session roster built today would silently omit two paying attendees.

A by-course index keyed on `Course Number` rather than on contact would include
them, which is a further argument for (a). The 66 rows with neither key stay
out, correctly — there is nothing to attach them to.

### 4. The registrant's e-mail is not on this layout

`wkshp_cntct_INADR__email::zz__Address__ct` is present and **empty on all 400
rows sampled** — the C2 "related field present, readable and empty" trap again.
Resolve recipients through Vibe's contact model via `_kft__Contact_ID`, which
B4/B5 already moved. Favourable: the data we need is in the half we own.

---

## Out of scope

- **The confirmation e-mail.** Andy, 2026-08-19: a later feature. This module is
  where it belongs — `Confirmation_Email_DTS` and `email_version_sent` (four
  templates: `Training`, `Exam_L1`, `Exam_L2`, `Exam_L3`) live on these rows —
  but it is not part of building the page. Nothing here should foreclose it;
  §4 is the piece it will need.
- **Shopify.** `shopify_order_id` and `shopify_product_id` exist on the layout
  and are populated on **zero** rows. Carry them, display nothing.
- **`Status`.** Only populated for the 302 cancellations; active registrations
  leave it blank. Treat as a cancellation flag, not a pipeline.

---

## Proposed order

1. Decide the store shape (§1). Everything else depends on it.
2. Rebuild the store and indexes; verify counts against FileMaker's 5,217.
3. Read-side totals (§2) — the arithmetic is already proven.
4. The module: session list → roster, money, admin flags.
5. Edit ownership for registrations, then creation.

Steps 2–4 are one session. Step 5 is a second, and needs its own decision about
whether a registration can be created from the roster, from a contact, or both.
