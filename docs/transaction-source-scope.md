# Transaction source attribution — scope

**Written 2026-08-21.** Every figure below is measured against the live
production ledger through `/api/transactions` and `/api/qbo`, read-only. Sample
sizes are stated wherever a figure is a sample rather than a count.

---

## 1. What is being asked

Every transaction should say what it is related to. If it came from an estimate,
say so. If it came from a Shopify purchase, say that.

## 2. Those two examples are on different axes

An **estimate** is where a transaction *came from*. **Shopify** is *how it was
sold*. They are not alternatives, and a single label forced to carry both would
have to choose between "Estimate D-3041" and "Shopify" for a transaction that is
honestly both.

There is also a third fact in the data, arguably the most useful of the three,
which nobody asked for because nobody knew it was there: **what the transaction
was for** — challenge course work, a training, a catalogue order. It is carried
on every line item as a QuickBooks account path.

So a transaction gets marked on two axes, alongside the type chip it already
shows:

| axis | answers | example |
|---|---|---|
| **Origin** | where did this come from? | Estimate D-3041 · Shopify · Amazon · direct |
| **Line of business** | what was it for? | Challenge Course Services · Training & Team Development · Catalog |

Different people ask these. "Which estimate did this invoice come from" is a
bookkeeping question; "how much of last year was catalogue" is Todd's.

---

## 3. The ledger, as it stands

| type | count | doc number shape |
|---|---:|---|
| Invoice | 18,440 | plain digits; 84 `Bloom…`; 291 start `#` |
| Estimate | 8,970 | **`D-####`, 100%** |
| SalesReceipt | 5,599 | 4,940 start `#` |
| CreditMemo | 1,443 | plain digits |
| **total** | **34,452** | |

---

## 4. The blocker: the evidence is discarded at sync time

`normalize()` in `api/txn-sync.js` keeps thirteen fields and drops every one
that identifies a source:

- **`LinkedTxn`** — QuickBooks' own link from an invoice to the estimate it came
  from, and to the payments that settled it
- **`PrivateNote`** — where the office writes what a job was
- **`CustomField`** — carries the customer's P.O. number

None of this is missing from QuickBooks. It is missing from the mirror. So the
first phase is capturing it, and that means re-syncing 34,452 records.

`api/ccs-estimate.js` already reads `LinkedTxn` to find the payments applied to
a project's invoices, so the traversal is proven — it has simply never been
mirrored.

---

## 5. Origin — what the data supports

### 5.1 `LinkedTxn` → Estimate. Definitive, and recent.

QuickBooks' own link. No name matching, no guessing. But it is a modern
practice, not a historical one — sampled 18 invoices per era:

| era | invoices linked to an estimate |
|---|---|
| pre-2018 | **0 / 18** |
| 2018–2022 | 3 / 18 |
| 2023–2026 | **11 / 18** |

> An earlier sample of the eight most recent invoices was 8 of 8, which would
> have supported "invoices are linked to estimates" as a general claim. Across
> the whole history it is 6 of 45. The back catalogue is genuinely unlinked, and
> no rule will invent those links.

43 of 45 invoices sampled are linked to a **Payment**, across every era — that
is a different fact, and a useful one, but it is not an origin.

### 5.2 DocNumber starting `#` → an e-commerce order.

4,940 sales receipts and 291 invoices, the earliest dated **2021-02-21** —
consistent with an integration going live then and stamping the store's own
order name.

### 5.3 Channel customers, for the aggregated feeds.

| customer | type | count |
|---|---|---:|
| My Shopify Store 1 Customer | SalesReceipt | 366 |
| Shopify Sales | SalesReceipt | 223 |
| Amazon Store Sales | Invoice | 108 |
| Amazon customer | SalesReceipt | 107 |
| PayPal customer | SalesReceipt | 21 |
| Amazon (deleted) | both | 12 |

### 5.4 THE TRAP: a Sales Receipt is not a Shopify order.

`Transactions.jsx` says Shopify orders appear here as sales receipts. True — but
the converse, which is what a reader takes away, is false. Only 589 of 5,599
sales receipts have a Shopify-looking customer. The rest are donations, Amazon,
PayPal and named individuals.

