# High5 DB — Claude Code Guide

React 19 + Vite 8 front-end. FileMaker Data API backend. Single-page app with a nav rail and module panels.

---

## Repository layout

```
src/
  api/filemaker.js          # All FileMaker API calls + cache layer
  hooks/useAllRecords.js    # Hook: fetches + streams a full layout
  config/ccsCache.js        # Constants for the CCS (Course projects) layout
  components/
    ListControls.jsx/.css   # Shared sidebar controls (hook + toolbar + body)
    NavRail.jsx             # Left nav
    App.jsx                 # Root: routing, module mount/hide, cache prewarm
    <Module>.jsx/.css       # One file pair per module
```

---

## Release workflow

**Trunk-based, and active.** (The 2026-07-10 pause is over: on 2026-07-26 the
accumulated `preview` work was promoted to `main` in one merge, v1.0.211 →
v1.0.250, and normal releases resumed. Don't reinstate the pause unless asked.)

`main` is the only permanent branch and **is** production (`db-livid.vercel.app`
/ `vibe.high5adventure.org`) — a merge to `main` auto-deploys immediately.
Everything else is a short-lived feature branch that gets a Vercel Preview URL
on push, then is squash-merged to `main` and deleted.

**ONE PUSH PER LOGICAL UNIT OF WORK — not one per commit.**

Every push builds. A push to a feature branch builds it, and a push to
`preview` builds that too, so a habit of pushing after each commit costs two
Vercel builds per commit. On 2026-08-20 that produced 34 versions and roughly
70 preview builds in a day. Don't.

The unit is **the thing that was asked for**, however many files or steps it
took. Three related fixes to the same area are one unit; a fix plus an
unrelated refactor are two.

1. `git fetch origin` then `git checkout -b feat/<short-name> origin/main`.
2. Do the whole unit of work. Build, lint and verify LOCALLY as often as
   useful — that costs nothing and catches most things.
3. When the unit is done: bump `package.json` `version` ONCE and make ONE
   commit, `v1.0.X — short description`. Several versions for one piece of work
   just inflates the number; the squash-merge would collapse them anyway.
4. Push the branch → one Vercel Preview build.
5. Happy? Open a PR (`feat/... → main`), title `v1.0.X — short description`,
   **squash-merge**, then delete the branch. Not happy? Just delete it.
6. Merge deploys production. The auto-tag workflow tags `v1.0.X`
   (`.github/workflows/auto-tag.yml`) — no manual `git tag`.

**Do NOT push to `preview` by default.** It is a second build, and most work
does not need it. Push there only when the change genuinely cannot be checked
locally — anything needing Redis, a Google session, or real records, since
`/api` does not run on localhost. Say so when you skip it, so the gap in
verification is visible rather than assumed away.

**If a unit turns out to need several pushes** (a fix after preview testing,
say), that is fine — bump the version for the second one. The rule is about not
pushing work that isn't finished, not about never pushing twice.

**Tagging is one tag per merge, not one per version.**
`.github/workflows/auto-tag.yml` reads `package.json` at the tip of `main`
after a push and creates that single tag. It does **not** parse commit
messages, and the merge strategy makes no difference to it.

So a normal one-feature merge tags correctly, while a bulk promotion covering
many versions produces only the final tag — the intermediate ones are never
created and can't be recovered by choosing a merge commit over a squash. The
gaps in the tag list (v1.0.211 → v1.0.250 → v1.0.253) are exactly this.

Squash-merge per feature as usual. For a bulk promotion, a merge commit is
still the better choice — it keeps the individual `v1.0.X` commits readable in
`main`'s history — just don't expect it to backfill tags. If the intermediate
tags matter, create them by hand.

**Branch protection on `main`:** PRs are required and force-pushes are off, but
`enforce_admins` is off — so the repo owner can merge their own PR without a
second reviewer. Claude cannot merge to `main` on its own initiative; a merge
is a production deploy, so it needs the user to ask for it explicitly.

**The rolling `preview` branch still exists** and is still the only host that
can complete a Google sign-in. It's no longer the release path — just a shared
testing target. Push to it with
`git push -f origin <branch>:preview` when a change needs authenticated testing.

Note: the GitHub repo was renamed `high5-new-ui` → `high5-vibe` (2026-07-05);
GitHub redirects the old paths. **Vercel URLs are NOT affected by this** — they
derive from the Vercel *project* name (still `high5-new-ui`), not the repo — so
every `*.vercel.app` host stays `high5-new-ui-…` until the Vercel project itself
is renamed (a separate dashboard action). Production is `db-livid.vercel.app`, a
pinned domain that survives project renames (it persisted through the earlier
`db` → `high5-new-ui` project rename).

---

## Auth (Google OAuth)

The app uses Google OAuth for identity and Google Workspace access (Gmail, Calendar, Drive).

**Flow:** `LoginScreen` → `/api/google-auth` → Google consent → `/api/google-callback` → httpOnly cookie → app

**Key files:**
- `api/_googleSession.js` — shared helper: `getGoogleSession(req)` (parses cookie, fetches session from Redis, auto-refreshes token) and `parseSessionId(req)`
- `api/google-auth.js` — initiates OAuth; stores `oauth_state:{nonce}` → redirectUri in Redis (10 min TTL)
- `api/google-callback.js` — exchanges code, stores `session:{sessionId}` in Redis (30 day TTL), sets `h5_session` httpOnly cookie
- `api/me.js` — returns `{ userId, email, name, picture }` or 401
- `api/google-logout.js` — revokes token, deletes Redis session, clears cookie

**Env vars required:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. `GOOGLE_REDIRECT_URI` is optional (derived from request host if unset — register both staging and production URIs in Google Cloud Console).

**Testing auth-gated features on previews — the rolling `preview` branch.**
Google OAuth only accepts redirect URIs registered *exactly* in the Cloud
Console (no wildcards), so a disposable feature branch's unique preview host
can't sign in (its derived `…/api/google-callback` isn't registered). And
`*.vercel.app` is on the Public Suffix List, so a production cookie can't be
shared to a preview host — ruling out "just always use the prod callback."

