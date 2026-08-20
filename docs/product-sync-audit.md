# Products & Services ↔ QuickBooks ↔ Shopify — audit

**Measured against production on 2026-08-20.** Read-only: nothing in this audit
changed anything in any of the three systems.

---

## 1. What is the source of truth

**Vibe, for most fields — but the split is real and undocumented until now.**

| Field | Owner |
|---|---|
| `Name`, `Description`, `Unit_Price`, `Type`, income account | **Vibe** |
| `_kat__Item_ID_QuickBooks`, `_kat__Item_ID_Shopify`, `_kat__Item_Variant_Id` | **Vibe** (link ids) |
| `SKU` | **Vibe** — its own counter since 2026-08-20 (was Tray) |
| `shopify_description` | **Shopify** — `shopify-desc-sync.js` says so: *"Shopify is the source of truth — always overwrites"* |

So one field flows the opposite way from every other. That is not wrong, but it
is not obvious from the code either. SKU used to be a second oddity — owned by a
third-party workflow — and no longer is; see §6.

**The join key is SKU**, which is a real business key present in all three
systems (`SKU` / QBO `Item.Sku` / Shopify `variant.sku`). Stored link ids are
trusted first; SKU is what finds records that *should* be linked and aren't.

---

## 2. How a change in Vibe propagates

Two paths, both one-way (Vibe → out).

**Manual** — a per-product sync button per target.

**Automatic on save** — only when **both** conditions hold:

1. the edited field is one of five — `Name`, `Unit_Price`, `Description`, `SKU`,
   `QuickBooks_Account_Income` (`AUTO_SYNC_FIELDS`)
2. the product **already has** a link id for that system

Everything else is silent. Editing a product that has never been pushed pushes
nothing; changing `Type`, or the Shopify status, or anything outside those five,
tells neither system.

### The fire-and-forget defect

`handleSyncPush('shopify')` was called **without `await`**. The save reported
"saved" whether or not the push succeeded, and a failure showed a red indicator
that cleared itself after five seconds. Nothing was retried, queued or recorded —
a push that failed while nobody was looking left no trace at all.

**Fixed 2026-08-20** — see §5.

---

## 3. How drift is prevented

**It isn't.** There is detection, and no prevention.

`api/product-reconcile.js` performs a proper three-way comparison and is well
built. It is also **read-only, manual, and on no schedule.** The cron list covers
invoices, estimates, transactions, distance, QBO health and backups. Products are
not among them. Nothing watches, nothing alerts, nothing corrects.

There is no inbound sync at all beyond `shopify_description`, so an edit made
directly in QuickBooks or Shopify simply stays there, indefinitely.

---

## 4. What that has actually produced

Reconciler run, production, 2026-08-20:

| | |
|---|---:|
| Products in Vibe | 1,267 |
| QBO items | 653 |
| Shopify variants | 420 |
| **Cleanly linked** | **369 QBO · 312 Shopify** |
| **Name drift (QBO)** | **71** |
| **Price drift** | **7 QBO · 6 Shopify** |
| **Broken links** (stored id no longer resolves) | **8 QBO · 8 Shopify** |
| Linkable but unlinked (SKU matches, no id stored) | 62 QBO · 11 Shopify |
| Orphans (exists there, absent here) | 25 QBO · 40 Shopify |
| Products with no SKU | 336 |
| Duplicate SKUs | 12 Vibe · 3 QBO · 3 Shopify |

**About 19% of linked QBO items carry a name that no longer matches Vibe.**
Thirteen products disagree on price across systems. Sixteen stored links point at
records that no longer exist.

The 750 QBO / 930 Shopify "no match" figures are mostly not a problem — not every
product is invoiced or sold online. The **336 with no SKU** are: SKU is the join
key, so those can never be linked to anything.

---

## 5. Fixed in this pass

**Fire-and-forget became fire-and-report.** The push is awaited, its outcome is
recorded on the record, and a failure is stated rather than flashed. See
`v1.0.468`.

---

## 6. Move SKU assignment into Vibe — DONE 2026-08-20

### What the counter actually is

Not what the name suggests. Measured across all 931 products carrying a SKU:

| Shape | Count | What it is |
|---|---:|---|
| 1–6 digits | 378 | **the Tray counter** — range **123 → 2512** |
| 12–14 digits | 36 | **ISBNs**. Books. Never came from a counter |
| starts with a letter, or digits-then-dash | 499 | **vendor part numbers** — `115-STAP500x08`, `106K-GAC9/375-0000` |
| other | 18 | miscellaneous |

Six numeric values sit far above the sequence — 55504, 145071, 145072, 145074,
320966, 321574, 852491 — which are vendor codes that happen to be numeric, not
counter output.

**So the counter issues small sequential integers and nothing else.** Two-thirds
of SKUs in the system never came from it and never will. Any replacement has to
issue the next integer and leave every other kind alone.

Also measured: **370 unique counter values with 8 duplicates**, and the sequence
is gappy near the top — 2422→2424, 2442→2445, 2446→2464, 2464→2490, 2497→2505.
Gaps are expected (a burned number, a deleted product). The duplicates are not,
and mean the current mechanism has already collided.

### Why move it

The counter lives in a Tray workflow reached over a webhook
(`TRAY_SKU_WEBHOOK_URL`). Two independent consumers draw from it: `api/next-sku.js`
for products created in Vibe, and a FileMaker script trigger for products created
in FMP Pro. That second consumer **disappears at cutover**, and when it does the
only remaining reason for the counter to be outside Vibe disappears with it.

