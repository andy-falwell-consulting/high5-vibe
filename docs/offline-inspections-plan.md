# Offline inspections — build plan

**Written 2026-08-21.** The scope is `docs/offline-inspections-scope.md`; this is
the plan to build it. Nothing here is built. Every code reference was checked
against the tree at v1.0.498.

---

## The workflow being supported

1. **At the office, online** — the inspector duplicates last year's inspection
   (or creates a new one) for each site on the day's list.
2. **In the field, no signal** — they open each one and fill it in: header
   fields, ~44 line items, photos.
3. **Back in signal** — everything lands exactly as if it had been done online.

Step 3 is the requirement that decides the design. "Like it was all done online"
means there is no separate offline record, no import step, no reconciliation
screen. The same record, the same ids, the same endpoints.

---

## The idea that makes this small

**Inspections.jsx already stages every edit in memory and commits on Save.**
`edits`, `lineEdits`, `newLines` and `deletedIds` hold the whole of a field
day's work already — they are just lost on reload and can only be committed
with a network.

So this is not "add an offline mode". It is:

- **persist that staging state** to IndexedDB instead of memory, and
- **make Save enqueue** rather than fetch, with a drainer that runs whenever
  there is signal.

Online, Save enqueues and the queue drains in the same second — indistinguishable
from today. Offline, it drains later. **One code path, exercised on every save
by every user every day**, rather than an offline branch that gets exercised
once a year on a mountain.

---

## What is actually broken today

| step | state | why |
|---|---|---|
| App opens with no signal | ✗ | no service worker, no manifest |
| Gets past the login screen | ✗ | `src/App.jsx:129` — on fetch failure `user` stays null → `<LoginScreen />` |
| List of inspections | ✓ | IndexedDB, 7-day TTL (`fmp_cache`) |
| Open one | ✗ | `getRecord` (`src/api/filemaker.js:810`) is network-only; `detailCache` is an in-memory `Map` |
| See line items | ✗ | `GET /api/inspection-lines` |
| See carried-over badges | ✗ | `fetchCarriedLines` returns `[]` on failure — offline it would silently show every carried line as reviewed |
| Edit | ✓ | staged in React state |
| Save | ✗ | `handleSave` does N sequential POSTs |
| Photo | ✗ | `POST /api/files-write` → Drive |

Dropdowns are already fine: `CATEGORIES`, `ELEMENT_GRADES` and `EQUIPMENT` are
local constants in `src/config/inspectionCopy.js`, not FileMaker value lists.

---

## Milestone A — the day loads (online prep)

**BUILT — v1.0.499.** Verified with the dev server stopped: the app opens, the
list renders, a pinned inspection opens with its 44 findings and its three
carried-over badges. See §"What A actually shipped" below.

*Makes step 1 useful. Independently shippable: the crew can read the day's work
in the field even before they can edit it.*

**A1. PWA shell.** `vite-plugin-pwa` in `injectManifest` mode — it generates the
precache list of hashed asset names, which is the only part worth automating,
and leaves the service worker body ours to write. New `src/sw.js`,
`public/manifest.webmanifest`, 192/512 PNG icons from
`src/assets/high5-logo.png`. Precache the shell; `/api/*` is network-only and
never cached. Installable to the iPad Home screen — which also matters for A5.

**A2. Boot without `/api/me`.** Cache the last successful identity in
localStorage. On network failure boot from it with `offline: true` instead of
falling to `<LoginScreen />`; skip `ensureFmpUserSession` (irrelevant here —
`Inspections_New` is Vibe-owned, so its writes never touch FileMaker). The
httpOnly session cookie has a 30-day Redis TTL and is still on the device; only
the *check* needed a network. The server re-authenticates on replay, so a
device that has genuinely lost its session fails at sync, visibly, not silently.

**A3. `getRecord` falls back to cache.** On fetch failure, serve the pinned
copy, then the list-cache row. Also persist `detailCache` — today a reload in
the field loses every record already opened.

**A4. "Take offline".** An action on the inspection list: tick the day's
inspections, and for each one fetch record + lines + carried flags + existing
attachments and write them to a new pinned store. Deliberate, not hopeful —
a crew cannot rely on whatever the 7-day cache happens to hold. It also checks
for a pending app update and applies it *before* pinning, so nobody drives two
hours on last week's build.

**A5. Storage that survives.** `navigator.storage.persist()`, and Home-screen
install: Safari's 7-day eviction of script-writable storage does not apply to
installed web apps. Eviction here means a lost day's work, so this is not a
nicety.

