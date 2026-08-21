# Offline inspections — scope

**Written 2026-08-20.** Every figure below is measured against production, not
estimated. Read alongside `docs/decoupling-plan.md`: this must land before
FileMaker Go is retired, and that is the only hard date in it.

---

## 1. The problem

The build team inspects rural ropes courses in good weather. Many sites have no
signal. Today they use FileMaker Go on iPads with a local offline database, then
upload when they return to the office.

**Vibe cannot do this at all today.** Not "poorly" — at all.

| step | offline today |
|---|---|
| Load the app | ✗ no service worker, no manifest |
| Get past the login screen | ✗ `/api/me` on mount; on failure `user` stays null → `<LoginScreen />` |
| See the inspection list | ✓ IndexedDB, 7-day TTL |
| Open an inspection | ✗ `getRecord()` is network-only, no cache fallback |
| See or edit line items | ✗ `/api/inspection-lines` |
| Save anything | ✗ `/api/vibe-record` |
| Attach a photo | ✗ `/api/files-write` → Drive |

`pendingWrites` in `src/api/filemaker.js` looks like an outbox and is not: an
in-memory `Map`, lost on reload, existing only to stop a background refresh
overwriting an edit still on screen.

---

## 2. Why this is smaller than it looks

**The team copies last year's inspection.** A course changes little year to
year, so the record — and all its line items — is created at the office, with
connectivity. In the field they change the date and record findings.

That removes the two hardest problems in any offline system:

- **No record creation offline.** No provisional ids to reconcile. Vibe mints
  `V-…` ids with a Redis `INCR`, which offline could never call — and never
  needs to.
- **No line-item creation offline.** `copyLines` carries them over. Field work
  is *updating rows that already exist*.

Vibe already implements the office half: `copyProfileFields`, inheriting the
site contact (not the org contact — see the join trap in `CLAUDE.md`),
`copyLines`, and `markCarriedLines`.

---

## 3. The shape of a field day

Measured across 800 inspections spanning 397 dates; portals read on 25 recent
records.

| | median | mean | max |
|---|---:|---:|---:|
| Inspections per day | **2** | 2.0 | 15 |
| Line items each | **44** | 44.6 | 107 |
| Photos each | **0** | 0.0 | 0 |

A typical day is **2 inspections, ~90 line-item edits**. A brutal day is
15 × 107 ≈ 1,600 edits. A line carries six fields — `Description`, `Quantity`,
`Equipment`, `Element_Grade`, `Category`, `Flag_Checkbox` — so the whole day is
**well under a megabyte** before photos.

**Lines are stored as one array per inspection**, not row by row
(`writeLines(db, inspectionId, lines)`). The natural unit of sync is therefore
"this inspection's lines", not 90 individual updates.

---

## 4. What gets built

### 4.1 A PWA shell
Service worker + web app manifest, installable to the iPad Home screen. Caches
the app shell so it opens with no signal. Installation also materially reduces
the risk of iOS evicting IndexedDB, which Safari does more readily for
non-installed sites — and eviction here means a lost day of work.

### 4.2 Auth that boots offline
The session cookie is httpOnly with a 30-day Redis TTL; only the *check* needs
network. Cache the last successful identity locally and boot on it when
`/api/me` is unreachable, rather than falling to `<LoginScreen />`. Writes stay
queued and unattributed-until-sync; the server re-authenticates on replay.

### 4.3 Read from cache when the network is gone
`getRecord()` gains an IndexedDB fallback. Much of the day's content is often
already cached — `getRecord` patches the list cache with each record's
`fieldData` as it is opened — the code simply never looks there when offline.

### 4.4 Deliberate pre-download
A **Take offline** action on the inspection list: pick the day's inspections,
fetch each record plus its lines plus its value lists, and pin them so the
7-day TTL cannot evict them. Hoping the cache happens to hold the right things
is not a plan a crew can rely on.

### 4.5 The outbox
A durable queue in IndexedDB. This is the actual work; §5 specifies it.

---

## 5. The outbox

### Entry shape

```
{
  id:        'ob_01J…',            // ULID, sortable by creation
  kind:      'record' | 'lines' | 'photo',
  parentId:  'V-100042',           // inspection this belongs to
  payload:   { … },                // see below
  blobKey:   'blob_01J…' | null,   // photos only; separate IDB store
  createdAt: 1755712345678,
  attempts:  0,
  lastError: null,
}
```

Three kinds, matching the three endpoints a field edit touches:

| kind | endpoint | payload |
|---|---|---|
| `record` | `/api/vibe-record` | changed fields only (date, weather, inspector…) |
| `lines` | `/api/inspection-lines` | `{ action: 'replace', lines: [...] }` — the whole array |
| `photo` | `/api/files-write` | `{ kind:'inspection', parentId, name, mime, parentLabel }` |

`lines` uses **`replace`, not per-row `update`**. The store is already an array
per inspection, one inspector owns one inspection for a day, and replace is
idempotent — a retry cannot double-apply.

