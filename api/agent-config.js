import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { isAdminEmail } from './_admin.js';
import { buildSystem } from './agent.js';
import {
  readAgentConfig, writeAgentConfig, activeTools,
  MODEL_CHOICES, ALL_TOOLS, WRITE_TOOLS,
} from './_agentConfig.js';

// Settings for the assistant — Admin only.
//
//   GET  /api/agent-config?db=…  → config, choices, and the ASSEMBLED prompt
//   POST /api/agent-config?db=…  { guidance?, model?, readOnly?, disabled?, … }
//
// The GET returns the fully assembled system prompt because the point of this
// tab is to stop the prompt being something people infer. What the model is
// told should be readable, not reconstructed from a source file.

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'admin only' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  try {
    if (req.method === 'POST') {
      const b = req.body || {};
      const changes = {};
      for (const k of ['guidance', 'model', 'readOnly', 'disabled', 'maxTurns', 'maxOutputTokens']) {
        if (k in b) changes[k] = b[k];
      }
      await writeAgentConfig(db, changes, session.email);
    } else if (req.method !== 'GET') {
      return res.status(405).json({ error: 'GET or POST' });
    }

    const config = await readAgentConfig(db);
    // Rendered for a signed-in user, since that is the normal case and the
    // prompt differs when no Google account is attached.
    const prompt = buildSystem({ name: session.name || 'the user', email: session.email }, config);
    const enabled = activeTools(ALL_TOOLS.map(name => ({ name })), config).map(t => t.name);

    return res.status(200).json({
      config,
      choices: { models: MODEL_CHOICES, tools: ALL_TOOLS, writeTools: WRITE_TOOLS },
      enabledTools: enabled,
      prompt,
      promptChars: prompt.length,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
