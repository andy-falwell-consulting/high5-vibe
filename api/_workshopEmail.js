import { Redis } from '@upstash/redis';
import { getServiceAccountToken, GMAIL_SEND_SCOPE, DRIVE_SCOPE } from './_gsa.js';
import { scanReplica } from './_replica.js';
import { courseKey } from './_oeTraining.js';
import { listForParent, getFile, driveToken } from './_vibeFiles.js';
import { downloadFile } from './_backupDrive.js';

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

// Two addresses, deliberately separate.
//
// IMPERSONATION requires a real Workspace USER — domain-wide delegation acts as
// a person, and a group or forwarding alias has no mailbox to act as. That is
// what `workshops@high5adventure.org` turned out not to be: delegation was
// refused for it while the Drive scope worked fine elsewhere.
//
// The FROM address is a separate question. Gmail will send as any address
// verified as a "Send mail as" alias on the impersonated account, so once
// workshops@ is a verified alias on the sending user, WORKSHOP_MAIL_FROM can
// point at it and customers see the right sender — no code change, no deploy.
// Until then From falls back to the impersonated user, which is honest: better a
// visibly internal sender than a spoofed one Gmail would refuse or mark.

/** The Workspace USER whose mailbox is impersonated. Must be a real user. */
export const senderUser = () =>
  process.env.WORKSHOP_MAIL_USER || 'it@high5adventure.org';

/** The address the message appears FROM. Defaults to the impersonated user;
 *  set WORKSHOP_MAIL_FROM to a verified alias (e.g. workshops@) to change it. */
export const senderAddress = () =>
  process.env.WORKSHOP_MAIL_FROM || senderUser();

/** Where replies should go. Falls back to From. */
export const replyToAddress = () =>
  process.env.WORKSHOP_MAIL_REPLY_TO || senderAddress();

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

// ── Attachments ─────────────────────────────────────────────────────────────

// Gmail's own ceiling is 25 MB for the whole encoded message; base64 inflates
// bytes by about a third, so the raw budget is nearer 18 MB. Refusing loudly
// beats Gmail rejecting the send with a message nobody will connect to the
// size of a PDF somebody attached weeks earlier.
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

/** The files attached to a template, as metadata only. */
export const templateFiles = (db, templateId) => listForParent(db, 'wsemail', String(templateId));

/** Fetch a template's attachments as base64 parts ready for the MIME builder.
 *
 *  Reads from Vibe's file store, whose bytes live in Drive under the folder IT
 *  owns — so an attachment stays openable by a person with a browser even if
 *  this app disappears, which is the same reason the store exists at all. */