### Coalescing

Before replay, collapse entries by `(kind, parentId)`, keeping the newest.
Editing the same line twenty times over a morning produces one queued write, not
twenty. Photos never coalesce — each is its own file.

### Replay order

Strictly by `createdAt`, and **`record` before `lines` before `photo`** within an
inspection. The photo path calls `recordFolder()`, which names the Drive folder
`Label (id)` from the record — so the record's edits must land first or the
photos file into a folder named from stale data.

### Sync state, on screen

A crew must never wonder whether the day is saved. A persistent indicator with
four states, and nothing else:

- **Offline — N changes held**
- **Syncing — N of M**
- **Synced** with a timestamp
- **N could not sync** with a way to see which and retry

An entry is removed only after the server confirms. A failed entry stays queued
and visible, never silently dropped.

---

## 6. Photos

**Today: zero.** None across 25 recent inspections; roughly 20 in the entire
historical file store against 4,925 inspections.

**Treat that as suppressed demand, not preference.** Attaching a photo through a
FileMaker Go container is unpleasant. If Vibe makes it a tap, usage plausibly
goes from zero to several per inspection — and the storage design differs if it
is retrofitted rather than planned.

### Capture
`<input type="file" accept="image/*" capture="environment">` opens the camera
directly on iOS. Attach to a line item, not just the inspection — a finding is
what a photo is *about*, and the line is what a reader wants it next to.

> **This needs a schema decision.** The file store keys a file to
> `(parentKind, parentId)` — `inspection:V-100042`. Attaching to a LINE needs
> either a new parent kind (`inspline`) or a line reference on the file record.
> §9 carries this as an open question.

### Downscale before storing
A 12 MP iPhone photo is 3–5 MB. Downscale to a 1600 px long edge at JPEG q0.8 —
roughly 300–500 KB — on capture, via canvas. An inspection photo documents a
worn thimble or a cracked timber; 1600 px is more than enough, and the original
is not worth carrying.

### Storage budget
A heavy day at 15 inspections × 6 photos × 400 KB ≈ **36 MB**. Comfortable for
IndexedDB, but it must be **bounded and visible**: show the queue's size, warn
above a threshold, and never fail a capture silently for lack of space.

### Upload
Blobs live in their own IDB store, referenced by `blobKey`, so the queue stays
small and readable. On replay, after that inspection's `record` and `lines`
entries, `POST /api/files-write` with the existing `x-filename` and
`x-parent-label` headers. The blob is deleted only on confirmation.

---

## 7. Conflicts and failure modes

| case | resolution |
|---|---|
| Office edits an inspection while a crew is offline | Last-writer-wins per field, which is Vibe's existing overlay behaviour. The crew's replay wins. Acceptable: one inspector owns one inspection for the day. |
| Two inspectors open the same inspection | **Not solved, and not detected.** See §9. |
| Replay fails (401, 500, dead branch) | Entry stays queued with `lastError`; surfaced, retried, never dropped. |
| iOS evicts IndexedDB | Mitigated by Home-screen install and `navigator.storage.persist()`. Not eliminated — a real risk to name out loud. |
| App updated while work is queued | Outbox schema is versioned; the service worker must not activate a new version while entries are pending. |

---

## 8. Explicitly out of scope

- **Creating an inspection offline.** Copy-first means it is never needed. If an
  unplanned site comes up, that inspection waits for signal.
- **Deleting offline.** Vanishingly rare in the field, and the riskiest thing to
  replay.
- **Offline for any other module.** CCS, Trainings, Estimates stay online-only.
  Inspections is the one with a field workflow.
- **Multi-user merge.** See §7.

---

## 9. Open decisions

1. **Photos per inspection — what is realistic?** Drives the storage budget and
   whether the queue needs a cap. Current data says zero, which is the one
   number we know is about to change.
2. **Attach photos to a LINE or to the inspection?** Line is more useful and
   needs a file-store schema change (§6).
3. **Should the app refuse to go offline with unsynced work from a previous
   day?** A stale queue is how a day quietly disappears.
4. **Two inspectors, one inspection — prevent, detect, or ignore?** Ignoring is
   defensible today; it should be a decision.
5. **How long to keep an entry after successful sync?** Keeping a few days makes
   "did that save?" answerable after the fact.

---

## 10. Sequencing

The deadline is not arbitrary. **The day Vibe becomes the only inspection system,
a rural day without signal is a lost day of work.** That day is Phase D cutover.

Inspections happen in good weather, so the practical deadline is sooner than the
cutover date suggests.

Suggested order, each independently useful:

1. **PWA shell + offline read** (§4.1–4.4) — the crew can *see* the day's work in
   the field. Useful on its own even with capture on paper.
2. **Outbox for record + lines** (§5) — full capture, no photos.
3. **Photos** (§6) — after the schema decision in §9.
