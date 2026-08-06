# Vibe owns the record — decoupling plan

**Status:** Phase 0 complete and live. Phase 1a–1c complete and live (v1.0.288).
Phase 1d next. Written 2026-08-05, updated 2026-08-06 to record what actually shipped.
**Shape:** FileMaker → Vibe sync, one-way. Vibe changes never go back to FMP.

---

## The one idea

The mirror and the edits used to share a single store. `repl:{db}:{layout}:recs` held
FileMaker's copy, and every Vibe edit was written *into that same cached record*.

That single collapse was the source of every Kanban bug chased on 2026-08-05: cards
reverting on refresh, status changes not surviving a reload, a pending-write guard that
took three attempts to get right. None of them were FileMaker refusing anything.

Decoupling splits the two:

| Keyspace | Owner | What a sync does to it |
|---|---|---|
| `repl:{db}:{layout}:recs` | FileMaker | **replaces it wholesale** |
| `vibe:{db}:{layout}:recs` | Vibe | **never touches it** |

A read merges the two, Vibe winning field by field. Records created in Vibe exist only in
`vibe:`. Deletes are a tombstone in `vibe:`.

The property we want falls out by construction: **a sync cannot destroy Vibe work.** Not
by carefulness, not by a guard with a ten-minute window — it is structurally impossible,
because the sync writes to a keyspace the reader treats as the lower layer.

Fragments hold **only the fields Vibe has changed**, never whole records. So a FileMaker
change to a field Vibe has never touched still flows through on the next sync. Only what
Vibe actually edited is pinned.

---

## Decisions taken

1. **Conflicts are surfaced.** Vibe wins on read; a sync should report how many incoming
   FileMaker changes were shadowed by a Vibe edit. *Not yet built — see Phase 1d.*
2. **New ids are Vibe-native and obvious.** `V-100001` onward. *Not yet built.*
3. **Vibe owns its schema.** Each module gets an explicit field definition rather than
   reflecting whatever FileMaker happens to expose.
4. **Backups go to Google Drive.** Shipped — see below. The destination moved during
   implementation from `vibe_backups` to the **`backups` Shared Drive**
   (`1xW3xXxRzUnSGKM5pG1dCibFAEQUyHLsi`), which turned out to matter.

## The question still open

**Is anyone still editing CCS records or contacts in FMP Pro?**

It is now more pressing than when this was written, because CCS projects have actually
moved. A FileMaker edit to a project still flows *in* on the next sync, but sits
underneath any Vibe edit to the same field, where nobody will see it.

- **Nobody is** → the sync becomes a safety net, then gets deleted. FileMaker becomes an
  archive. No permanent merge layer, no ongoing conflict bookkeeping.
- **Someone is** → the merge layer is permanent, and we need to know *which fields* they
  touch.

---

## Architecture — as built

### Read path

The merge is **server-side, at the record layer**, in `scanReplica` (`api/_replica.js`
→ `api/_vibeStore.js`).

This is a change from the original plan, which called for a resolver each consumer would
call. Merging at the record layer instead means **every existing reader kept working
untouched** — the Home funnel, the CCS workspace pill and pipeline, the list chips,
search. They read `fieldData`, and `fieldData` is simply correct.

It also avoids the failure mode that bit `api/kanban-order.js`, where a second copy of a
constant drifted from the first and silently broke card ordering in three lanes for
weeks. There is one merge, in one place.

**Single-record reads go through `/api/record`.** `getRecord()` used to hit FileMaker
directly and then write what it got into the list cache. Once Vibe owned a field, that
path would have returned the pre-Vibe value *and overwritten the merged copy the list
already held* — silently undoing every Vibe edit the moment a record was opened. It now
applies the same overlay. Localhost keeps the direct path; it has no serverless functions
and an empty overlay makes the two equivalent.

### Write path

