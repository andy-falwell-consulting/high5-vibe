import { useState, useMemo } from 'react'
import './Help.css'

// In-app Help / user guide. Pure content — no data fetching. Sections are
// data-driven so the table of contents stays in sync with the body.
// MODULE_DOCS documents each page; keep it aligned with the MODULES array in App.jsx.

const Tag = ({ children }) => <span className="hlp-tag">{children}</span>

// Order mirrors the nav rail (MODULES in App.jsx).
const MODULE_DOCS = [
  { id: 'home', icon: '⌂', name: 'Home', body: (
    <p>Your dashboard. Shows the project pipeline across its stages, counts of active projects,
      contacts, and inspections, upcoming events in the next 30 days, and recently updated projects.
      Everything is clickable — jump straight to a record or another page. Read-only.</p>
  ) },
  { id: 'reminders', icon: '⏰', name: 'Reminders', body: (
    <p>A to-do list with due dates, grouped into Overdue, Today, This Week, Later, and Done. Filter
      Open / Done / All, or search. For each reminder you can tick it done, snooze a day, edit, or
      delete. A reminder can be attached to any record (a contact, inspection, project…) — click the
      link to jump there. A sound toggle chimes when a new reminder comes due.</p>
  ) },
  { id: 'contacts', icon: '◉', name: 'Contacts', body: (
    <>
      <p>Your directory of organizations and people. The <strong>Type</strong> field (Organization vs
        Individual) reflects the record's organization flag. Filter by status (Active / Inactive /
        Prospect) or search. Edit fields — including <strong>Title</strong> — with Edit → Save.</p>
      <p>If a contact is marked <strong>Client Alert</strong>, their name shows in red everywhere it
        appears — in the list and on their record — with a warning banner on the record itself.</p>
      <p>From a contact you can <strong>compose an email</strong> or <strong>set a reminder</strong>.
        Tabs show related Inspections, Trainings, CCS projects, Estimates, Invoices, Risk items, and
        related contacts (with each person's title, where known) — click a row to open it. Invoices open
        as the QuickBooks PDF. <strong>Overview</strong> is a merged activity feed scoped to the current
        year plus the two prior.</p>
    </>
  ) },
  { id: 'estimates', icon: '◧', name: 'Estimates', body: (
    <p>Client quotes. Edit the title, status, class (New Build / Repair), date, and memo with
      Edit → Save. The line-items table (item, qty, unit price, amount) is read-only; subtotal, tax,
      and total are calculated automatically.</p>
  ) },
  { id: 'inspections', icon: '⚑', name: 'Inspections', body: (
    <p>Site safety audits. Each record carries the site, date, inspector, and Report Ready / Needs
      Repair flags, plus facilitator-access and course-type checkboxes and a table of inspected
      elements and equipment. Edit fields and checkboxes with Edit → Save. You can <strong>generate the
      inspection report PDF and attach it</strong>, download it, and add file attachments.</p>
  ) },
  { id: 'rmi', icon: '⚠', name: 'Risk Management', body: (
    <p>Tracks client risk inquiries and follow-ups. Each record has a risk level and level of concern
      (High / Medium / Low, color-coded), who it's assigned to, a grid of risk questions, a note of
      concern, and a follow-up log. Filter by Active / Resolved / High risk. Edit with Edit → Save.</p>
  ) },
  { id: 'trainings', icon: '◳', name: 'Trainings', body: (
    <p>Custom training proposals and logistics. Holds the program details (type, dates, hours,
      audience, group size, lead trainer, location), a Proposed-vs-Actual cost breakdown, a logistics
      checklist, and the sales pipeline with QuickBooks estimate/invoice references. Edit most fields
      with Edit → Save (organization, contact, and QuickBooks references are read-only). Has a Photos
      attachments panel.</p>
  ) },
  { id: 'eol', icon: '◆', name: 'Edge of Leadership', body: (
    <p><Tag>Not available yet</Tag> No dedicated Edge of Leadership layout exists in FileMaker yet, so
      there's nothing to show here — this page is a placeholder until one is built.</p>
  ) },
  { id: 'tnd', icon: '✦', name: 'Team Development', body: (
    <p><Tag>Not available yet</Tag> No dedicated Team Development layout exists in FileMaker yet, so
      there's nothing to show here — this page is a placeholder until one is built.</p>
  ) },
  { id: 'oe-lookup', icon: '◎', name: 'OE Lookup', body: (
    <p><Tag>Read-only</Tag> A reference of open-enrollment and custom programs — program type and code,
      site, dates and times, hours, lead facilitator and co-trainers, and a cost breakdown with a
      calculated total. Filter OE vs Custom and sort. No editing.</p>
  ) },
  { id: 'products', icon: '◫', name: 'Products & Services', body: (
    <>
      <p>Your internal catalog and Shopify / QuickBooks inventory. Fields include High 5 Sku, vendor,
        type, category, cost, unit price, and descriptions. Edit with Edit → Save.</p>
      <p>If <strong>Assembly Product</strong> is checked, the item's Price is rolled up from its
        <strong> Bill of Materials</strong> (its components) instead of the unit price — add or change
        components while in Edit mode and they save along with everything else. You can <strong>sync an
        item to Shopify and QuickBooks</strong> and upload product photos. Filter by vendor, type, or
        category.</p>
    </>
  ) },
  { id: 'transactions', icon: '⇄', name: 'Transactions', body: (
    <p><Tag>Read-only</Tag> A live ledger of QuickBooks transactions — invoices, estimates, sales
      receipts (Shopify orders appear here too), and credit memos. Filter by type or status, search by
      number / customer, and sort by date, amount, number, or customer. Open a transaction's PDF, or
      jump straight to it in QuickBooks Online with <strong>Open in QBO</strong>. No editing — this
      page mirrors QuickBooks, it doesn't write to it.</p>
  ) },
  { id: 'projects', icon: '◈', name: 'CCS', body: (
    <>
      <p>Challenge-course (CCS) projects, with three views: <strong>Workspace</strong> (full detail),
        <strong> List</strong> (a sortable table), and <strong>Board</strong> (kanban). Every project has
        one <strong>status</strong> — Inquiry, In Process, Proposed, Approved, Sent Contract & DI,
        Confirmed/Scheduled, Completed, No Go, or Other — that drives the record, the pipeline bar, and
        the board. Edit fields in the Workspace view with Edit → Save. Project Type is
        multi-select (up to 3), and Lead Builder / Builder options are pulled live from FileMaker, so
        they're always current.</p>
      <p><strong>Project phases</strong> are checklists (Pre-Proposal → Post Job). Check an item off as
        it's done, or mark it <strong>N/A</strong> if it doesn't apply to this project — either way counts
        it toward the phase reaching 100%. Notes has a <strong>Stamp</strong> button that prepends your
        name, date, and time.</p>
      <p>The <strong>Board</strong> only shows jobs the team has put there — it's curated, not automatic.
        Use <strong>＋ Add projects</strong> to add one; a job drops off on its own once it's Completed or
        No Go. Within a lane you can drag a card to reorder it — the order is shared, so everyone sees
        the same arrangement. Dragging a card to a different lane changes its status.</p>
    </>
  ) },
  { id: 'admin', icon: '⚙', name: 'Admin', body: (
    <p>Settings and integrations. Today it holds the <strong>Shopify connection</strong> (link your
      store so products and prices can sync). Configuration only — no records to edit.</p>
  ) },
]

