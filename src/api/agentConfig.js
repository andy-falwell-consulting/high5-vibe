import { getCurrentEnv } from '../config/fmpEnvironments';

// Assistant settings — Admin only. See docs/agent-admin-scope.md.

const url = () => `/api/agent-config?db=${encodeURIComponent(getCurrentEnv().db)}`;

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const getAgentConfig = () => fetch(url(), { credentials: 'include' }).then(json);

export const saveAgentConfig = changes =>
  fetch(url(), {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  }).then(json);