**The `preview` branch is also served at `dev.high5adventure.org`** — a pinned
domain, and the host Andy actually opens. If he says a change "isn't showing"
somewhere, check which host and which version before assuming the change is
broken: `curl -s https://<host>/ | grep -o '/assets/index-[^"]*\.js'` then grep
that asset for `1\.0\.[0-9]*`. dev.* is `preview`; `vibe.high5adventure.org`
and `db-livid.vercel.app` are production.

Fix: one stable preview host via a rolling `preview` branch. Vercel gives any
branch a stable alias derived from the **Vercel project name** (currently
`high5-new-ui`), so `preview` always deploys to
`high5-new-ui-git-preview-andy-falwell-s-projects.vercel.app`. Register its
callback **once** in Google (Credentials → the `GOOGLE_CLIENT_ID` client →
Authorized redirect URIs →
`https://high5-new-ui-git-preview-andy-falwell-s-projects.vercel.app/api/google-callback`;
no JS-origin entry needed — server-side redirect flow). NOTE: the GitHub repo
rename (→ `high5-vibe`) did **not** change this host — Vercel aliases follow the
*project* name, not the repo. If the Vercel project is later renamed to
`high5-vibe`, this host becomes `high5-vibe-git-preview-…` and the Google
callback must be re-registered to match (until then, sign-in keeps working).

To test any branch with sign-in (one branch at a time):

```
git push -f origin <branch>:preview
```

This is enough **whenever the branch tip is a commit Vercel hasn't built yet** —
i.e. the normal case, where you just committed. Vercel keys builds by commit
SHA, so a fresh commit always triggers a fresh `preview` deployment.

The exception: pointing `preview` at an SHA Vercel has **already built**
(re-testing an old commit, or re-pointing at a branch that was itself already
deployed). Vercel deduplicates, no `preview` deployment is created, and the
alias 404s (`DEPLOYMENT_NOT_FOUND`). Force a unique SHA in that case:

```
git checkout -B preview origin/<branch> && git commit --allow-empty -m "preview deploy" && git push -f origin preview
```

`preview` isn't `main`, so branch protection doesn't block the force-push.

**Always confirm the deploy actually succeeded** rather than assuming it from a
clean push — poll GitHub's deployment statuses for the pushed SHA until
`success`/`failure`/`error`:
`gh api "repos/<owner>/<repo>/deployments?sha=$SHA"` → `.../statuses`.