export default function Help() {
  const [active, setActive] = useState('overview')

  const sections = useMemo(() => SECTIONS, [])

  const go = (id) => {
    setActive(id)
    document.getElementById(`hlp-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="hlp-container">
      <aside className="hlp-toc">
        <div className="hlp-toc-title">Help &amp; guide</div>
        <nav>
          {sections.map(s => (
            <button key={s.id}
              className={`hlp-toc-link${active === s.id ? ' active' : ''}`}
              onClick={() => go(s.id)}>{s.toc}</button>
          ))}
        </nav>
      </aside>

      <main className="hlp-main">
        <div className="hlp-content">
          {sections.map(s => (
            <section key={s.id} id={`hlp-${s.id}`} className="hlp-section">
              <h2 className="hlp-h2">{s.title}</h2>
              {s.body}
            </section>
          ))}
          <div className="hlp-footer">Vibe — High 5 Adventure Learning Center. Press <kbd>⌘K</kbd> anywhere to search or ask the assistant.</div>
        </div>
      </main>
    </div>
  )
}

// — Content ————————————————————————————————————————————————————————————————

const SECTIONS = [
  {
    id: 'overview', toc: 'Welcome', title: 'Welcome to Vibe',
    body: (
      <>
        <p>Vibe is High 5's internal hub. It brings your FileMaker records, QuickBooks accounting,
          Shopify store, and Google Workspace (Gmail, Calendar, Drive) into one place, organized as a
          set of <strong>pages</strong> in the left nav rail.</p>
        <p>Every page works the same way: a <strong>list</strong> on the left to find a record, and a
          <strong> detail view</strong> on the right that shows everything about the one you picked. The
          two skills worth learning first are <strong>Search / the assistant</strong> (to find anything
          fast) and the <strong>Edit → Save</strong> flow (to change a record). Both are covered below.</p>
      </>
    ),
  },
  {
    id: 'start', toc: 'Getting started', title: 'Getting started',
    body: (
      <>
        <ul className="hlp-list">
          <li><strong>Sign in</strong> with your High 5 Google account. Access is limited to approved
            accounts; if you can't get in, ask an admin to add you.</li>
          <li><strong>The nav rail</strong> (left) lists every page, grouped into Overview, Records,
            Projects, and System. Click a name to open it. Drag the rail's edge to resize it, or collapse
            it to icons.</li>
          <li><strong>Your edits are attributed to you.</strong> When you save a change, Vibe records it
            under your name, not a shared admin account.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'search', toc: 'Search & the assistant', title: 'Finding things — Search & the assistant',
    body: (
      <>
        <p>Press <kbd>⌘K</kbd> (or click <strong>Search or ask…</strong> in the rail) to open the
          command bar. It's the one-stop way to get anywhere:</p>
        <ul className="hlp-list">
          <li><strong>Jump to a record</strong> — start typing a contact, inspection, project, or product
            name and press <kbd>↵</kbd> to open it.</li>
          <li><strong>Go to a page</strong> — type a page name (e.g. "Inspections").</li>
          <li><strong>Ask the assistant</strong> — type a question and pick <em>Ask the assistant</em>.
            Use this for anything that isn't a direct record lookup.</li>
        </ul>
        <p>The <strong>assistant</strong> can pull from FileMaker, QuickBooks, Shopify, Gmail, Calendar,
          and Drive. It's the right tool for questions search can't answer — for example:</p>
        <ul className="hlp-list">
          <li>"What are our open invoices in QuickBooks?" / "open invoices over $5,000"</li>
          <li>"How many Shopify products were added in the last 3 months?"</li>
          <li>"Which inspections need repair?"</li>
          <li>"Summarize the most recent project" or "draft an email to…"</li>
        </ul>
        <p>Because it reads QuickBooks live, the assistant is also how you search invoices by number,
          amount, date, or status. It can also take actions (send an email, create a calendar event) — it
          will make the action clear before doing anything consequential.</p>
      </>
    ),
  },
  {
    id: 'editing', toc: 'Editing records', title: 'Editing records — Edit, Save, Discard',
    body: (
      <>
        <p>Most record pages follow the same edit pattern:</p>
        <ul className="hlp-list">
          <li>Open a record. By default fields are <strong>read-only</strong>.</li>
          <li>Click <strong>Edit</strong> to make fields editable.</li>
          <li>Change what you need. A <strong>Save / Discard</strong> bar appears showing how many unsaved
            changes you have.</li>
          <li><strong>Save</strong> writes every change at once (and, where relevant, syncs to QuickBooks
            or Shopify). <strong>Discard</strong> throws the changes away.</li>
        </ul>
        <p>Nothing is written until you press Save, so you can edit freely and back out with Discard.
          Some pages are intentionally <strong>view-only</strong> and have no Edit button (noted per page
          below).</p>
      </>
    ),
  },
  {
    id: 'environments', toc: 'Environments', title: 'Environments (Development / Staging / Production)',
    body: (
      <>
        <p>The dropdown at the bottom of the nav rail switches which FileMaker database Vibe is pointed
          at: <strong>Development</strong>, <strong>Staging</strong>, or <strong>Production</strong>.
          Production is the real, live data — be deliberate about edits there. Development and Staging are
          for testing. The current environment is shown by a colored dot (green / amber / red).</p>
      </>
    ),
  },
  {
    id: 'pages', toc: 'The pages', title: 'The pages',
    body: (
      <>
        <p>What each page in the nav rail is for and how it works.</p>
        <div className="hlp-modules">
          {MODULE_DOCS.length === 0
            ? <p className="hlp-muted">Documentation for individual pages is being finalized.</p>
            : MODULE_DOCS.map(m => (
              <div key={m.id} className="hlp-mod" id={`hlp-page-${m.id}`}>
                <div className="hlp-mod-head"><span className="hlp-mod-icon">{m.icon}</span>{m.name}</div>
                {m.body}
              </div>
            ))}
        </div>
      </>
    ),
  },
  {
    id: 'shortcuts', toc: 'Shortcuts & tips', title: 'Shortcuts & tips',
    body: (
      <>
        <ul className="hlp-list">
          <li><kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> — open Search / the assistant from anywhere.</li>
          <li><kbd>↑</kbd> <kbd>↓</kbd> to move, <kbd>↵</kbd> to open, <kbd>Esc</kbd> to close — in the
            command bar.</li>
          <li>Most list sidebars have a <strong>search box, filter chips, and sort options</strong> at the
            top; your sort choice is remembered per page.</li>
          <li>Drag the divider between the list and the detail view to resize it.</li>
          <li>Use the <strong>theme toggle</strong> (in the command bar's Actions, or the rail) to switch
            light / dark.</li>
        </ul>
      </>
    ),
  },
]
