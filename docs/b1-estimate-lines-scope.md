# B1 — moving estimate line items to Vibe

**Scoped 2026-08-18**, measured against production, read-only. Nothing built.

The decoupling plan calls this the piece that "means Vibe computing the totals
itself first," and treats that as the hard part. Measuring it changed the
picture in both directions: the totals are much easier than assumed, and the
migration has a prerequisite the plan does not mention.

---

## 1. The totals are trivial arithmetic

The fear was reproducing FileMaker's `ESTMT__Trigger__Sum_Line_Items - API`
script without knowing what it computes. Measured across **all 2,818 production
estimates**:

| | |
|---|---:|
| Estimates with `zz__Tax__xn` > 0 | **0** |
| Largest tax on any estimate | **0** |
| Estimates where `Total ≠ Subtotal + Tax` | **0** |
| Sampled lines with `Taxable` set | **0 of 263** |

So the rule is:

```
Subtotal = sum of line Amount
Tax      = 0
Total    = Subtotal
```

There is no tax rule to reverse-engineer because **tax has never been charged**.
That removes the stated blocker for this phase entirely.

**The caution that replaces it:** `Taxable` and `Markup` are real fields on the
line, and `estmt_ESTLI::Taxable` is a live checkbox in FileMaker even though
nobody has ticked it. Hard-coding `Tax = 0` would silently under-charge the
first estimate that ever needs tax. Vibe should compute tax from the taxable
lines and a rate, arriving at 0 for all existing data by arithmetic rather than
by assumption — the same result today, and correct on the day it changes.
**A rate is not stored anywhere I can find; that needs Ian.**

## 2. The stored totals are ALREADY wrong

Of 60 sampled estimates with lines, **58 subtotals equal the sum of their own
lines and 2 do not**:

| Estimate | Stored subtotal | Sum of its lines | Difference |
|---|---:|---:|---:|
| 1008 | 862.71 | 812.71 | **+50.00** |
| 1032 | 2,286.89 | 2,692.89 | **−406.00** |

Both differences are round numbers, which is the signature of a line added or
removed without the recalc script firing — exactly the staleness the plan warns
about ("an app-added line leaves the stored total stale"). It is not a
hypothetical risk to be weighed against moving; it is **already happening in
production at roughly 3%**, and moving to Vibe is what fixes it, because Vibe
computes the total on read instead of storing a snapshot that can drift.

## 3. The prerequisite the plan doesn't mention

Inspection line items — the precedent, 208,416 rows — were migrated by
`api/inspection-lines-migrate.js` reading **the line-item table's own layout**,
`Script_Use__Inspections_Line_Items`, 1,000 rows a page, staged then promoted.

Estimate lines cannot be read that way today:

- **The replica's list scan carries no portal data at all.**
  `/api/records?layout=estimates` returns 2,818 records and zero `portalData`.
- Portal rows come back only from the **single-record** read, which would mean
  2,818 round trips — and FileMaker's portals **cap at 50 rows by default**, so
  a long estimate would silently truncate.

So B1 needs a layout exposing the estimate line-item **table**, the way
inspections have one. Whether such a layout already exists is the open question,
and it is the same shape of dependency that stopped the contacts migration in
Dev. **This needs checking in FileMaker before any code is written.**

---

## Proposed shape, once that is answered

Replicate the inspection-lines pattern rather than inventing one:

1. `api/_estimateLines.js` — the store, mirroring `api/_inspectionLines.js`.
2. `api/estimate-lines-migrate.js` — paged read of the line-item layout, staged
   by estimate, promoted on `finish`. Mirrors the inspection migration
   including its resumability.
3. `src/api/estimateLinesVibe.js` — replaces `src/api/estimateLines.js`;
   list/add/update/delete against Vibe, and **totals computed here** rather than
   requested from a FileMaker script.
4. The three stored total fields become derived. They stay in the replica and
   are simply no longer read — nothing writes them, so nothing can drift.

The `RECALC_SCRIPT` call disappears with them, which also removes the app's only
dependency on a FileMaker script running — the Phase C4 problem, retired early
for this one layout.

## What this unblocks

B1 is the largest of the five remaining FileMaker write paths, so finishing it
takes A4 (deleting the write token) from "blocked on five things" to "blocked on
four", and removes the only one whose blocker was believed to be unsolved.