**Auth gate in App.jsx:** calls `/api/me` on mount; blocks with `<LoginScreen />` on deployed environments (passes through on `localhost` since serverless functions don't run locally).

**Session in agent.js:** `getGoogleSession(req)` called alongside `fmpToken(db)` at the top of the handler. Google tokens are passed in `ctx.googleToken` and `ctx.googleUser`. The system prompt includes the user's name and email.

**Scopes requested:** `openid email profile gmail calendar drive` (all full-access).

**Adding test users:** Google Cloud Console → OAuth consent screen → Test users. Required for unverified apps with sensitive scopes.

**Preview auth bypass (v1.0.243+).** The `preview` deployment — and only that
deployment — can let a visitor in with no Google login at all, using a stored
copy of an admin's own session as a shared fallback identity. This exists so
the preview link can be opened cold (for a demo, a screen recording, etc.)
without every visitor needing to sign in and without hitting Google's
"unverified app" warning screen.

- `api/_googleSession.js` — `getGoogleSession(req)` first tries the request's
  own `h5_session` cookie as always; only if that's missing/invalid does it
  fall back to a fixed Redis key (`fallback_session`). The fallback is gated
  on `process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_GIT_COMMIT_REF
  === 'preview'` — both are Vercel's own system env vars, set automatically
  per-deployment, never hand-configured — so this can never activate on
  production even by mistake. A real login, whenever present, always wins.
- **Capturing the fallback session:** Admin → Preview access → "Capture my
  session" (`api/admin-set-fallback-session.js`, admin-only, requires the
  caller to be genuinely logged in — not already riding the fallback). Copies
  the admin's current session into the shared key.
- **This is not "set once."** The OAuth app is still unverified (Testing
  mode — see "Adding test users" above), and Google expires Testing-mode
  refresh tokens after **7 days**. The stored fallback session will quietly
  stop working about once a week; re-run the capture step to refresh it. The
  Admin tab shows how many days old the current capture is and flags it once
  it's ≥6 days.
- **Attribution:** every write made by a visitor riding the fallback —
  FileMaker edits, Reminders (Calendar events), emails sent via the
  assistant — is attributed to whoever last captured the session, not to the
  actual visitor. A persistent banner (`PreviewBypassBanner.jsx`) says so
  on every page while it's active, and offers a "Sign in as yourself" link
  that hands control back to a real login the moment someone completes it.
- **Blast radius:** anyone who has the `preview` link can act as that admin
  with zero login — don't let the link travel further than a small trusted
  circle while this is active. Real production is completely unaffected;
  the bypass has no code path that can reach it.

## Adding a new module

### 1. FileMaker layout name

Layouts follow the pattern `<Name>_New` (e.g. `OELookup_New`, `Contacts_New`).

### 2. Create `src/components/<Module>.jsx` and `<Module>.css`

Use `OELookup.jsx` / `OELookup.css` as the canonical reference. Key points:

```jsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { getRecord } from '../api/filemaker'
import { useAllRecords } from '../hooks/useAllRecords'
import ListToolbar, { useListControls, ListBody } from './ListControls'
import './<Module>.css'

const LAYOUT = 'MyLayout_New'
const CACHE_VERSION = 1   // increment when the field set changes

export default function MyModule({ navTarget, onClearNav, onRecordSelect } = {}) {
  const { records, total, loading, error } = useAllRecords(LAYOUT, { cacheVersion: CACHE_VERSION })

  const controls = useListControls({
    records,
    storageKey: 'my-module',          // unique key — drives localStorage sort/order persistence
    name: f => f['Some Name Field'],  // used for A–Z section headers when sort.alpha = true
    searchKeys: ['Field A', 'Field B'],
    chips: [                          // optional filter chips; omit or pass [] for none
      { id: 'active', label: 'Active', match: f => f['Status'] === 'Active' },
    ],
    sorts: [
      { id: 'name', label: 'Name', value: f => f['Some Name Field'] ?? '' },
      { id: 'date', label: 'Date',  value: f => f['Date Field'] ?? '' },
    ],
    defaultSort: 'name',
    defaultOrder: 'asc',   // 'asc' | 'desc'
  })
  // ...
}
```

**`useListControls` API — exact shape (do not guess):**

| Input | Description |
|---|---|
| `records` | Raw array from `useAllRecords` |
| `storageKey` | Unique string; keys localStorage entries |
| `name` | `f => string` where `f` is `r.fieldData` — used for A–Z headers |
| `searchKeys` | `string[]` — fieldData keys to search |
| `chips` | `[{ id, label, match, color? }]` — `match(fieldData) → bool` |
| `sorts` | `[{ id, label, value, alpha? }]` — `value(fieldData) → sortable` |
| `defaultSort` | Must match an id in `sorts` |
| `defaultOrder` | `'asc'` or `'desc'` |
| `fields` | Optional override, default `r => r.fieldData` — leave as default |
| `extraFilter` | Optional `f => bool` for dynamic filtering |