**New file:** `src/api/offlineStore.js` — one IndexedDB database, `vibe_offline`
v1, four stores: `pinned`, `drafts`, `outbox`, `blobs`. Separate from
`fmp_cache` so the day's work is never evicted by cache housekeeping.

---

### What A actually shipped

Everything in A1–A5, plus **two reads pulled forward from B2**, because A is
misleading without them:

- `listLines` falls back to the pinned copy. Without it an inspection taken
  offline opened in the field showing its header and the words *"No line items.
  Add one, or copy a previous inspection"* — not "these could not be loaded" but
  a positive claim that the course has nothing on it. A 44-row inspection
  reading as empty is the worst available failure here.
- `fetchCarriedLines` falls back too. It answered `[]` on any error, which
  offline would have cleared every carried-over badge on screen and presented
  last year's grades as this year's reviewed findings — the exact mistake the
  badge exists to prevent.

Two things found while building, both now handled:

- **`deleteDatabase` can block forever.** The offline store repairs itself if it
  ever finds a database at the right version with its object stores missing (an
  upgrade that aborted; anything that opened it without a version). The delete
  that repair depends on fires neither success nor error when another tab holds
  a connection — so the first version of it hung, and a hung open is worse than
  a failed one: every offline read waits silently and the app reports no
  problem, because nothing ever came back to report one. It now rejects, and a
  rejected open is not cached, so the next attempt retries.
- **A freshly installed service worker does not control the page it installed
  on.** On a device's very first visit the shell is cached but not being served
  from the cache, so closing the lid at that moment means arriving at a site
  with nothing. "Take offline" checks and says so.

## Milestone B — a day's work, offline

*Step 2.*

**B1. Drafts persist.** A `useOfflineDraft(inspectionId)` hook mirrors
`edits` / `lineEdits` / `newLines` / `deletedIds` into `drafts`, debounced
~400 ms, and restores them when the record is reopened. A dropped iPad, a
Safari tab reap, a battery death: the morning survives.

**B2. Reads come from `pinned` when offline.** `listLines` and
`fetchCarriedLines` gain a pinned fallback. `fetchCarriedLines` matters more
than it looks — its current `catch → []` would quietly mark every carried line
as reviewed, which is the exact failure the badge exists to prevent.

**B3. Honest UI.** The record shows what state it is in — pinned, edited, queued
— and nothing that cannot work offline is left live to be pressed. Creating,
copying and deleting are disabled with a reason, not hidden.

---

## Milestone C — sync on reconnect

*Step 3, and the real work.*

**C1. The outbox.** `src/api/outbox.js`, entry shape per §5 of the scope doc.
Coalesce by `(kind, parentId)` keeping the newest — a morning of edits to one
inspection is one queued write, not two hundred. Photos never coalesce.

**C2. Replay order.** By `createdAt`, and within an inspection **record → lines
→ photos**. The photo path calls `recordFolder()`, which names the Drive folder
`Label (id)` from the record — so the record's edits must land first or photos
file into a folder named from stale data.

**C3. Drain triggers.** The `online` event, app focus, a manual "Sync now", and
a re-check after each successful drain. Entries are removed only on server
confirmation; a failure keeps its entry with `lastError`, visible and
retryable, never dropped.

**C4. Status on screen, always.** Four states and nothing else: *Offline — N
changes held* / *Syncing — N of M* / *Synced HH:MM* / *N could not sync*. A crew
must never have to wonder whether the day is saved.

**C5. Server: an id-preserving line write.** This is the one genuine server
change, and it is not optional.

> `action: 'replace'` **re-mints every line id** — `api/inspection-lines.js`
> calls `cleanLine(l, await nextLineId(db))` for every incoming row. Sync via
> `replace` would renumber all 44 lines, orphaning every carried-over flag
> (`api/na-flags.js` keys on line id) and breaking any photo-to-line link.

Add `action: 'sync'`: takes the whole array, **keeps each row's `id`**, mints
ids only for rows that have none, and drops stored rows absent from the array.
Idempotent — a retry cannot double-apply — which per-row `add`/`update`/`remove`
is not.

**C6. Use it online too — approved.** Point `handleSave` at `sync` for everyone. Today
saving 44 edited lines is 44 sequential round trips; this makes it one. One
path, and a visibly faster save on the office desk where it gets tested daily.

---

## Milestone D — photos, and the report checkbox

