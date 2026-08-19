import { Redis } from '@upstash/redis';
import { getServiceAccountToken, GMAIL_SEND_SCOPE } from './_gsa.js';
import { scanReplica } from './_replica.js';
import { courseKey } from './_oeTraining.js';

// Workshop e-mails, sent by Vibe.
//
// Replaces the FileMaker button that handed an e-mail version to a Tray
// workflow, which branched and delivered the message with its attachments from
// workshops@high5adventure.org. Tray is removed from the path entirely (Andy,
// 2026-08-19): Vibe holds the templates, Vibe holds the attachments, and Vibe
// sends the message.
//
// SENDING AS A SHARED ADDRESS is the part that needs no new architecture. The
// service account in _gsa.js already impersonates an internal user via
// domain-wide delegation for Drive; the same mechanism with the gmail.send
// scope and a subject of workshops@ sends AS that mailbox, and lands a copy in
// its Sent folder. That is the behaviour the FileMaker button had, and the
// reason not to fall back on the logged-in user's own Gmail — replies would go
// to whoever happened to click, and no shared record would exist.

const redis = Redis.fromEnv();
const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/** The mailbox the app sends as. Overridable so a preview deploy can be pointed
 *  at a test address rather than the real one. */
export const senderAddress = () =>
  process.env.WORKSHOP_MAIL_FROM || 'workshops@high5adventure.org';

// The four versions, from the `Workshop Emails` value list on Workshops_New.
// Ids are FileMaker's own strings so `email_version_sent` stays comparable
// across the changeover and the history already recorded still reads.
export const TEMPLATES = [
  { id: 'Training', label: 'Training' },
  { id: 'Exam_L1', label: 'Exam — Level 1' },
  { id: 'Exam_L2', label: 'Exam — Level 2' },
  { id: 'Exam_L3', label: 'Exam — Level 3' },
];
export const isTemplateId = id => TEMPLATES.some(t => t.id === id);

export const tplKey = db => `vibe:${db}:wsemail:tpl`;

const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

/** One template: `{ subject, body, attachments: [fileId], updatedAt, updatedBy }`
 *  or null when it has never been written. */
export async function readTemplate(db, id) {
  return parse(await redis.hget(tplKey(db), String(id)));
}

export async function readTemplates(db) {
  const all = await redis.hgetall(tplKey(db));
  const out = {};
  for (const t of TEMPLATES) out[t.id] = parse(all?.[t.id]) || null;
  return out;
}

export async function writeTemplate(db, id, { subject, body, attachments }, by) {
  if (!isTemplateId(id)) throw new Error(`unknown template: ${id}`);
  const tpl = {
    subject: String(subject ?? '').trim(),
    body: String(body ?? ''),
    attachments: [...new Set((attachments || []).map(String).filter(Boolean))],
    updatedAt: new Date().toISOString(),
    updatedBy: by || null,
  };
  await redis.hset(tplKey(db), { [id]: JSON.stringify(tpl) });
  return tpl;
}

// ── Recipient ───────────────────────────────────────────────────────────────

// Prefer a work address over a personal one, and never guess between two of the
// same type. Registrants genuinely have both — one on the AB-2026-1 roster has a
// personal gmail AND a high5 address — so a rule is needed, and the UI shows the
// chosen address before anything is sent so it can be overridden.
const TYPE_RANK = { Work: 0, Business: 0, Office: 0, Main: 1, Home: 2, Personal: 2, Other: 3 };

/** Pick one address from a contact's e-mail methods.
 *  Returns `{ address, type, alternatives }`, or null when there is none. */
export function pickEmail(emails) {
  const list = (emails || [])
    .map(e => ({ address: String(e?.address ?? e ?? '').trim(), type: String(e?.type ?? '').trim() }))
    .filter(e => e.address && e.type !== 'Web');
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) =>
    (TYPE_RANK[a.type] ?? 2) - (TYPE_RANK[b.type] ?? 2));
  return {
    address: sorted[0].address,
    type: sorted[0].type || null,
    alternatives: sorted.slice(1).map(e => e.address),
  };
}

/** The OE Lookup catalogue row for a course number, or null.
 *
 *  Program Code = Course Number is the join FileMaker itself declares — the
 *  `Course Number` field carries a value list named `OELookup`. 548 of 556
 *  sessions match; the rest are junk codes and simply get no catalogue detail.
 *
 *  Scans the replica rather than holding an index: this runs once per preview or
 *  send, which is a human-paced action, and an index would be another thing to
 *  keep in step for no gain at 1,247 rows. */
