// Unified Google endpoint — one serverless function dispatching on `action`,
// so we stay under Vercel's Hobby 12-function cap. Covers:
//   gmail.send       — send an email AS the logged-in user (their Sent folder)
//   calendar.list    — list this user's High 5 reminder events (tagged)
//   calendar.create  — create a reminder event
//   calendar.update  — patch a reminder (reschedule, edit, mark done)
//   calendar.delete  — delete a reminder event
//
// Every call reads the user's Google access token from the server-side session
// (never exposed to the browser). Reminders are real Calendar events tagged with
// extendedProperties.private.app = 'high5-reminder' so the app can find them and
// Google handles all the time-based notifications (popup/email/mobile) for free.
import { getGoogleSession } from './_googleSession.js';

const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const APP_TAG = 'high5-reminder';

// ── Gmail MIME ───────────────────────────────────────────────────
const wrap76 = b64 => b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();

// Headers are ASCII-only; RFC 2047 encoded-word for non-ASCII (em-dash, accents).
const encodeHeader = value => {
  const s = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf-8').toString('base64')}?=`;
};

const textPart = bodyText => [
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: base64', '',
  wrap76(Buffer.from(String(bodyText ?? ''), 'utf-8').toString('base64')),
].join('\r\n');

function buildMime({ from, to, cc, bcc, subject, bodyText, inReplyTo, attachments }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${encodeHeader(subject)}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    inReplyTo ? `References: ${inReplyTo}` : null,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  if (!attachments?.length) {
    return Buffer.from([...headers, textPart(bodyText)].join('\r\n'), 'utf-8').toString('base64url');
  }

  const boundary = 'mix_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const parts = [[
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`,
    textPart(bodyText),
  ].join('\r\n')];
  for (const a of attachments) {
    parts.push([
      `--${boundary}`,
      `Content-Type: ${a.mimeType || 'application/octet-stream'}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      'Content-Transfer-Encoding: base64', '',
      wrap76(String(a.base64 || '')),
    ].join('\r\n'));
  }
  parts.push(`--${boundary}--`);
  return Buffer.from(parts.join('\r\n'), 'utf-8').toString('base64url');
}

async function gmailSend(session, p) {
  if (!p.to || !p.subject) return { status: 400, body: { error: 'to and subject are required' } };
  const raw = buildMime({ from: session.email, to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, bodyText: p.bodyText, inReplyTo: p.inReplyTo, attachments: p.attachments });
  const sendBody = { raw };
  if (p.threadId) sendBody.threadId = p.threadId;
  const r = await fetch(GMAIL_SEND, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(sendBody),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { status: r.status, body: { error: j.error?.message || 'Send failed' } };
  return { status: 200, body: { sent: true, messageId: j.id, threadId: j.threadId, from: session.email } };
}

// ── Calendar (reminders) ─────────────────────────────────────────
const calHeaders = session => ({ Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' });

// Drop undefined/empty values; Calendar private props must be strings.
function privateTags(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  }
  return out;
}

async function calList(session, p) {
  const params = new URLSearchParams({
    singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
    privateExtendedProperty: `app=${APP_TAG}`,
  });
  if (p.timeMin) params.append('timeMin', p.timeMin);
  if (p.timeMax) params.append('timeMax', p.timeMax);
  if (p.recordId) params.append('privateExtendedProperty', `recordId=${p.recordId}`);
  const r = await fetch(`${CAL}?${params.toString()}`, { headers: calHeaders(session) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { status: r.status, body: { error: j.error?.message || 'List failed' } };
  return { status: 200, body: { items: j.items || [] } };
}

async function calCreate(session, p) {
  if (!p.startISO) return { status: 400, body: { error: 'startISO is required' } };
  const ev = {
    summary: p.title || 'Reminder',
    description: p.notes || '',
    start: { dateTime: p.startISO, timeZone: p.timeZone || 'UTC' },
    end: { dateTime: p.endISO || p.startISO, timeZone: p.timeZone || 'UTC' },
    reminders: { useDefault: false, overrides: (p.overrides?.length ? p.overrides : [{ method: 'popup', minutes: 10 }]) },
    extendedProperties: { private: privateTags({ app: APP_TAG, recordType: p.recordType, recordId: p.recordId, recordLabel: p.recordLabel, done: '0' }) },
  };
  const r = await fetch(CAL, { method: 'POST', headers: calHeaders(session), body: JSON.stringify(ev) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { status: r.status, body: { error: j.error?.message || 'Create failed' } };
  return { status: 200, body: j };
}

async function calUpdate(session, p) {
  if (!p.id) return { status: 400, body: { error: 'id is required' } };
  const patch = {};
  if (p.title !== undefined) patch.summary = p.title;
  if (p.notes !== undefined) patch.description = p.notes;
  if (p.startISO) patch.start = { dateTime: p.startISO, timeZone: p.timeZone || 'UTC' };
  if (p.endISO) patch.end = { dateTime: p.endISO, timeZone: p.timeZone || 'UTC' };
  if (p.overrides) patch.reminders = { useDefault: false, overrides: p.overrides };
  if (p.done !== undefined) patch.extendedProperties = { private: { done: p.done ? '1' : '0' } };
  const r = await fetch(`${CAL}/${encodeURIComponent(p.id)}`, { method: 'PATCH', headers: calHeaders(session), body: JSON.stringify(patch) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { status: r.status, body: { error: j.error?.message || 'Update failed' } };
  return { status: 200, body: j };
}

async function calDelete(session, p) {
  if (!p.id) return { status: 400, body: { error: 'id is required' } };
  const r = await fetch(`${CAL}/${encodeURIComponent(p.id)}`, { method: 'DELETE', headers: calHeaders(session) });
  if (r.status === 204 || r.ok) return { status: 200, body: { deleted: true } };
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: { error: j.error?.message || 'Delete failed' } };
}

const ACTIONS = {
  'gmail.send': gmailSend,
  'calendar.list': calList,
  'calendar.create': calCreate,
  'calendar.update': calUpdate,
  'calendar.delete': calDelete,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getGoogleSession(req);
  if (!session?.accessToken) return res.status(401).json({ error: 'Not authenticated' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Bad JSON' }); } }
  const { action, ...params } = body || {};
  const fn = ACTIONS[action];
  if (!fn) return res.status(400).json({ error: `Unknown action: ${action}` });

  try {
    const { status, body: out } = await fn(session, params);
    return res.status(status).json(out);
  } catch {
    return res.status(502).json({ error: 'Google API unreachable' });
  }
}
