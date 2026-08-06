# Vibe owns the record — decoupling plan

**Status:** proposed, not started. Written 2026-08-05.
**Shape:** FileMaker → Vibe sync, manual, one-way. Vibe changes never go back to FMP.

---

## The one idea

Today the mirror and the edits share a single store. `repl:{db}:{layout}:recs` holds
FileMaker's copy, and every Vibe edit is written *into that same cached record*.

That single collapse is the source of every Kanban bug chased on 2026-08-05: cards
reverting on refresh, status changes not surviving a reload, a pending-write guard that
needed two attempts to get right. None of them were FileMaker refusing anything.

Decoupling means splitting the two:

| Keyspace | Owner | What a manual pull does to it |
|---|---|---|
| `repl:{db}:{layout}:recs` | FileMaker | **replaces it wholesale** |
| `vibe:{db}:{layout}:recs` | Vibe | **never touches it** |

A read merges the two, Vibe winning. Records created in Vibe exist only in `vibe:`.
Deletes are a tombstone in `vibe:`.

The property we want falls out by construction: **a pull cannot destroy Vibe work.** Not
by carefulness, not by a guard with a ten-minute window — it is structurally impossible,
because the pull writes to a keyspace the reader treats as the lower layer.

---

## Decisions taken

1. **Conflicts are surfaced.** Vibe wins on read, but a pull reports how many incoming
   FileMaker changes were shadowed by a Vibe edit, and which.
