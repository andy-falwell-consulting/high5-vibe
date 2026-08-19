import { getCurrentEnv } from '../config/fmpEnvironments';
import { makeVibeAttachments } from './vibeFiles';

// Workshop e-mails — preview and send, from Vibe (no Tray).
//
// Preview and send are separate calls on purpose: sending to a customer cannot
// be undone, so the exact message and the exact address are shown first.

const base = () => `/api/workshop-email?db=${encodeURIComponent(getCurrentEnv().db)}`;

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const TEMPLATE_VERSIONS = [
  { id: 'Training', label: 'Training' },
  { id: 'Exam_L1', label: 'Exam — Level 1' },
  { id: 'Exam_L2', label: 'Exam — Level 2' },
  { id: 'Exam_L3', label: 'Exam — Level 3' },
];

/** Resolved recipient + rendered message. Sends nothing. */
export const previewEmail = (workshopId, version) =>
  fetch(`${base()}&workshopId=${encodeURIComponent(workshopId)}&version=${encodeURIComponent(version)}`,
    { credentials: 'include' }).then(json);

/** Actually send. `to` overrides the resolved address. */
export const sendEmail = (workshopId, version, to) =>
  fetch(`${base()}&workshopId=${encodeURIComponent(workshopId)}`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version, ...(to ? { to } : {}) }),
  }).then(json);

// ── Templates (admin) ───────────────────────────────────────────────────────

export const getTemplates = () =>
  fetch(`${base()}&templates=1`, { credentials: 'include' }).then(json);

export const saveTemplate = (id, { subject, body, attachments }) =>
  fetch(`${base()}&templates=1`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, subject, body, attachments }),
  }).then(json);

// ── Template attachments ────────────────────────────────────────────────────
//
// The files that go out with a template, managed from Admin. Reuses Vibe's own
// file store — the same one CCS and inspection attachments use — under a
// `wsemail` parent kind, with the template id as the parent. The bytes land in
// Drive under the folder IT owns, so an attachment stays openable by a person
// with a browser even if this app disappears.
export const templateAttachments = makeVibeAttachments('wsemail');
