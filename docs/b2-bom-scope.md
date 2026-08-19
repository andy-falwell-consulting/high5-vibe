# B2 — moving the bill of materials to Vibe

**Scoped 2026-08-19**, measured against production.

**The layout blocker is resolved** — `BOM` (with `_kft__Item_ID__assemblyLine`
added on request) pages a full 1,000 rows in **1.7 seconds** against the original
layout's **30+ seconds**. The whole table now reads in about 90 seconds.

**But the audit stopped the migration for a better reason.** 91% of the rows in
that table are not a bill of materials at all. See "What the audit found".

---

## What is there

`Item_ITMLI_billOfMaterials` is a layout on the BOM line table, and it already
carries everything a migration needs — unlike estimates, where the layout had to
be found:

| Field | |
|---|---|
| `_kft__Item_ID__parent` | the assembly this line belongs to |
| `_kft__Item_ID__assemblyLine` | the component item |
| `_kpt__Item_Line_Item_ID` | the line's own key |
| `Quantity`, `Cost`, `Total` | the line itself |

**125,047 rows** — twelve times the estimate line items, and comparable in scale
to the inspection lines (208,416).

## The blocker: that layout cannot be paged

A 1,000-row page takes **over 30 seconds**. At 126 pages that is roughly an hour
of continuous FileMaker load for one migration run.

The cause is visible in any sample row:

```
s_Cost:  9023812.667224
s_Total: 24943681.438332
```

Those are **table-wide aggregates**, and FileMaker recomputes them for every row
it returns. The migration does not want them — it needs the two keys and
`Quantity` — but the Data API returns whatever the layout exposes, so there is
no way to opt out from this side.

Measured consequence, and worth recording because it was self-inflicted:
dispatching those pages concurrently saturated the FileMaker Data API to the
point where even a 3-row read timed out. **The app was unaffected throughout** —
a replica read stayed at 196 ms — because everything users touch now reads Redis
rather than FileMaker. That is the decoupling doing exactly what it is for, and
it is also the reason this was recoverable rather than an outage.

## What is needed

**A lean layout on the BOM line table** — the same shape `est_li_vibe_2` provided
for estimate lines. It needs only:

```
_kpt__Item_Line_Item_ID
_kft__Item_ID__parent
_kft__Item_ID__assemblyLine
Quantity
```

and specifically **must not** carry `s_Cost`, `s_Total` or any other aggregate
calculation. With those gone the pages should read at the speed
`est_li_vibe_2` does, and the migration becomes the same routine job B1 was.

## The rest of the shape, once that exists

Mirrors B1, which mirrors the inspection lines:

1. `api/_bomLines.js` — one hash field per parent product, keyed on
   `_kpt__Item_ID`. Not on the record fragment, for the same reason as the other
   two: `readOverlay` HGETALLs the whole overlay on every records page.
2. `api/bom-lines-migrate.js` — paged, staged by parent, promoted on `finish`,
   with the read-only `peek` this file's findings came from.
3. `api/bom-lines.js` + `src/api/bomLinesVibe.js` — runtime read/write.
4. `ProductsAndServicesV2.jsx` swaps `createRecord('Item_ITMLI_billOfMaterials')`,
   `updatePortalRow` and `deletePortalRow` for the Vibe calls.

**Totals note:** the UI already computes BOM line totals live from
`item_itmli_ITEM__billOfMaterials::Unit_Price` × quantity and explicitly ignores
the stored `::Total` (`ProductsAndServicesV2.jsx`, around the `_liveTotal`
calculation). So the stored totals are already treated as unreliable — the same
pattern B1 found and fixed, and the migration should not carry them across.

## What the audit found — do NOT migrate this table as it stands

Full sweep of all 125,047 rows against the 1,267 products:

| | |
|---|---:|
| Rows | 125,047 |
| Distinct parent products | 1,079 |
| **Rows belonging to the top TEN parents** | **114,150 — 91.3%** |
| Rows across the other 1,069 parents | 10,897 |
| **Average lines for those 1,069** | **10.2** |
| Parents not flagged `assembly_product` | 788 of 1,079 |
| Rows with no parent at all | 2 |
| Parents not present in the products table | 0 |

**The tail is a perfectly normal bill of materials** — 1,069 products averaging
10 components each, about 10,900 rows. That is the real data, and it is an
order of magnitude smaller than the table's row count suggests.

**The head is not.** Ten parents hold 114,150 rows, and the counts are absurd
on their face:

| Product | Rows |
|---|---:|
| Pick A Postcard | 29,124 |
| Body Parts Debrief Kit; Deluxe | 20,750 |
| Blocked Perspective Box Empty | 17,833 |
| Omega Steel Screw Lock Carabiner | 12,692 |
| Discount by the Dollar | 10,370 |
| 8"x8"x12' Treated Lumber | 10,288 |

A postcard does not have 29,124 components. Verified this is real and not a
counting error: entire 1,000-row pages come back with a **single** parent id, and
opening "Pick A Postcard" in the app shows a bill of materials whose first
component is a *1½" Heavy Duty Fixed Eye Single Sheave Pulley*. None of these
six are flagged as assemblies.

So the honest reading is that the table contains a real BOM plus a large amount
of runaway or duplicated data attached to a handful of items — and the app only
ever showed 50 rows of it, because FileMaker portals cap there by default.
Nobody would have seen the scale of it through the UI.

### What this means for B2

**Migrating the raw table would import 114,150 rows of apparent garbage** and
give six ordinary products enormous bills of materials in Vibe — visible, since
Vibe has no 50-row portal cap to hide behind.

Options, in the order they should be considered:

1. **Ask Ian what those rows are** before touching them. They may be a known
   import artefact with an obvious disposal, in which case this is a five-minute
   conversation rather than a design problem.
2. **Migrate the tail only** — the ~10,900 rows across 1,069 parents — and leave
   the ten outliers behind, recorded, for a decision.
3. Migrate everything and clean up in Vibe. Least attractive: it moves the
   problem rather than resolving it, and makes it more visible on the way.

### The other half of the question

**788 of 1,079 parents are not flagged `assembly_product`**, and one product is
flagged with no BOM at all. That is too many to be simple mislabelling and is
probably telling us the flag is not what decides whether something has a BOM —
`ProductsAndServicesV2.jsx` uses it only to decide whether to SHOW the tab
(`isAssembly = !!fval('assembly_product')`). Worth confirming with Ian rather
than inferring, since it decides whether the flag should be trusted at all.