`POST /api/vibe-record` merges changed fields into a record's fragment
(read-modify-write, so two people editing different fields don't erase each other).

Two consequences, both of which fixed long-standing problems:

- **It needs only a Google session.** The FileMaker path required a per-user FMP account —
  which is why production writes silently failed for an identity that had an account in
  Dev but not in prod. That was the original "the Kanban doesn't work" report.
- **Nothing can revert an edit**, so the optimistic-guard apparatus is unnecessary for
  Vibe-owned layouts.

`VIBE_OWNED` in `api/_vibeStore.js` is a short explicit list — currently `RCD_New` only.
A layout not named there still writes to FileMaker, and the endpoint **refuses** rather
than silently forwarding, so a caller can't think it wrote to Vibe when it wrote to FMP.

### Sync

`runSync()` in `api/_replica.js` is unchanged. It only ever touches `repl:`.

Not yet built: the **shadowed count** — how many incoming FileMaker changes sit under a
Vibe edit. That number is what keeps "we don't care about Vibe → FMP" honest rather than
invisible, and it is how the open question above gets answered empirically. If it stays
at zero, nobody is working in FileMaker.

---

## Identity

Imported records keep FileMaker's `recordId` verbatim. Nothing about existing links
changes.

Records created in Vibe will get `V-100001` onward, from `INCR vibe:id:seq:{db}` starting
at 100000. Never reused.

Rules:

- Ids are **opaque strings**. Anywhere the code does `Number(recordId)` needs auditing
  before this ships.
- Foreign keys must accept both forms.
- A `V-` id never goes to FileMaker.

*Not yet built — Phase 1d.*

---

## Backup and restore — shipped

Live as of v1.0.286. Admin → Backup.

**Nightly at 08:00 UTC**, authenticated as a service account. 51 keys, ~105,000 entries,
**148MB raw → ~15MB gzipped**, into `backups/YYYY-MM-DD/`. A second run the same day
reuses that folder and replaces the files rather than duplicating them.

**Verification is genuine**: the md5 we compute is compared against the checksum Drive
computes from what it actually received. `manifest.json` goes up last and uncompressed —
its presence signals a finished run, and it names any missing or unverified keys rather
than implying success.

**Restore** (`restore-plan` / `restore-check` / `restore-write`) is built and **rehearsed**.
It is read-only by default; writes land in a scratch prefix with a 24h TTL unless
`target=live`, which additionally requires `confirm=overwrite {key}`. Overwriting a live
key is deliberately not reachable from the UI.

**Retention**: every day for 30 days, then the first of each month. Pruning runs only
after a *complete* backup, and folders are trashed rather than deleted.

### What building it turned up

- **Live API credentials were sitting in the same keyspace as the data** — QuickBooks and
  Shopify tokens. A naive "back up everything" would have written them to Drive in
  plaintext. Now excluded, along with sessions and OAuth nonces.
- **`MEMORY USAGE` is unavailable on this Upstash plan**, so sizes are estimated from a
  100-entry sample scaled by the exact count.
- **The Shared Drive needs `supportsAllDrives`** on every Drive call, or writes are
  rejected. Set unconditionally.
- **Vercel stores env newlines escaped**, so a pasted PEM arrives as one line with literal
  `\n` and fails with `error:1E08010C:DECODER routines::unsupported`. Normalised on read.
- **A same-day rerun could leave a manifest describing files that no longer existed.**
  Reusing a day's folder now trashes the manifest first: better no manifest than one that
  lies.

### The credential, and why a service account

The app's OAuth client is in **Testing** publishing status, and Google expires refresh
tokens for Testing-status apps after **7 days** — the same rule that forces the preview
fallback session to be re-captured weekly. A cron on a human's token would have failed
about once a week, silently.

A service account sidesteps user OAuth entirely: sign a JWT, get a short-lived token. No
consent screen, no refresh token, no publishing status, nothing to expire, and **no app
verification required**. `GDRIVE_SA_SUBJECT` supports domain-wide delegation but was not
needed.

This is where the Shared Drive mattered: a service account has no Drive storage quota of
its own, so it cannot own files in a personal My Drive. In a Shared Drive, storage belongs
to the organisation.

`mode=sa-test` walks the whole path — mint, see the folder, write a probe, read it back
byte-for-byte, remove the probe — and names the step that failed with the specific remedy.
Safe to re-run.

---

## Migration order

**Phase 0 — backup first. ✅ Shipped (v1.0.286).** Export, verify, and one restore drill.
Nothing else started until this was green.

**Phase 1 — projects (`RCD_New`, ~6,400 records).**

- **1a/1b ✅ (v1.0.287)** — the `vibe:` store and the server-side merge, plus routing
  single-record reads through it. No behaviour change: record counts identical before and
  after.
- **1c ✅ (v1.0.288)** — project writes go to Vibe. FileMaker is read-only for CCS
  projects from here.
- **1d — next.** `V-` ids, tombstones for deletes, the shadowed-count report, and the
  contact-reassignment exception below.

**Phase 2 — contacts (`Contacts_New`, ~15,500 records).** Unblocks adding a person
properly — `NameFirst`/`NameLast`/`Title` aren't on the FileMaker layout at all, so no UI
work can reach them today. Biggest blast radius, since nearly everything joins to
contacts.

**Phase 3 — inspections, estimates, trainings, RMI.** Where the open question needs an
answer.

**Phase 4 — reference data (products, OE lookup).**

**Phase 5 — retire the sync**, if the shadowed count says nobody is editing in FileMaker.

---

## The one FileMaker writer left on projects

**Contact reassignment** (`handleContactChange` in `CCSv2.jsx`) still writes
`_kft__Contact_ID` to FileMaker, deliberately.

Changing it re-derives a family of FMP calcs — `zz__Display_Contact__ct`, the billing
address block, the related phone and email. A fragment holding only the id would change
the link and leave every one of those showing the *previous* contact.

Moving it needs a decision about which of those fields Vibe stores itself. That is a
schema question, not a coding one.

---

## What got deleted, and what stayed

**Deleted in 1c:** `localStatusRef`, the `{to, base}` optimistic override and its
retirement rule, and the FileMaker response-code check on the drag path. A card's lane is
now simply its record's status. That override took three attempts to get right
(v1.0.275, v1.0.277, v1.0.283), each a different edge of the same collapse.

**Kept:** the persisted pending-write guard in `src/api/filemaker.js`. It is generic, and
contacts, inspections, estimates and the rest still write to FileMaker and still face
replica lag until their own phases. It is harmless for Vibe-owned layouts — the merge
agrees with it, so it retires itself on the first revalidate. It goes when the last
layout moves.

---

## Risks

| Risk | Mitigation | State |
|---|---|---|
| Redis becomes the only copy of the business | Verified nightly Drive backups plus a rehearsed restore | ✅ done |
| Backup credential expires unnoticed | Service account on a Shared Drive; `sa-test` re-runnable | ✅ done |
| A consumer reads `repl:` directly and shows stale data | Merge is server-side at the record layer, so there is nothing to keep in sync | ✅ structural |
| Numeric assumptions break on `V-` ids | Audit `Number(recordId)` before 1d | ⚠ outstanding |
| FileMaker edits silently lost under an overlay | Shadowed count on every sync | ⚠ not built |
| Contact reassignment leaves derived fields stale | Still writes to FileMaker until the schema question is settled | ⚠ deliberate |
| Upstash quota exhaustion | Backup costs ~150 commands a night | ✅ negligible |
