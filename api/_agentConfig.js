import { Redis } from '@upstash/redis';

// Runtime settings for the assistant, so its behaviour can be tuned without a
// deploy. See docs/agent-admin-scope.md.
//
// Absent config means DEFAULTS — the agent behaves exactly as it did before this
// existed until somebody changes something. That matters: a config store that
// alters behaviour by merely existing is one nobody can safely introduce.

const redis = Redis.fromEnv();

export const agentConfigKey = db => `vibe:${db}:agent:config`;

// Honours the existing AGENT_MODEL env var as the default, so an environment
// already pinned to a model keeps it until someone chooses otherwise in Admin.
// Dropping that would have silently re-pointed any such deploy.
export const DEFAULT_MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-6';
export const DEFAULT_MAX_TURNS = 12;
export const DEFAULT_MAX_OUTPUT = 8192;

// Offered in the picker. Kept short on purpose — every entry is something worth
// running the assistant on, not everything that exists.
export const MODEL_CHOICES = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — default, best for tool use' },
  { id: 'claude-opus-4-1', label: 'Opus 4.1 — strongest reasoning, slower and dearer' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest and cheapest, less reliable with tools' },
];

// Which tools write, or act outside Vibe on someone's behalf. The read-only
// switch turns exactly these off.
//
// `gmail` and `drive` are here despite also being READ tools: their action
// parameter carries `send`, `delete` and `share`, so the tool cannot be split
// into a safe half without splitting the tool itself. Listing them is the honest
// answer — a read-only mode that left `gmail` enabled would be lying.
export const WRITE_TOOLS = ['gmail', 'calendar', 'drive', 'shopify_graphql', 'qbo_query'];

export const ALL_TOOLS = [
  'get_schema', 'search_records', 'get_record',
  'search_contacts', 'get_contact',
  'shopify_graphql', 'qbo_query',
  'gmail', 'calendar', 'drive',
];

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export function normalise(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  // An unrecognised stored model falls back rather than being passed through —
  // a typo in Redis should not take the assistant down until someone notices.
  const model = MODEL_CHOICES.some(m => m.id === c.model) ? c.model : DEFAULT_MODEL;
  const disabled = [...new Set((c.disabled || []).filter(t => ALL_TOOLS.includes(t)))];
  return {
    guidance: String(c.guidance ?? '').trim(),
    model,
    readOnly: !!c.readOnly,
    disabled,
    // Bounded rather than free. A max-turns of 200 is not a preference, it is a
    // bill; 0 is not caution, it is an assistant that cannot use a tool.
    maxTurns: clampInt(c.maxTurns, 1, 30, DEFAULT_MAX_TURNS),
    maxOutputTokens: clampInt(c.maxOutputTokens, 512, 16384, DEFAULT_MAX_OUTPUT),
    updatedAt: c.updatedAt || null,
    updatedBy: c.updatedBy || null,
  };
}

export async function readAgentConfig(db) {
  const raw = await redis.get(agentConfigKey(db)).catch(() => null);
  return normalise(raw);
}

export async function writeAgentConfig(db, changes, by) {
  const next = normalise({ ...(await readAgentConfig(db)), ...changes });
  next.updatedAt = new Date().toISOString();
  next.updatedBy = by || null;
  await redis.set(agentConfigKey(db), next);
  return next;
}

/** The tools actually offered to the model.
 *
 *  A disabled tool is REMOVED from the request, not discouraged in the prompt.
 *  A prompt is guidance and a determined model can talk itself past it; a tool
 *  that was never sent cannot be called at all. */
export function activeTools(tools, config) {
  const off = new Set(config.disabled);
  if (config.readOnly) for (const t of WRITE_TOOLS) off.add(t);
  return tools.filter(t => !off.has(t.name));
}