**`useListControls` return — exact shape:**

| Key | Type | Notes |
|---|---|---|
| `processed` | `Record[]` | Filtered + sorted array. Use this for the list. |
| `sections` | `[{letter, items}] \| null` | Populated only when active sort has `alpha: true` |
| `count` | `number` | `processed.length` |
| `total` | `number` | `records.length` (unfiltered) |
| `typed` / `setTyped` | string state | Search input value |
| `filterOpen` / `setFilterOpen` | bool state | |
| `chipId` / `setChipId` | string state | Active chip id, default `'all'` |
| `sortId` / `setSortId` | string state | |
| `order` / `setOrder` | `'asc' \| 'desc'` | |
| `sort` / `sorts` / `chips` | pass-through | |

**Common mistake:** `controls.filtered` does not exist. Always use `controls.processed`.

### 3. Render the sidebar controls

```jsx
{/* Header */}
<ListToolbar c={controls} />           // c= prop, not controls=

{/* Loading skeletons */}
{loading && controls.processed.length === 0 ? (
  <div className="xx-loading">{Array.from({ length: 12 }, (_, i) => <div key={i} className="xx-skeleton" />)}</div>
) : error ? (
  <div className="xx-empty-state"><p>Failed to load records.</p></div>
) : (
  <ListBody c={controls} renderItem={r => (
    <div key={r.recordId}
      className={`xx-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
      onClick={() => { handleSelect(r); onRecordSelect?.(r.recordId); }}>
      {/* item content */}
    </div>
  )} />
)}
```

**`ListBody` takes `renderItem`, not children.** Each item must have a unique `key`.

### 4. Record selection pattern

```jsx
const [selected, setSelected] = useState(null)

async function handleSelect(r) {
  setSelected(r)                    // show list-level data immediately
  getRecord(LAYOUT, r.recordId).then(detail => {
    const fresh = detail?.response?.data?.[0]
    if (fresh) setSelected(fresh)   // then refresh with full record
  }).catch(() => {})
}
```

### 5. Deep-link / navTarget

```jsx
useEffect(() => {
  if (!navTarget || navTarget.moduleId !== 'my-module') return
  const rec = controls.processed.find(r => String(r.recordId) === String(navTarget.recordId))
  if (rec) { handleSelect(rec); onClearNav?.(); return }
  let alive = true
  getRecord(LAYOUT, navTarget.recordId).then(d => {
    const r = d?.response?.data?.[0]
    if (alive && r) { handleSelect(r); onClearNav?.(); }
  }).catch(() => {})
  return () => { alive = false }
}, [navTarget])
```

### 6. Register in `App.jsx`

Three places:

```jsx
// 1. Import
import MyModule from './components/MyModule'

// 2. MODULES array (controls nav rail order and grouping)
{ id: 'my-module', label: 'My Module', icon: '◈', group: 'Records' }

// 3. Cache prewarm in the startup useEffect
getAllRecords('MyLayout_New', { cacheVersion: 1, batchSize: 100 }).catch(() => {})

