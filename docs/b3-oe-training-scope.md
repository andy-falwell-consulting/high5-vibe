# B3 — OE training

**Scoped 2026-08-19** against production. **Blocked on one FileMaker layout**,
specified at the end. Certifications are deliberately out of scope (Andy,
2026-08-19).

---

## Why this one matters more than its size suggests

B3 is the last thing standing between the programme and **A4** — deleting the
FileMaker write token. The chain is short and worth stating plainly:

> Only the legacy Contacts module still writes to FileMaker → B4 wants that
> module retired rather than moved → it cannot be retired while it is the only
> home for OE training → **B3 is the blocker for A4.**

It is also one of the last FileMaker **read** dependencies in the app. Opening
the OE Training tab in Contacts v2 today costs **two live FileMaker round
trips** — a `findInLayout` on `Contacts_New` to turn a contact id into a
FileMaker recordId, then `getRecordWithPortals` for `Portal__Orders`. Every
other work source on that page reads a module cache.

## What the data looks like

Measured across a 60-contact sample spread through the list:

| | |
|---|---:|
| Contacts with any OE training | 3 of 60 — **~5%** |
| Rows in the sample | 10 |
| Most on one contact | 4 |
| **Extrapolated across 15,591 contacts** | **~780 contacts, ~2,600 rows** |

Small — roughly a quarter the size of the estimate line items, and nothing like
the bill of materials. Once a layout exists this is a short job.

A row is a workshop the contact attended, carrying:

```
cntct_WKSRG::_kpt__Workshop_ID     5280
cntct_WKSRG::Course Number         SYM-2020
cntct_WKSRG::Course Name           Adventure Practitioners Symposium
cntct_WKSRG::Start Date            03/14/2020
cntct_WKSRG::End Date              03/14/2020
cntct_WKSRG::Start Time            09:00:00
cntct_WKSRG::End Time              5:00 PM
```

## It is NOT the OE Lookup module

Worth ruling out explicitly, because the names invite the assumption.
`OELookup_New` (1,247 records) carries `Program Type`, `Program Code`
(e.g. `AB-`), `Program Start Date` and `Lead Facilitator` — and **no contact
link of any kind**. It is a catalogue of programmes, not a record of who
attended what. It cannot host per-contact training history.

## The blocker

There is **no layout on the WKSRG table** that the Data API can read. Probed and
absent: `WKSRG`, `cntct_WKSRG`, `OE_Training`, `OE Training`, `Workshop_Registration`,
`Registrations`, `wksrg_vibe`, `WKSRG_vibe`, `Script_Use__WKSRG`.

`Script_Use__Orders` does exist and reports 17 rows, but exposes **zero fields** —
the same state the contact-method tables were in before fields were added to
them, where the API could count rows and read none of them.

## What is needed

A layout on the WKSRG table exposing:

```
_kpt__Workshop_ID          the row's own key
_kft__Contact_ID           the contact it belongs to   ← the critical one
Course Number
Course Name
Start Date
End Date
Start Time
End Time
```

The parent key is the one that matters. Without it the rows cannot be attached
to contacts, which is the same thing that stalled the contacts migration and B2.
And as B2 showed, the layout should carry **only** these fields: an aggregate
calculation on it makes paging 18× slower.

## Then

Mirrors B1 and B2, and should be quick at this size:

1. `api/_oeTraining.js` — one hash field per contact, keyed on `_kpt__Contact_ID`.
2. `api/oe-training-migrate.js` — paged, staged, promoted, with the read-only
   `peek` these findings came from.
3. `api/oe-training.js` — runtime read.
4. `ContactsV2.jsx` reads Vibe instead of the two live FileMaker round trips.

**Read-only is probably enough.** Nothing in the app writes OE training today —
the legacy module and Contacts v2 both only display it — so unless someone wants
to start recording attendance in Vibe, B3 needs no write path at all.