2. **New ids are Vibe-native and obvious.** See [Identity](#identity).
3. **Vibe owns its schema.** Each module gets an explicit field definition rather than
   reflecting whatever FileMaker happens to expose.
4. **Backups go to Google Drive** — folder `vibe_backups`
   (`1fkjp3qpzQ7OGZxx0nb1hDOCWZgoAgT86`, owned by it@high5adventure.org).

## The question still open

**Is anyone still editing CCS records or contacts in FMP Pro?**

It does not block starting — Phases 0–2 are identical either way. It decides the endgame:

- **Nobody is** → the sync is a 60-day safety net, then delete it. FileMaker becomes an
  archive. No permanent merge layer, no ongoing conflict bookkeeping.
- **Someone is** → the merge layer is permanent, and we need to know *which fields* they
  touch, because a pull brings those changes in underneath a Vibe overlay where nobody
  will see them.

Worth answering before Phase 3.

---

## Architecture

### Read path

One merge function, one place:

```
record(id) = { ...repl[id], ...vibe[id] }        // vibe wins, field by field
             unless vibe[id].__deleted           // tombstone → record is gone
```

New Vibe records have no `repl` half. Imported records keep their FileMaker `recordId`,
so every existing foreign key keeps working untouched.

The discipline that matters: **every consumer goes through the merge**, the same way the
CCS status resolver has to. A module that reads `repl:` directly will silently show
pre-edit data, and it will look like a caching bug.

### Write path

Writes go to `vibe:` and need only the Google session — no FileMaker token.

Consequences, all good:

- The read-only-mode banner and per-user FileMaker account provisioning stop mattering.
  (Today `andy@andyfalwell.com` has an account in `High5_Core4_Dev` but not
  `High5_Core4`, which is why writes fail on production for that identity.)
- **Fields absent from a FileMaker layout become writable.** This unblocks, with no FMP
  layout change at all:
  - `NameFirst` / `NameLast` — adding a real person contact
  - `Title` — currently rendered in the Contacts About card but permanently blank
  - CCS organization — established as unwritable over the Data API
- Writes drop from a ~1–3s FileMaker round trip to ~50ms.

### Sync (pull)

`runSync()` in [`api/_replica.js`](../api/_replica.js) already does this — resumable
backfill then incremental modified-since, across 8 layouts. It keeps its job; it just
loses the ability to touch `vibe:`.

Triggered from Admin, per layout, showing:

- last pull time
- records added / changed / removed
- **shadowed count** — incoming changes sitting under a Vibe edit, with a drill-in

That last number is what keeps "we don't care about Vibe → FMP" honest instead of
invisible. If it stays at zero, nobody is working in FileMaker and the endgame question
answers itself.

The 5-minute production cron gets turned **off** for any layout Vibe owns. That also
relieves the Upstash budget pressure that exhausted the quota on 2026-07-19 and took
down login.

---

## Identity

Imported records keep FileMaker's `recordId` verbatim — a bare integer, e.g. `16689`,
`304539`. Nothing about existing links changes.

Records created in Vibe get:

```
V-100001, V-100002, …
```

Same family, unmistakable at a glance, allocated by `INCR vibe:id:seq:{db}` starting at
100000. Never reused, never recycled after a delete.

Rules:

- Any code comparing or storing a record id must treat it as an **opaque string**. Some
  places currently do `Number(x)` on ids — those need auditing.
- Foreign keys (`_kft__Contact_ID` and friends) must accept both forms.
- A `V-` id never goes to FileMaker. Nothing sends it there, and if the sync is ever
  reversed, `V-` records are the set that has no FMP counterpart.

---

## Backup and restore

Once Vibe is authoritative, **Upstash Redis is the system of record for the business.**
That is not something to hold one copy of. This is a blocker for Phase 1, not a
follow-up.

**What:** every `repl:` and `vibe:` keyspace per database, plus the small Vibe-only
hashes — `ccs:org`, `ops:lead`, `na-flags`, `kanban:onboard`, `kanban:order`.

**Format:** one gzipped JSON per layout per run, plus a manifest with counts and a
SHA-256 per file. Plain JSON so a restore never depends on this codebase existing.

**Naming:** `vibe-backup-{db}-YYYY-MM-DD/` inside `vibe_backups`.

**Cadence:** daily, plus an on-demand run triggered before every migration step.

**Retention:** 30 daily, then monthly for a year.

**Verification:** read back each uploaded file, compare size and checksum, record the
last-good run in Redis and show it in Admin — with a loud warning once the newest good
backup is over 48 hours old. An unverified backup is not a backup.

**Restore drill:** before Phase 1 ships, restore a backup into a scratch keyspace and
diff it against live. A restore path that has never been executed does not work; it has
just never been observed failing.

### Credential — needs a decision

The app already holds Drive scope, but its Google OAuth client is **unverified
(Testing mode)**, and Google expires Testing-mode refresh tokens after **7 days**. This
is already documented for the preview-bypass session, which has to be re-captured weekly.
A cron-driven backup on a user refresh token would therefore break about once a week —
silently, which is the worst way for a backup to fail.

Three durable options, best first:

1. **Move `vibe_backups` into a Shared Drive** and add a Google service account as a
   member. Storage belongs to the organisation, the credential never expires, and it is
   independent of any individual's account. Note the folder is currently in
   it@high5adventure.org's My Drive, where a plain service account has no storage quota
   of its own — this is the reason to prefer a Shared Drive.
2. **Domain-wide delegation** — service account impersonates it@high5adventure.org.
   Works with the folder as-is, needs Workspace admin.
3. **Get the OAuth app verified**, which removes the 7-day expiry. Worth doing anyway,
   but slow and it is not really a backup solution.

Recommendation: option 1.

---

## Migration order

**Phase 0 — backup first.** Export, verify, and complete one restore drill. Nothing else
starts until this is green.

**Phase 1 — projects (`RCD_New`, ~6,400 records).** Highest pain, self-contained, and the
module that has consumed the most time. Delivers: Kanban status owned by Vibe, CCS
organization assignment becomes an ordinary field, and the drag/status machinery is
deleted rather than patched again. Contacts stay FileMaker-mirrored; projects still
reference them by id, which keeps working because the mirror is still there.

**Phase 2 — contacts (`Contacts_New`, ~15,500 records).** Unblocks person contacts —
`NameFirst`/`NameLast`/`Title` — without touching a FileMaker layout. Biggest blast
radius, since nearly everything joins to contacts, so it goes second rather than first.

**Phase 3 — inspections, estimates, trainings, RMI.** Mechanical repeats of the same
pattern. This is where the open question above needs an answer.

**Phase 4 — reference data (products, OE lookup).** Lowest urgency. OE lookup is
snapshot-only and barely changes.

**Phase 5 — retire the sync.** If nobody is editing in FileMaker (confirmed by the
shadowed count sitting at zero), delete `runSync` and the `repl:` keyspace, and keep a
final export as the archive.

---

## What gets deleted along the way

Not a side effect — a deliverable. Phase 1 removes:

- the pending-write guard and its localStorage persistence (v1.0.277 / v1.0.279)
- `localStatusRef`, the `{to, base}` optimistic override, and its retirement rule
- the FileMaker response-code check on the drag path (v1.0.280)
- `updateRecord` on the drag path, and with it the whole write-auth failure mode
- the env-scoped cache reasoning for owned layouts

Four interacting mechanisms collapse to one merge function.

---

## Risks

| Risk | Mitigation |
|---|---|
| Redis becomes the only copy of the business | Phase 0 — verified daily Drive backups plus a rehearsed restore |
| A consumer reads `repl:` directly and shows stale data | One merge function; audit every consumer per phase, as with the status resolver |
| Numeric assumptions break on `V-` ids | Audit `Number(recordId)` and comparison sites before Phase 1 |
| FileMaker edits silently lost under an overlay | Shadowed count surfaced on every pull |
| Backup credential expires unnoticed | Shared Drive + service account; Admin warns when the last good backup is >48h old |
| Upstash quota exhaustion | Owned layouts drop their 5-min cron; pulls become manual |
