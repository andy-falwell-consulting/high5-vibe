# What's changing in Vibe

*A short brief — August 2026*

## The short version

Vibe is becoming the place where CCS projects and contacts actually live, instead of a
window onto FileMaker. Once that happens, what you change in Vibe stays changed.

## Why things have felt unreliable

Right now Vibe doesn't read FileMaker directly. It reads a **copy** of FileMaker that
gets refreshed on a schedule.

That copy is usually a few minutes behind. So when you moved a card on the Kanban board
or changed a project's status, your change was saved — but the next refresh could pull in
the older copy and put it back. It looked like the change didn't take. It had; it just
got overwritten a moment later.

That's also why a contact you create can be impossible to find straight afterwards: it's
in FileMaker, but the copy Vibe is reading hasn't caught up yet.

We've patched the worst of it, but the real fix is to stop working this way.

## What changes for you

**Your changes stick.** Move a card, change a status, edit a record — it saves
immediately and stays put. No refresh putting it back.

**Things that are impossible today start working:**

- **Adding a person as a contact.** At the moment the new-contact form only really
  handles organisations — a person's name ends up in the company field, which is why
  "Ryan Doak" went in as a company and then showed up blank. You'll get proper first and
  last name fields.
- **Setting the Organization on a CCS project.** The bug you reported — where a new
  project from Contacts picks up the site name and won't let you set an organisation —
  goes away. It becomes an ordinary field you can just fill in.

**The board gets easier to use.** All the columns fit on screen, and you can drag a card
to any of them.

## The one thing to be aware of

**After this, changes you make in Vibe will not appear in FileMaker.**

Information will still flow *from* FileMaker *into* Vibe when we ask it to. But it's
one-way. A status you change in Vibe stays in Vibe.

Since we're retiring FileMaker anyway, that's the intended direction. But it means:

> **If you or anyone on the team still does work in FileMaker Pro, we need to know now —
> and specifically what you use it for.**

That's the main thing we need from you before we start.

## Rough order

1. **CCS projects and the Kanban board first** — that's where the problems are worst.
2. **Contacts next** — this is what unblocks adding people properly.
3. Inspections, estimates, trainings and the rest after that.

Before any of it, we set up automatic daily backups and test restoring from one.

## What we need from you

1. Does anyone still work directly in FileMaker Pro? If so, who, and for what?
2. Anything else in Vibe that's been quietly not working that you've worked around
   rather than reported? Now's a good moment to say.

---

*Questions to Andy.*