export async function catalogueForCourse(db, courseNumber) {
  const want = courseKey(courseNumber);
  if (!want) return null;
  let cursor = '0';
  do {
    const page = await scanReplica(db, 'oelookup', cursor, 1500);
    for (const r of page.records || []) {
      if (courseKey(r?.fieldData?.['Program Code']) === want) return r.fieldData;
    }
    cursor = page.cursor;
  } while (cursor !== '0');
  return null;
}

// ── Rendering ───────────────────────────────────────────────────────────────

// Deliberately a plain {{token}} substitution rather than a template language.
// These are staff-edited e-mails, not a programming surface, and anything that
// can evaluate is something that can be got wrong in a way that reaches a
// customer.
export function render(text, vars) {
  return String(text ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => {
    const v = vars?.[k];
    return v === undefined || v === null ? m : String(v);
  });
}

/** The substitutions a workshop e-mail can use. Every one comes from Vibe —
 *  nothing here reads FileMaker. */
export function templateVars({ workshop, catalogue, recipient }) {
  const w = workshop || {}, c = catalogue || {};
  const money = v => Number(v || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const fee = Number(w.tuitionFee || 0) + Number(w.foodFee || 0)
    + Number(w.lodgingFee || 0) + Number(w.extraLodgingFee || 0);
  return {
    first_name: String(w.contactName || '').trim().split(/\s+/)[0] || '',
    full_name: w.contactName || '',
    organization: w.organization || '',
    course_name: c['Program Type'] || w.courseName || '',
    course_number: w.courseNumber || '',
    start_date: c['Program Start Date'] || w.startDate || '',
    end_date: c['Program End Date'] || w.endDate || '',
    start_time: c['Program Start Time'] || w.startTime || '',
    location: w.site || c['Custom Site:'] || '',
    instructor: c['Lead Facilitator'] || w.instructor || '',
    hours: w.hours || c.Hours || '',
    fee_total: money(fee),
    deposit_due: money(Math.round(fee * 50) / 100),
    balance_due: money(Math.round((fee - Number(w.depositReceived || 0)) * 100) / 100),
    recipient_email: recipient?.address || '',
  };
}

// ── Send ────────────────────────────────────────────────────────────────────

const encodeHeader = s => (/^[\x20-\x7E]*$/.test(String(s ?? '')) ? String(s ?? '')
  : `=?UTF-8?B?${Buffer.from(String(s), 'utf-8').toString('base64')}?=`);
const wrap76 = s => String(s).replace(/(.{1,76})/g, '$1\r\n').trim();

function buildMime({ from, to, replyTo, subject, body, attachments }) {
  const headers = [
    `From: ${from}`, `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
  ].filter(Boolean);
  const textPart = ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', String(body ?? '')].join('\r\n');
  if (!attachments?.length) {
    return Buffer.from([...headers, textPart].join('\r\n'), 'utf-8').toString('base64url');
  }
  const b = 'mix_' + Math.random().toString(36).slice(2);
  const parts = [[...headers, `Content-Type: multipart/mixed; boundary="${b}"`, '', `--${b}`, textPart].join('\r\n')];
  for (const a of attachments) {
    parts.push([
      `--${b}`,
      `Content-Type: ${a.mimeType || 'application/octet-stream'}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      'Content-Transfer-Encoding: base64', '',
      wrap76(String(a.base64 || '')),
    ].join('\r\n'));
  }
  parts.push(`--${b}--`);
  return Buffer.from(parts.join('\r\n'), 'utf-8').toString('base64url');
}

/** Send as the shared workshops mailbox. Throws with Google's own message —
 *  a failed delegation grant reports as a 403 here, and saying so plainly beats
 *  a generic "send failed". */
export async function sendAsWorkshops({ to, replyTo, subject, body, attachments }) {
  const from = senderAddress();
  const token = await getServiceAccountToken({ scope: GMAIL_SEND_SCOPE, subject: from });
  const raw = buildMime({ from, to, replyTo, subject, body, attachments });
  const res = await fetch(GMAIL_SEND, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(j.error?.message
      || `Gmail rejected the send (HTTP ${res.status}). If this is a 403, the service account is probably not yet granted ${GMAIL_SEND_SCOPE} for ${from} in Workspace admin.`);
  }
  return { sent: true, messageId: j.id, threadId: j.threadId, from, to };
}
