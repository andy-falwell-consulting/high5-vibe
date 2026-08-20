# Agent management — scope

**Status:** scoped and built (v1.0.452). Measured against `api/agent.js` as it
stood on 2026-08-19.

An Admin tab for the assistant, so its behaviour can be tuned without a deploy.

---

## What the agent is today

Worth stating, because the obvious assumption is wrong: **it is already an
Anthropic agent.** `claude-sonnet-4-6` via `@anthropic-ai/sdk`, streaming, with a
hand-rolled tool loop capped at 12 turns and 8,192 output tokens.

Ten tools, all executing **inside the Vercel function**:

| Tool | Reaches |
|---|---|
| `get_schema`, `search_records`, `get_record` | FileMaker, admin credentials |
| `search_contacts`, `get_contact` | Vibe's contact model (Redis) |
| `shopify_graphql` | Shopify, token from Redis |
| `qbo_query` | QuickBooks, token from Redis |
| `gmail`, `calendar`, `drive` | **the signed-in user's own Google token** |

That last row is why this tab exists rather than a migration to a hosted agent:
those three act *as the person asking*, and no agent running on someone else's
infrastructure can do that.

---

## The one real trap

The system prompt has two kinds of content and they need opposite treatment.

**Mechanical facts that must match the code** — tool names, parameter shapes,
module key fields (interpolated live from `MODULES`), QBO's lack of `SUM`/`GROUP
BY`, the exact action lists for `gmail`/`calendar`/`drive`. Let these be edited
freely and they drift from the running tools, and the agent starts calling
things with wrong arguments. The failure looks like the model being stupid, which
is the worst possible diagnosis to be handed.

**Behaviour worth tuning** — which system to prefer, when to confirm before a
write, formatting, the "compute the real aggregate, never cap at 50" rule.

So the tab **owns the second and generates the first**. Same split that worked
for value lists: canonical facts the code controls, an editable layer on top.

---

## What the tab manages

### 1. Guidance

Free text, appended to the generated prompt. **Appended, not replacing.** The
existing guidance encodes fixes for real misbehaviour — the aggregate rule
exists because the agent capped a "total everything" answer at one page, and the
write-confirmation rule because it acted without being asked. A blank-slate
editor invites losing those by accident, so the standing text is shown above the
box, in force, and the editor adds to it.

### 2. Model

`claude-sonnet-4-6` today, from `AGENT_MODEL`. A setting rather than an env var,
so trying Haiku for a week is a click rather than a Vercel change and a redeploy.

### 3. Tool switches

The control that does not exist today and should. The agent currently always has
`gmail.delete` — **permanent, not trash** — plus `drive.delete` and
`drive.share`. Any tool can be turned off, and there is a single read-only
switch that disables every write path at once.

Disabled tools are removed from the API call entirely, not merely discouraged in
the prompt. A prompt is guidance; an absent tool cannot be called.

### 4. Limits

Max tool turns (12) and max output tokens (8,192), both constants today.
Runaway tool loops are the expensive failure mode, so the ceiling belongs
somewhere visible.

### 5. Prompt preview

The fully assembled system prompt, read-only. What the model is actually told,
rather than what someone believes it is told.

---

## Deliberately not managed

**Tool descriptions and module field lists.** Those are contracts with running
code. If a tool's description needs changing the tool probably needs changing,
and that is a deploy either way. Exposing them would let Admin describe a tool
the code does not implement.

---

## Storage

`vibe:{db}:agent:config` — one Redis key holding `{ guidance, model, disabled[],
readOnly, maxTurns, maxOutputTokens, updatedAt, updatedBy }`. Absent means
defaults, so the agent behaves exactly as it does today until someone changes
something.