**D1. Capture.** `<input type="file" accept="image/*" capture="environment">`
opens the camera directly on iOS. Downscale on capture via canvas to a 1600 px
long edge at JPEG q0.8 — 3–5 MB becomes 300–500 KB. An inspection photo
documents a worn thimble; 1600 px is plenty. Blobs go to the `blobs` store,
referenced by key, so the queue itself stays small and readable.

**D2. Budget, bounded and visible.** A heavy day — 15 inspections × 6 photos ×
400 KB ≈ 36 MB — is comfortable, but the queue's size is shown, warned above a
threshold, and a capture never fails silently for want of space.

**D3. Include-in-report checkbox.** Each uploaded photo on the record carries a
checkbox; **checked photos are included in the generated report**.

- **Stored on the file, not the browser.** A flag on the file record in
  `vibe:{db}:file` (`inReport: true`), so the choice is the record's and
  survives a different device, a different person and a re-generation.
- **Server:** `api/files-write.js` currently handles upload (POST) and delete
  (DELETE) only — add a flag action. `toCard` in `src/api/vibeFiles.js` passes
  it through to the panel.
- **`AttachmentsPanel` is shared by five modules** (CCS, EOL, Inspections, TandD,
  Trainings), so the checkbox is an opt-in prop, not a global change. Only
  Inspections passes it.
- **Report:** a *Photographs* section after the findings —
  `src/api/inspectionReport.js` builds with pdfmake, which needs data URIs, so
  each checked photo is fetched and base64-encoded at generation time, sized to
  fit the page. Captioned with its filename; with its line's description too, if
  D4 happens.
- **Works in the field.** A photo taken offline is already a local blob, so a
  report can be generated on site before anything has uploaded.
- **Cap:** warn past ~20 photos in one report rather than silently building a
  100 MB PDF.

**D4. Attach to a line — DROPPED (decided 2026-08-21).** Photos attach to the
inspection. Kept here only to record what was considered: the file
store keys a file to `(parentKind, parentId)` — `inspection:V-100042`. Attaching
to a *line* needs a new parent kind or a line reference on the file record. It
is more useful (a finding is what a photo is *about*) and it is a schema change.
D1–D3 do not depend on it; D3's captions get better with it.

---

## Risks worth naming

- **iOS evicts IndexedDB.** Mitigated by Home-screen install and `persist()`.
  Not eliminated. Named out loud because the cost is a lost day.
- **Two inspectors, one inspection.** Not solved and not detected — last writer
  wins, as it does today. Defensible while one inspector owns one inspection for
  a day; it should be a decision rather than an accident.
- **An app update mid-day.** The service worker must not activate a new version
  while the outbox is non-empty. Outbox entries carry a schema version.
- **A stale queue.** Yesterday's unsynced work is how a day quietly disappears.
- **Verification is awkward.** `/api/*` does not run on localhost and only the
  `preview` host can complete a Google sign-in, so this can only really be
  proven on `preview`, on an actual iPad, in airplane mode. Worth planning a
  session for rather than discovering.

---

## Decisions — settled 2026-08-21

1. **Photos are in the first release.** D1–D3 ship with A–C. "Done" is a crew
   that can photograph a finding in the field and tick it into the report.
2. **`sync` replaces the per-row save online as well as offline** (C5–C6). One
   path for everyone, and 44 sequential round trips become one.
3. **"Take offline" is an explicit tick-list.** A crew should know what it is
   carrying, not trust a date filter to have guessed.
4. **A stale queue warns, it does not block.** Refusing to go offline with
   yesterday's work still queued would strand a crew at the gate over a
   problem they cannot fix in a car park. It is shown, loudly, on every screen
   until it drains.
5. **Two inspectors on one inspection: accepted, not detected.** Last writer
   wins, as it does today. One inspector owns one inspection for a day.

6. **A photo attaches to the INSPECTION, not to the line item.** D4 is dropped.
   The file store keeps its existing `(parentKind, parentId)` key —
   `inspection:V-100042` — and needs no schema change at all. Report captions
   name the photo, not a finding.

## Rough sizing

| milestone | build | notes |
|---|---|---|
| A — the day loads | ~2 days | PWA plumbing is fiddly, not deep |
| B — offline drafts | ~1 day | small, because the staging state already exists |
| C — outbox + sync | ~2–3 days | the real work; C5 is a server change |
| D — photos + report | ~2 days | in the first release; +1 if D4 lands |

Inspections happen in good weather, so the practical deadline is well before the
FileMaker Go cutover date suggests.