Leaving it where it is means Vibe cannot create a product if Tray is down, and a
number nobody at High 5 can inspect governs a business key.

### What was built

`api/_sku.js` owns the counter; `api/next-sku.js` issues from it and no longer
calls Tray. **Vibe's counter starts at 3000**, not at the measured maximum, and
that difference is the whole point:

> Seeding from observed data would have been wrong. The sequence is gappy right
> at the top — 2497 → 2505, 2505 → 2508 — and those gaps are numbers Tray has
> ALREADY ISSUED that never reached a saved product. Tray's true counter is
> therefore above 2512, and Vibe cannot see how far above. The prerequisite
> below was never satisfiable from this side, so the design stopped needing it:
> give the two counters ranges that cannot meet instead of trying to line them
> up.

3000 leaves Tray 488 issues of headroom before it could reach Vibe's floor,
which at any rate this catalogue has seen is years, and cutover retires Tray
long before that. It also leaves a rule that stays readable in the data: **a
numeric SKU at or above 3000 was issued by Vibe.** Numeric vendor codes (55504,
145071, 320966, 852491) sit above 10000 and are clear either way.

The one-time gap from 2512 to 3000 is cosmetic. Admin → Product drift shows the
counter, read-only — GET consumes nothing, so looking cannot burn a number.

**Still to do at cutover:** disable the FileMaker script trigger that draws from
Tray, and retire the Tray workflow itself. Until then both counters run, safely
apart.

### The original plan, for the record

1. **Seed a Redis counter from the measured maximum.** `vibe:{db}:seq:sku`, set
   to the highest counter-style value observed — 2512 today, re-measured at the
   moment of the move. Same shape as `nextRecordId` and the Program Code counter,
   both of which already work this way.
2. **Point `api/next-sku.js` at it**, keeping the Tray call behind an env flag
   for one release so a rollback is a config change rather than a deploy.
3. **Do it while FileMaker is still writing.** This is the ordering that matters:
   until cutover, FMP Pro can still create a product and draw from Tray. Two
   counters issuing into one namespace collide. So either
   - move it **at** cutover, when the FMP consumer is already gone, or
   - move it **before**, and have Tray's counter fast-forwarded to sit above
     Vibe's reserved block so the two cannot meet.

   The second is more work and can be done at any time; the first is free and can
   only be done once. **Recommend doing it at cutover**, as part of Phase D.
4. **Do not renumber anything.** The 499 vendor SKUs, 36 ISBNs and 18 oddities
   stay exactly as they are. The counter only ever issues the next integer.
5. **Report duplicates rather than fixing them.** Eight collisions already exist.
   Whether they are two products that should share a SKU or a genuine error is a
   business question, and a migration is the wrong place to guess.

### Prerequisite

Someone needs to confirm **the Tray counter's current value**, since Vibe can only
see the SKUs that reached FileMaker. If Tray has issued numbers that were never
saved onto a product, the true high-water mark is above 2512 and seeding from
observed data would re-issue them.

---

## 7. Scope — preventing drift

Three options, cheapest first. They are cumulative, not alternatives.

### A. Scheduled detection *(recommended first — small, high value)*

Put `product-reconcile` on a daily cron, store the summary, and surface the counts
where someone sees them — the Admin panel already has the shape for it.

This changes nothing about how sync works. It converts **71 silent name mismatches
into a number on a screen**, which is the single biggest gap: nobody currently
knows drift exists unless they think to look.

- Cost: one cron entry, one Redis key, one Admin panel.
- Watch the Redis command budget in CLAUDE.md — this is one run a day, so it is
  a rounding error, but the reconciler itself is a 120-second job hitting three
  APIs and should not run more often than daily.
- **Alert on the delta, not the total.** 71 name mismatches is today's normal;
  what matters is the day it becomes 74.

### B. Push what is already known to differ *(medium)*

Once detection exists, add a "push these" action to the drift report: for each
product in `qbo_name_drift` or `*_price_drift`, re-run the existing push. The push
path already works and is idempotent — this just applies it in bulk instead of
per-record.

Also worth doing here: link the 62 QBO and 11 Shopify products that already match
by SKU but have no stored id. That is free, unambiguous, and removes 73 records
from every future report.

- Cost: a bulk endpoint over existing pieces. No new sync machinery.
- Decide first: **does a Vibe push always win?** For name and price, probably yes.
  It is not obviously right for a product someone deliberately renamed in Shopify
  for the storefront.

### C. Inbound sync *(largest — and the one to be sceptical of)*

Webhooks from Shopify (`products/update`) and QBO (change data capture) so an edit
made there flows back.

This is the only option that actually *prevents* divergence rather than repairing
it — and it is also the one that turns a one-way system into a two-way one, which
means a conflict policy, a loop guard, and a decision about what happens when both
sides changed since the last sync. That is a substantially bigger system than what
exists today.

**I would not start here.** A and B together would have caught and fixed every
one of the 84 drifted records found in this audit, at a fraction of the cost. C is
worth revisiting only if drift keeps reappearing after B — which would mean people
genuinely are editing in QBO and Shopify, and the real answer might be to stop
them rather than to synchronise them.

### What I would not do

**Two-way field-level merge.** With `shopify_description` already flowing inbound
and everything else flowing outbound, a general bidirectional sync would need a
per-field ownership table — and the moment two systems can both write one field,
someone has to define what happens when they disagree. That is a large amount of
machinery for a catalogue that changes rarely.
