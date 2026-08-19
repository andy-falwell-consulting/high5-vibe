# B4 — retiring the legacy Contacts module

**Scoped 2026-08-19.** One gap stands between here and deleting
`src/components/Contacts.jsx` (748 lines) — and with it, **A4**.

---

## Why this is the last domino

> The legacy Contacts module is the **only remaining FileMaker write** in the
> app → deleting it removes the last caller of `getToken({ write: true })` →
> **A4 becomes a deletion rather than a migration.**

Its writes are the contact record itself, the phone/email/address portals, and
`Contact_rltn` relationship rows — all of which Contacts v2 already owns in
Vibe. Nothing writes through it that is not already written better elsewhere.

## Tab-by-tab coverage

| Legacy tab | Contacts v2 | |
|---|---|---|
| Overview | Overview | ✅ |
| Contacts (`Contact_rltn`) | affiliations — people on an org, orgs on a person | ✅ better model |
| Inspections | work tab, module cache | ✅ |
| Custom Training | work tab | ✅ |
| **OE Training** | **Vibe (B3)** | ✅ |
| CCS | work tab | ✅ |
| Estimates | work tab | ✅ |
| RMI | work tab | ✅ |
| Notes | inside Overview | ✅ |
| **Invoices** | **nothing** | ❌ **the gap** |
| Certifications | nothing | ⛔ out of scope (Andy) — 3 rows total |

Everything except invoices is covered, and certifications have been ruled out.

## The gap: invoices

The legacy tab reads `Portal__Invoices` → `cntct_INVO::*`. Contacts v2 has no
equivalent, so retiring the module today would lose per-contact invoice history.

**`Invoices_New` is the layout, and it is ready:**

| | |
|---|---:|
| Rows | **13,140** |
| Fields | 44 |
| Peek | 659 ms — no aggregate-calc problem |
| Parent key | **`_kft__Contact_ID`** ✅ |
| Own key | `_kpt__Invoice_ID` |
| Carries | `Date`, `zz__Total__xn`, `zz__Subtotal__xn`, `zz__Tax__xn`, `zz__Paid_In_Full__cr`, `PO_Number`, `Memo`, billing/shipping address blocks |

### One thing to decide first: which invoices are authoritative

FileMaker's `INVO` is **historical**. The QBO invoice mirror
(`api/qbo-invoice-sync.js`) writes QuickBooks invoices *into* it, and that sync
is **deferred in production** behind `QBO_SYNC_ALLOW_PROD` — it runs in Dev
only. The sampled row is dated 03/12/2015.

So there are two invoice sources with different jobs:

- **`Invoices_New`** — 13,140 historical invoices, contact-linked, in the file
  being retired. Migrating it preserves the history.
- **QuickBooks**, surfaced by the Transactions module — where invoices actually
  live now.

The recommendation is to migrate `Invoices_New` for history and show it on the
contact, rather than trying to make the tab live against QBO. A live per-contact
QBO view is a different feature, and it needs a contact→QBO customer mapping
that the reconciliation work started but did not finish for production.

## The shape

Mirrors B3 almost exactly, and should be quick:

1. `api/_invoices.js` — one hash field per contact, keyed `_kft__Contact_ID`.
   Store the whole row: totals, PO number, memo, paid flag, dates.
2. `api/invoices-migrate.js` — paged, staged, promoted. Carry the progress
   accumulator from the start; B3's finish step reported only its last pass
   because it lacked one.
3. `api/invoices.js` — read-only. Nothing in the app writes invoices.
4. `ContactsV2.jsx` — an Invoices tab, same shape as the OE Training one.

Then, and only then:

5. Delete `src/components/Contacts.jsx`, its nav entry, its `App.jsx` mount and
   its cache prewarm.
6. **A4** — delete `getToken({ write: true })` from `src/api/filemaker.js`, and
   with it the per-user-FileMaker-account failure class.

## Two loose ends to sweep up with it

- **`TandD.jsx` and `EOL.jsx`** still call `updateRecord`, but both set
  `RECORDS_LOCKED = true` so the calls are unreachable. They will block A4's
  grep even though they cannot run. Remove the dead save paths.
- **`src/api/estimateLines.js` is already deleted**; check nothing else imports
  FileMaker write helpers before removing them from `filemaker.js`.