// 4. Render (copy the pattern from adjacent modules)
{visited.has('my-module') && (
  <div style={{ display: activeModule === 'my-module' ? 'contents' : 'none' }}>
    <MyModule navTarget={navTarget} onClearNav={clearNavTarget} onRecordSelect={makeRecordSelectHandler('my-module')} />
  </div>
)}
```

---

## CSS conventions

- Each module gets its own CSS file with a short unique prefix (`oe-`, `ins-`, `cv2-`, etc.).
- Dark theme is the base (hardcoded hex values, no custom properties needed for simple modules).
- Light theme overrides go at the **bottom** of the CSS file:

```css
[data-theme="light"] .xx-container { background: #f8fafc; color: #0f172a; }
[data-theme="light"] .xx-sidebar   { background: #ffffff; border-right-color: #e2e8f0; }
/* ... one rule per element that differs */
```

- Common dark background values: `#0f1117` (main bg), `#13151c` (sidebar/cards), `#1e2130` (borders).
- Common light background values: `#f8fafc` (main bg), `#ffffff` (sidebar/cards), `#e2e8f0` (borders).
- Accent red: `#e8322a`.

### Scrolling layout (containers, panes, lists)

The module mounts under a `display: contents` wrapper in `App.jsx`, so the module's
root `.xx-container` is a **direct flex child of the app root**. It must declare
`flex: 1; min-height: 0` (NOT `height: 100%`, which collapses under `display: contents`
and leaves the page unfilled).

The detail pane is a flex column that scrolls:

```css
.xx-container { display: flex; flex: 1; min-height: 0; overflow: hidden; }   /* fills page */
.xx-main      { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.xx-content   { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
.xx-section   { flex-shrink: 0; }   /* REQUIRED — see below */
.xx-record-footer { flex-shrink: 0; }
.xx-list-body { flex: 1; overflow-y: auto; }   /* sidebar list scroll wrapper */
```

**`flex-shrink: 0` on every direct child of a scrolling flex column is mandatory.**
Flex items default to `flex-shrink: 1`, so on a content-heavy record the sections
shrink to fit the pane instead of overflowing it — `overflow-y: auto` never triggers,
the pane doesn't scroll, and `overflow: hidden` sections clip their own fields (looks
like the section rendered empty). This bit both Estimates and RMI (v1.0.93).

The sidebar list (`ListBody`) also needs its own `flex: 1; overflow-y: auto` wrapper,
or only the first page is reachable.

---

## FileMaker API

```js
// Stream all records (used by useAllRecords internally)
getAllRecords(layout, { cacheVersion, batchSize, onProgress })

// Fetch a single full record (HIGH priority — preempts batch fetches)
getRecord(layout, recordId)

// Patch one cached record after an edit (updates cache + notifies subscribers)
patchCachedRecord(layout, cacheVersion, recordId, fieldData)

// Subscribe to cache updates (used by useAllRecords internally)
subscribeCacheUpdates(layout, cacheVersion, callback)
```

`getRecord` is high-priority and will preempt in-flight batch pages. Use it for interactive selection.

### Portal (child-row) writes — read this before building a line-item editor

Verified against the live file on 2026-07-26. These behaviours are **not**
discoverable from the code, and getting them wrong wastes a lot of time.

```js
addPortalRows(layout, recordId, portalName, rows)   // many rows in ONE request
addPortalRow(layout, recordId, portalName, row)     // singular, delegates to the above
updatePortalRow(layout, recordId, portalName, rowRecordId, rowData)
deletePortalRow(layout, recordId, tableOccurrence, rowRecordId)
getRecordWithPortals(layout, recordId, { portalName: 2000 })
```

- **Portals cap at 50 rows by default.** Always pass an explicit limit via
  `getRecordWithPortals`, or long records silently truncate (this bit both the
  inspection report and the on-screen list).
- **Bulk add works** — FileMaker accepts many new rows in a single PATCH. Use it;
  an inspection carries 25–75 lines and one request beats 75 round trips.
- **Update needs the portal name, delete needs the table occurrence.** They are
  different strings for the same portal. See `ProductsAndServicesV2.jsx` for the
  original instance of this asymmetry.
- **Updates fail with error 101 "Record is missing" if the parent has no primary
  key yet.** So "create a record, then copy child rows onto it" must be two
  steps: create → read back the parent's ID → write rows. A brand-new record
  whose key hasn't been assigned cannot take portal edits.
- **Script-maintained fields don't recompute over the Data API.** FileMaker
  script triggers fire on human entry in FMP Pro, not on API writes. Two
  consequences seen in practice:
  - Estimates: `estmt_ESTLI::Amount` stays empty unless written explicitly, and
    the parent totals (`zz__Subtotal__xn`, `zz__Tax__xn`, `zz__Total__xn`)
    **cannot be written at all** — they return `201 Field cannot be modified`.
    Adding an estimate line from the app therefore leaves the stored total
    stale. Don't ship estimate line editing without solving this (a
    Data API-callable recalc script is the way).
  - Inspections: `inspt_INSPLI` rows have no such trap — all six fields we own
    write cleanly.
- **Probe before building.** A short read-only Node script that imports
  `api/_fmp.js` (so no credentials live in the script) and hits
  `High5_Core4_Dev` answers these questions in minutes. Create a throwaway
  parent, exercise the writes, delete it. Never probe against production, and
  always restore or remove what you create.

### Site vs org contacts — a recurring join trap