Worse, the two obvious signals barely overlap:

| | doc starts `#` | plain doc |
|---|---:|---:|
| Shopify-looking customer | 366 | 223 |
| a named person or organisation | **4,574** | 303 |

Keying off the customer name misses 4,574 orders. Keying off the type alone
mislabels roughly 900 transactions as Shopify that are nothing of the kind. The
`#` prefix is the load-bearing signal; the customer name is a secondary one that
catches the older summary-style sync.

### 5.5 `PrivateNote` — corroboration, not a rule.

Present on 15 of 45 sampled invoices (1/18 pre-2018, 8/18 2018–22, 11/18
2023–26). Sometimes exactly the answer — `CCS`, `T&TD 5-Day`, `EOL spring 2027`.
Often not — `final`, `shipped 9/6`, `sent everything with rick be…`. Worth
showing on the detail panel as context. Not worth deriving a label from.

---

## 6. Line of business — better than expected

Line items carry the QuickBooks **income account path**, not just a product
name:

```
4000 TRAINING & TEAM DEVELOPMENT:Adventure Basics Level 1 Training
4200 CHALLENGE COURSE SERVICES:…
4410 CATALOG:…
RCD COMPONENTS:…      FUNDRAISING:…      Travel:…
```

The top level maps almost exactly onto Vibe's own modules. Sampled 50 per type,
counting whether any line carries a prefixed item:

| type | line of business derivable |
|---|---|
| Estimate | **50 / 50** |
| SalesReceipt | 43 / 50 |
| Invoice | 41 / 50 |
| CreditMemo | **5 / 50** |

Weighted across the ledger that is roughly **84%**.

**Credit memos are the exception and the reason is legible**: 45 of 50 carry
only a flat item, and 51 occurrences of it were the same one —
`Deposit Received (deleted)`. A credit memo here is usually a deposit, not a sale
of anything. That is a label in itself, reached by a small dictionary of flat
items (`Deposit Received` → Deposit, `Shipping and Handling` → Shipping), which
lifts overall coverage to roughly 88%.

---

## 7. What gets stored

One object per transaction, computed at sync time — not in the browser, because
the list view strips line items and the answer must be filterable:

```js
source: {
  origin: {
    kind: 'estimate' | 'shopify' | 'amazon' | 'paypal'
         | 'bloomerang' | 'direct' | 'unknown',
    ref:   'Estimate:133057',     // the QBO id, so the row can link through
    label: 'D-3041',              // what a person recognises
    why:   'LinkedTxn',           // which rule fired
  },
  line: 'Challenge Course Services' | 'Training & Team Development'
      | 'Catalog' | 'RCD Components' | 'Fundraising' | 'Deposit' | null,
  confidence: 'certain' | 'likely' | 'unknown',
}
```

**`why` is not decoration.** A source label that turns out wrong is otherwise
undiagnosable — the whole value of this is that someone can ask "why does it say
that?" and get an answer instead of a shrug.

### The rules, in order, first match wins

| # | rule | gives | confidence |
|---|---|---|---|
| 1 | `LinkedTxn` contains an Estimate | that estimate, by `D-` number | certain |
| 2 | DocNumber starts `#` | Shopify | certain |
| 3 | DocNumber starts `Bloom` | Bloomerang (donation) | certain |
| 4 | customer matches a known channel | that channel | certain |
| 5 | type is Estimate | it *is* the origin | certain |
| 6 | nothing above | direct / unknown | unknown |

Line of business is computed independently: first prefixed item wins; failing
that, the flat-item dictionary; failing that, `null`.

---

## 8. What stays unknown, deliberately

Around 40% of the back catalogue will carry no origin, and pre-2018 almost none.
**That is shown as unknown rather than guessed.** The precedent is
`api/ccs-estimate.js`: of 40 CCS records carrying a stored estimate reference,
30 resolved to a completely different customer — one project's "D-3199" belongs
to a company eleven years earlier. Vibe already refuses to state those as fact,
and this should refuse in the same way. A blank is a fact; a wrong attribution
is a story.

