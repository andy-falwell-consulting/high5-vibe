# B2 — moving the bill of materials to Vibe

**Scoped 2026-08-19**, measured against production. **Blocked on one FileMaker
change**, described at the end.

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

## Still unanswered

**Are there products with a filled-out BOM that are not marked as assemblies?**
The audit endpoint (`api/bom-audit.js`, read-only) exists to answer it, but the
sweep cannot complete while the layout pages this slowly. It should be run once
the lean layout exists — cheaply, since the same pages will then be fast.
