# Vibe

Internal operations console for **High 5 Adventure Learning Center** — a single-page
app over the FileMaker database that runs the business, with QuickBooks, Shopify,
and Google Workspace wired in alongside it.

Production: [vibe.high5adventure.org](https://vibe.high5adventure.org)
(also reachable at `db-livid.vercel.app`)

FileMaker remains the system of record. Vibe is a faster, friendlier surface over
it — plus the integrations and reporting that FileMaker alone can't reach.

---

## Stack

| | |
|---|---|
| Front end | React 19, Vite 8, plain CSS (one file per module) |
| Back end | Vercel serverless functions (`api/`), Node 24 |
| Database | FileMaker Server via the Data API (`High5_Core4`) |
| Cache / state | Upstash Redis — layout replica, shared UI state, OAuth tokens |
| PDFs | pdfmake, rendered client-side |
| Assistant | Anthropic API (`@anthropic-ai/sdk`) |

No TypeScript, no CSS framework, no state library. Routing is hash-based
(`#module` / `#module/recordId`).

---

## How data flows

FileMaker's Data API is slow for large reads, so records reach the browser through
two layers:

```
FileMaker  ──cron every 5 min──▶  Redis replica  ──▶  /api/records  ──▶  browser cache  ──▶  UI
   ▲                                                                         │
   └──────────────── writes go straight to the Data API ─────────────────────┘
```

- **`api/sync.js`** mirrors eight layouts into Redis, incrementally by
  `zz__Modified_On`. **`api/records.js`** serves them cursor-paged.
- **`useAllRecords`** streams a layout into an IndexedDB-backed client cache, so a
  revisited module renders instantly. Each layout carries a `cacheVersion` —
  **bump it whenever the field set changes**, or clients keep stale shapes.
- **Writes bypass all of it** and go directly to the Data API, then patch the
  local cache. Reads are eventually consistent; writes are immediate.

Replicated layouts: Contacts, Estimates, Inspections, Trainings, RMI, RCD
(projects), OE Lookup, Products & Services.

Three FileMaker environments are switchable from the sidebar — Development,
Staging, Production (`High5_Core4_Dev` / `_Stage` / `High5_Core4`).

---

## Modules

**Overview** — Home (dashboard) · Reminders

**Records**

| Module | Backing layout | Notes |
|---|---|---|
| Contacts | `Contacts_New` | People and organizations; hub for related records |
| Estimates | `Estimates_New` | Line items read-only; push to QuickBooks |
| Inspections | `Inspections_New` | Course inspections with editable line items, copy-forward from a prior year, and a generated PDF report |
| Risk Management | `RMI_New` | RMI assessments |
| Trainings | `trainings_New` | Program delivery, costs, logistics, work-order PDF |
| Edge of Leadership | — | Placeholder |
| Team Development | — | Placeholder |
| OE Lookup | `OELookup_New` | Reference lookup |
| Products & Services | `Products & Services_New` | Catalog, bill of materials, Shopify and QuickBooks links |
| Transactions | Redis mirror | Read-only QuickBooks ledger (invoices, estimates, credit memos, sales receipts) |

**Projects** — CCS (`RCD_New`): challenge-course projects with a phase checklist,
Kanban board, financials, and work-order PDFs.

**System** — Admin (integrations, access) · Help (rendered live from a Google Doc)

Cross-cutting: ⌘K command palette searching every record type, an AI assistant
that can read and write records, and per-record file attachments.

---

## Integrations

**Google (OAuth)** — identity plus Gmail, Calendar, and Drive. Every user signs in
with Google; the access token stays server-side. Reminders are real Calendar
events tagged with `extendedProperties`, so Google handles the notifications.

**QuickBooks Online** — invoice mirror, estimate push and status sync, transaction
ledger, item catalog. Tokens live in Redis and refresh automatically; a daily
health check (`api/qbo-health.js`) surfaces a banner to admins if the connection
breaks, since the failure is otherwise silent.

**Shopify** — product and price sync, description backfill.

**Tray** — issues product SKUs from an incrementing counter (`api/next-sku.js`).

Reconnect flows for QuickBooks and Shopify both live in **Admin → Integrations**.

---

## Access

Google sign-in is required on every deployed environment (localhost passes
through, since serverless functions don't run under plain `vite`).

The **Admin** panel is gated separately by email, in two tiers: an `ADMIN_EMAILS`
environment variable (permanent) and a Redis-backed list managed from Admin → FMP.
Note that Vercel environment variables scoped to a git branch apply to Preview
only — a common cause of admin working on preview but not production.

---

## Running it

```bash
npm install
npm run dev      # Vite only — /api routes do NOT run
npm run build
npm run lint
```

Locally you get the UI and direct FileMaker access, but no serverless functions:
no login, no Google, no QuickBooks, no Shopify, no Redis. Anything touching
`/api/*` has to be tested on a deployed environment.

Environment variables live in Vercel. `.env.local` mirrors some of them for local
use but is **not** authoritative — the deployed values are.

---

## Deploying

Trunk-based. `main` **is** production — merging deploys immediately.

```bash
git checkout -b feat/<name> origin/main
# ...work, bump package.json version, commit as "v1.0.X — description"
git push origin feat/<name>          # Vercel builds a preview
# open a PR → squash-merge → production
```

Features needing a real Google login must be tested on the rolling `preview`
branch (`git push -f origin <branch>:preview`) — it's the only host whose OAuth
callback is registered.

Seven crons run against production (sync, QuickBooks invoice/estimate/transaction
mirrors, replica reconcile, distance lookup, QuickBooks health). **Redis commands
are a hard monthly cap** — work out the daily cost before adding or accelerating
one; exhausting the quota takes down login along with everything else.

---

## Further reading

**[CLAUDE.md](CLAUDE.md)** is the detailed engineering guide: module scaffolding,
the `useListControls` API, CSS and scrolling conventions, FileMaker portal-write
behaviour and its traps, the auth model, and the release workflow. Read it before
making changes.