---

## 9. Build order

0. **Stamp** — write the Vibe estimate id into `PrivateNote` when Vibe creates a
   QBO estimate (see Q4). **BUILT — v1.0.504.** Verified against the QuickBooks
   sandbox, not just unit-tested: `Vibe estimate V-100001` stored verbatim; a
   human note preserved with the stamp first (`Vibe estimate V-100002 · CCS
   spring 2027`); and a malformed ref dropped, leaving the note intact. All test
   records deleted. The format lives in `api/_vibeStamp.js`, which the Phase 2
   classifier must import rather than re-derive.
1. **Capture** — widen `normalize()` to keep `LinkedTxn`, `PrivateNote` and
   `CustomField`; re-sync. Nothing visible changes. *(~half a day, plus the
   re-sync running itself down.)*
2. **Classify** — the rule table as a pure function with unit tests over
   captured fixtures, so each rule's coverage is a number rather than a hope.
   *(~half a day.)*
3. **Show** — an origin chip and a line-of-business chip on the row; both, plus
   `why` and the private note, on the detail panel; both as filter chips in the
   sidebar. *(~a day.)*

## 10. What it costs — measured, 2026-08-21

### The ledger as it stands

| | bytes/record | whole ledger |
|---|---:|---:|
| stored in Redis (full, with line items) | 643 | **21.1 MB** |
| what the browser actually receives (slim) | 247 | 8.1 MB |

`/api/transactions` reads with `HSCAN`, which returns the **whole** stored value,
and only then drops `lines` in `slim()`. So Redis ships 21.1 MB and the server
throws away 13 MB of it before anyone sees a row. That is true today, before any
of this work.

`loadAll()` runs once per app session — the module stays mounted once visited,
so switching tabs does not re-read. One full read per session that opens the
page.

### What Phase 1 adds

Keeping `LinkedTxn`, `PrivateNote` and the P.O. number costs **+77 bytes per
record** (sampled 22 invoices) — the ledger goes 21.1 MB → **23.6 MB, +12%**.

> **Counter-intuitive, and it changes the design:** the RAW evidence is 77 bytes,
> while the derived `source` object as specified in §7 is **158 bytes** — twice
> as much, because of verbose keys and human-readable labels. Storing the
> evidence is both cheaper and re-classifiable without another re-sync. Derive
> the label in the API layer, or store the derived form with short codes; do not
> store both.

| | one-off | per page open |
|---|---:|---:|
| re-sync writes | ~24 MB | — |
| Redis egress, today | — | 21.1 MB |
| Redis egress, after Phase 1 | — | 23.6 MB |
| **the delta** | ~24 MB once | **+2.5 MB** |

Against a **100 GB monthly cap**, at various usage levels:

| Transactions opens / month | today | after Phase 1 | added |
|---:|---:|---:|---:|
| 100 | 2.1 GB | 2.4 GB | +0.25 GB |
| 500 | 10.6 GB | 11.8 GB | +1.2 GB |
| 1,000 | 21.1 GB | 23.6 GB | +2.5 GB |

The one-off re-sync is noise. The ongoing cost is **~2.5 MB per page open**, or
roughly a quarter of one percent of the cap per hundred opens.

### The thing actually worth fixing

Phase 1 is a 12% increase on a number that is already 62% waste. Splitting the
mirror into two hashes — `txn:{db}:recs` holding the slim row, `txn:{db}:lines`
holding the line items, fetched by `HGET` only when a detail pane opens — takes
a page open from **23.6 MB to about 11.2 MB**.

That is a 53% cut, and it repays Phase 1's increase roughly five times over. If
the cap is the concern, the answer is not to skip Phase 1; it is to do the split
alongside it and come out at **half** today's usage.

### Caveats

- Means are from samples (22 invoices, 14 sales receipts, 12 estimates, 8 credit
  memos), not a full scan. Treat ±10%.
- Figures are Redis→server egress. If Upstash bills ingress too, the re-sync
  write is ~24 MB on that side as well; still noise.