export async function loadAttachments(db, templateId) {
  const metas = await templateFiles(db, templateId);
  if (!metas.length) return [];
  const token = await driveToken();
  const out = [];
  let total = 0;
  for (const m of metas) {
    const meta = m.driveId ? m : await getFile(db, m.fileId);
    if (!meta?.driveId) continue;
    const bytes = await downloadFile(token, meta.driveId);
    total += bytes.length;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachments exceed ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB — Gmail will reject the message. Remove one from this template.`);
    }
    out.push({
      filename: meta.name || 'attachment',
      mimeType: meta.mime || 'application/octet-stream',
      base64: Buffer.from(bytes).toString('base64'),
    });
  }
  return out;
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

/** Prove the delegation works, WITHOUT sending anything.
 *
 *  Two failures are worth telling apart and a send would conflate them:
 *   - the token request itself is refused (`unauthorized_client`) — the scope is
 *     not granted to this service account in Workspace admin;
 *   - the token mints but Gmail refuses the profile — the grant exists but the
 *     address is not a mailbox this account can act as (a group alias rather
 *     than a real user is the usual cause).
 *
 *  Reads the mailbox's own profile, which is the cheapest call that requires the
 *  impersonation to have actually worked. */
export async function checkDelegation() {
  const from = senderUser();          // the mailbox being impersonated
  const showsAs = senderAddress();    // what recipients would see
  const account = process.env.GDRIVE_SA_EMAIL || null;

  // Does delegation work for this SUBJECT at all, on a scope already known to
  // be granted? This separates the two things the Gmail failure conflates:
  //
  //   drive ok, gmail not  -> the wiring and the mailbox are fine; only the
  //                           gmail.send scope is missing from the entry.
  //   both fail            -> the client id is wrong, the entry is missing
  //                           entirely, or workshops@ cannot be impersonated.
  //
  // Without this, "unauthorized_client" is the same message for a missing scope
  // and a wrong client id, which are very different things to go and fix.
  let driveForSubject = null;
  try {
    await getServiceAccountToken({ scope: DRIVE_SCOPE, subject: from, force: true });
    driveForSubject = 'ok';
  } catch (e) {
    driveForSubject = String(e?.message || e).slice(0, 200);
  }

  // And does delegation work AT ALL? Drive demonstrably works in this app, but
  // that proves nothing about DELEGATION: if GDRIVE_SA_SUBJECT is unset the
  // service account acts as ITSELF and reaches the files because the folder is
  // shared with it directly — no impersonation anywhere in the picture.
  //
  // That distinction decides the fix. A configured subject that works means
  // delegation exists and only this mailbox is the problem. No configured
  // subject means delegation was never set up at all, and the Drive success
  // everyone is reasoning from is evidence of something else entirely.
  const configuredSubject = process.env.GDRIVE_SA_SUBJECT || null;
  let driveNoSubject = null;
  try {
    await getServiceAccountToken({ scope: DRIVE_SCOPE, subject: undefined, force: true });
    driveNoSubject = 'ok';
  } catch (e) {
    driveNoSubject = String(e?.message || e).slice(0, 160);
  }

  let token;
  try {
    token = await getServiceAccountToken({ scope: GMAIL_SEND_SCOPE, subject: from, force: true });
  } catch (e) {
    return {
      ok: false, stage: 'token', impersonating: from, showsAs, scope: GMAIL_SEND_SCOPE,
      serviceAccount: account,
      configuredDriveSubject: configuredSubject,
      delegationWorksForThisMailbox: driveForSubject === 'ok',
      driveProbe: driveForSubject,
      driveAsItself: driveNoSubject,
      diagnosis: driveForSubject === 'ok'
        ? `Delegation works for ${from} on Drive, so the client id is right and this mailbox can be impersonated. The only thing missing is the gmail.send scope on that entry.`
        : !configuredSubject
          ? 'DELEGATION IS PROBABLY NOT SET UP AT ALL. GDRIVE_SA_SUBJECT is unset, so Drive works by the folder being SHARED with the service account, not by impersonating anyone. Nothing in this app has ever exercised domain-wide delegation, so there is no existing entry to add a scope to — one has to be created for this client id, with the gmail.send scope, before any mailbox can be impersonated.'
          : `Delegation is configured for ${configuredSubject} but fails for ${from}. Either ${from} is not a real Workspace user, or the entry does not cover it.`,
      error: String(e?.message || e),
      // Match Google's PROSE, not just the error code. The body of this
      // rejection reads "Client is unauthorized to retrieve access tokens using
      // this method, or client not authorized for any of the scopes requested."
      // — which contains neither `unauthorized_client` nor `invalid_grant`, so
      // matching on the codes alone printed the useless generic hint at exactly
      // the moment the specific one was needed.
      hint: /unauthorized_client|invalid_grant|unauthorized to retrieve access tokens|not authorized for any of the scopes/i
        .test(String(e?.message || e))
        ? `Workspace admin has not granted ${GMAIL_SEND_SCOPE} to this service account's CLIENT ID (the ~21-digit Unique ID, not the e-mail). Check the scope is listed exactly, with no trailing slash, and that the entry was saved — propagation can take up to ~15 minutes. The scope box REPLACES rather than appends, so the Drive scope must still be listed alongside it.`
        : 'The token request was rejected before Gmail was reached.',
    };
  }
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',
    { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false, stage: 'mailbox', impersonating: from, showsAs,
      serviceAccount: account, error: body.error?.message || `HTTP ${res.status}`,
      hint: res.status === 400 || res.status === 404
        ? `${from} may not be a real Workspace mailbox — a group alias or forwarding address cannot be impersonated and has no Sent folder.`
        : 'The grant looks present but Gmail refused the impersonation.',
    };
  }
  return {
    ok: true, impersonating: from, showsAs, serviceAccount: account,
    mailbox: body.emailAddress,
    messagesTotal: body.messagesTotal ?? null,
    aliasNeeded: showsAs !== from,
    note: showsAs === from
      ? `Delegation works — Vibe can send as ${from}.`
      : `Delegation works for ${from}. Sending as ${showsAs} additionally requires it to be a verified "Send mail as" alias on that account.`,
  };
}

/** Send as the shared workshops mailbox. Throws with Google's own message —
 *  a failed delegation grant reports as a 403 here, and saying so plainly beats
 *  a generic "send failed". */
export async function sendAsWorkshops({ to, replyTo, subject, body, attachments }) {
  const from = senderAddress();
  const user = senderUser();
  // Impersonate the USER, then set From to the sending address. When the two
  // differ, Gmail requires From to be a verified alias on that user and refuses
  // otherwise — which is the correct behaviour: it is the check that stops this
  // becoming a way to send as anyone.
  const token = await getServiceAccountToken({ scope: GMAIL_SEND_SCOPE, subject: user });
  const raw = buildMime({ from, to, replyTo, subject, body, attachments });
  const res = await fetch(GMAIL_SEND, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = j.error?.message || `HTTP ${res.status}`;
    throw new Error(from !== user && /alias|from|denied|invalid/i.test(msg)
      ? `${msg} — sending as ${from} while impersonating ${user} requires ${from} to be a verified "Send mail as" alias on that account.`
      : `${msg} — if this is a 403, ${GMAIL_SEND_SCOPE} is probably not granted to the service account for ${user}.`);
  }
  return { sent: true, messageId: j.id, threadId: j.threadId, from, sentBy: user, to };
}