Inspections (and similar site-based records) hang off a **site** contact that is
a different record from the **organization** contact a picker returns. 4-H Camp
Bristol Hills is org `72380`, but every one of its inspections points at site
contact `82201`. Matching related records on `_kft__Contact_ID` alone will
silently find nothing. Match on the organization name (which is what the
`inspt_CNTCT__site` relationship keys on), and when copying a record, inherit
the source's `_kft__Contact_ID` rather than the picked one.

---

## Hash-based routing

URL format: `#moduleId` or `#moduleId/recordId`

- Clicking a nav item: `pushHash(moduleId, null)`
- Clicking a list item: `pushHash(moduleId, recordId)` via `onRecordSelect?.(r.recordId)`
- Back/forward: handled by `popstate` listener in `App.jsx` → sets `navTarget` → each module's `useEffect` picks it up
- Deep links work on page load — `App.jsx` reads `parseHash()` for initial state

---

## Sidebar resize handle

```jsx
const [sidebarWidth, setSidebarWidth] = useState(300)
const dragging = useRef(false)

const onMouseDown = useCallback(e => {
  dragging.current = true
  const startX = e.clientX, startW = sidebarWidth
  const onMove = ev => { if (!dragging.current) return; setSidebarWidth(Math.max(220, Math.min(520, startW + ev.clientX - startX))) }
  const onUp = () => { dragging.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}, [sidebarWidth])

// In JSX:
<aside style={{ width: sidebarWidth }}>...</aside>
<div className="xx-resize-handle" onMouseDown={onMouseDown} />
<main>...</main>
```

```css
.xx-resize-handle { width: 4px; background: #1e2130; cursor: col-resize; flex-shrink: 0; transition: background 0.15s; }
.xx-resize-handle:hover { background: #e8322a; }
```

---

## Logging High5 hours to the timesheet

At the end of each real working session on the High5 project, propose a time-log
entry for Andy to approve before writing anything. The flow is always:

1. **Estimate** the hours for the session, broken out across the categories below.
2. **Show Andy** the proposed entry (date + category hours + a short note on what
   was accomplished).
3. **Only after Andy approves**, write the record to Airtable.

Never write a timesheet entry without Andy's sign-off. If a session ended without
logging, log it retroactively next time using whatever hours Andy provides.

### Where the timesheet lives (Airtable)

- **Base:** "AF Consulting" — `appJhPgh4DC9vRTvw`
- **Table:** "Work Log" — `tblqcAgVQ151CwLLb`
- **Client field** (single-select): set to `High5`
- **Date field:** the work date for the entry
- **Category fields** (number fields — enter hours in the relevant ones):
  Research, Meetings, Strategy, Architecture/Design, Building, Documentation, Training
- **Total Hours** is a *formula* field — it sums the categories automatically.
  Do NOT try to set it directly.
- **Notes:** free-text field for the short summary of what was done.

Entries roll up automatically into the monthly "Time Sheet Roll-Up" table, so a
correct Work Log entry is all that's needed.

### Capability note

Writing to Airtable needs an Airtable connection in this Claude Code
environment. There are two independent ones, and they fail separately:

- **The native connector** (tools named `mcp__…__create_records_for_table` etc.)
  — this is what has actually been used to log time. Reach it via ToolSearch.
- **The `airtable-cli` skill** — a separate CLI needing its own personal access
  token, and **not** required if the native connector works.

A "requires authentication" notice for one does **not** mean the other is
unavailable. Check the native connector before concluding Airtable is
unreachable. If neither works, prepare the entry as text for Andy to enter
manually and say the connection needs setting up.

---

## Cron / Redis budget (read before touching `vercel.json` crons)

Every cron in `vercel.json` spends Upstash Redis commands, and the quota is a
**hard monthly cap**. Exhausting it takes down *everything* Redis-backed —
including `/api/google-auth`, so **nobody can log in** (prod and preview alike).
This happened on 2026-07-19: the schedule was running ~1,584 invocations/day
against a ~16,700 command/day budget and blew the cap.

Rules:
- **Do NOT add comment keys to `vercel.json`.** Vercel validates it against a
  strict schema and rejects any unknown top-level property (e.g. `_crons_note`)
  — the build fails with a schema error and the deploy never ships. JSON has no
  comments; keep cron rationale here instead.
- Dev crons were dropped entirely (sync Dev by hand when needed); prod crons
  were slowed to fit (~530/day now). Before adding or speeding up a cron, work
  out its daily command cost first.