- If the Upstash connection compresses on the wire, every figure here is
  pessimistic. Unverified.
- **Transactions is not prewarmed** — unlike the modules behind the 90 GB
  incident, it loads only when somebody opens it, so it was never part of that
  problem and is not on the startup path now.

## 11. The open questions, answered

All four were measured on 2026-08-21, against production, read-only.

### Q1. Are credit memos linked back to the invoice they credit? — NOT FROM THE INVOICE SIDE

**47 invoices sampled, zero linked to a credit memo.** 22 of those were drawn
deliberately from the 535 customers who *do* have a credit memo, so this is not
a sampling accident. An invoice's `LinkedTxn` only ever contained `Payment`
(47/47) and `Estimate` (10/47).

What this does **not** establish is that the link is absent — a QBO CreditMemo
carries its own `LinkedTxn`, and no route in this app can read one. The mirror
drops `LinkedTxn`, and `/api/qbo`'s `get-invoice` fetches `/invoice/{id}`, so a
credit memo is currently unreadable in raw form.

**So this answers itself in Phase 1.** Capturing `LinkedTxn` for all four types
is already the first thing that happens; the moment it lands, whether a credit
memo names its invoice is a query rather than a question. Nothing should be
built speculatively for it now — in particular, do NOT add a Payments mirror on
the theory that credit application is recorded there. Until Phase 1 says
otherwise, a credit memo is labelled from its flat item, which for 45 of 50 is
`Deposit Received`.

### Q2. The 291 `#`-numbered invoices — e-commerce, confirmed

Every one sampled carries the order number **duplicated into `PrivateNote`**
(`"#3925"`), catalogue line items, and a Payment link. Real customers —
Kieve-Wavus, U-32 High School, Newburyport Public Schools. Dated 2021 and
2023–2026, matching the sales-receipt range.

Rule 2 (`#` prefix → store order) therefore holds for invoices as well, and does
not misfire. It also gains a free corroborator: on a store order the private
note repeats the doc number, which no hand-written invoice does.

**One of them proves why two axes are right.** `#5716`, Wellesley High School,
is a store order whose only line is
`4000 TRAINING & TEAM DEVELOPMENT:Beyond Basics - Level 2 Training` — a
**training sold through the shop**. Origin Shopify, line of business Training. A
single label would have to pick one and be half wrong.

### Q3. `Bloom####` = Bloomerang, the donor platform — a fifth channel

101 invoices, 2021–2024. Every one sampled is
`FUNDRAISING:Unrestricted Donation`, and one carries a literal `Bloomerang fees`
line. These are donations, not sales.

So the origin list gains `bloomerang`, matched on the `Bloom` DocNumber prefix,
and it is a **certain** match — the prefix is unambiguous and the line of
business agrees with it every time.

### Q4. Should Vibe stamp its own id on estimates it creates? — YES, and it matters now

`CreateInQBO` is mounted in Estimates with **`env="production"`**, so Vibe is
already creating real QuickBooks estimates. It sends `memo` and `docNumber` —
and `memo` becomes `CustomerMemo`, **which prints on the estimate the customer
sees**. That is the wrong place for an internal id.

`PrivateNote` is the right one: internal, already used by the office for exactly
this kind of note, and already read by rules above. Stamping the Vibe estimate
id there at creation makes attribution **exact** for every estimate from that
day on, rather than inferred.

This is the one change on the list that improves the data instead of reading it,
and it only helps for records created after it ships — which is an argument for
doing it first, not last. It is a handful of lines in
`api/qbo-estimate-create.js` and its caller.

---

## 12. What changed in this scope as a result

- Origin gains **`bloomerang`** (Q3), and rule 2 is confirmed for invoices as
  well as sales receipts (Q2).
- Credit memos stay on the flat-item fallback, with the real answer deferred to
  Phase 1 rather than guessed (Q1).
- A **Phase 0** is added: stamp the Vibe estimate id into `PrivateNote` on
  creation (Q4). Small, independent of everything else, and every day it is not
  shipped is a day of estimates that will only ever be matched by inference.
