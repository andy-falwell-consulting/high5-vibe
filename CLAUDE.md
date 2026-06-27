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

**Trunk-based.** `main` is the only permanent branch and is production
(`db-livid.vercel.app`). Everything else is a short-lived feature branch that
gets a Vercel **Preview** URL on push, then is squash-merged to `main` and
deleted. No permanent staging branch — so there is no squash-divergence to
realign (the `git reset --hard` dance is gone).

Per change:

1. `git checkout main && git pull` then `git checkout -b feat/<short-name>`.
2. Bump `package.json` `version`. Commit format: `v1.0.X — short description`.
3. Push the branch → Vercel auto-builds a **Preview** (unique URL + stable
   `…-git-feat-<short-name>-…vercel.app` alias). Test it there.
4. Like it? Open a PR (`feat/... → main`), title `v1.0.X — short description`,
   **squash-merge**, then **delete the branch**. Don't like it? Just delete it.
5. Merge to `main` deploys production. The auto-tag workflow tags `v1.0.X`
   (`.github/workflows/auto-tag.yml`) — no manual `git tag` needed.

Note: the old `high5-new-ui.vercel.app` URL is an orphan not attached to this
project — it never updates. Production is `db-livid.vercel.app`.

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

**Auth gate in App.jsx:** calls `/api/me` on mount; blocks with `<LoginScreen />` on deployed environments (passes through on `localhost` since serverless functions don't run locally).

**Session in agent.js:** `getGoogleSession(req)` called alongside `fmpToken(db)` at the top of the handler. Google tokens are passed in `ctx.googleToken` and `ctx.googleUser`. The system prompt includes the user's name and email.

**Scopes requested:** `openid email profile gmail calendar drive` (all full-access).

**Adding test users:** Google Cloud Console → OAuth consent screen → Test users. Required for unverified apps with sensitive scopes.

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
