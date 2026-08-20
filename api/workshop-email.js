import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { isAdminEmail } from './_admin.js';
import { readWorkshop, patchWorkshop } from './_oeTraining.js';
import {
  TEMPLATES, isTemplateId, readTemplate, readTemplates, writeTemplate,
  pickEmail, render, templateVars, sendAsWorkshops, senderAddress, catalogueForCourse,
  templateFiles, loadAttachments, checkDelegation, replyToAddress, sendTestMessage,
  templateIsSendable,
} from './_workshopEmail.js';
import { renderEmailHtml } from './_mdEmail.js';

// Workshop e-mails — preview, send, and template administration.
//
//   GET  ?db=…&templates=1                    → the four templates (admin)
//   GET  ?db=…&workshopId=…&version=Training  → PREVIEW: resolved recipient and
//                                               rendered message. Sends nothing.
//   POST ?db=…&workshopId=…  { version, to? } → SEND
//   POST ?db=…&templates=1   { id, subject, body, attachments } → save (admin)
//
// GET and POST are split so the UI can show exactly what is about to go out,
// to exactly which address, before anything leaves the building. Sending an
// e-mail to a customer is not undoable, so the preview is not a nicety.

async function recipientFor(db, workshop, req) {
  if (!workshop?.contactId) return null;
  // Vibe's own contact model — the registrant's address is NOT reachable on the
  // FileMaker workshop layout (`wkshp_cntct_INADR__email::zz__Address__ct` is
  // empty on every row sampled), so this is the only source, and it is one we own.
  const proto = (req.headers['x-forwarded-proto'] || 'https');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const res = await fetch(
    `${proto}://${host}/api/contacts?db=${encodeURIComponent(db)}&id=${encodeURIComponent(workshop.contactId)}`,
    { headers: { cookie: req.headers.cookie || '' } });
  if (!res.ok) return null;
  const body = await res.json().catch(() => ({}));
  const entity = body.person || body.organization || body.entity || body;
  return pickEmail(entity?.emails);
}

export default async function handler(req, res) {
  const session = await getGoogleSession(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });

  const db = String(req.query?.db || '');
  if (!ALLOWED_DBS.has(db)) return res.status(400).json({ error: 'db not allowed' });

  try {
    // ── Is the Workspace grant in place? Sends nothing. ────────────────────
    if (req.query?.check === '1') {
      if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'admin only' });
      return res.status(200).json(await checkDelegation({ as: String(req.query?.as || '').trim() || undefined }));
    }

    // ── Test send. Goes to the CALLER's own address, never anywhere else. ──
    //
    // The address is taken from the session rather than the request, so this
    // cannot be pointed at a registrant even deliberately. Proving the pipe
    // should not be capable of reaching a customer.
    if (req.query?.test === '1') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
      if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'admin only' });

      // Defaults to the caller's own address, so the easy path is still the safe
      // one, but any address can be given — testing formatting against a
      // colleague or a webmail account is the normal case.
      const to = String(req.body?.to || session.email || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        return res.status(400).json({ error: 'A valid e-mail address is required.' });
      }

      const version = String(req.body?.version || '').trim();
      let template = null, attachments = [];
      if (version) {
        if (!isTemplateId(version)) return res.status(400).json({ error: 'unknown e-mail version' });
        template = await readTemplate(db, version);
        if (!templateIsSendable(template)) {
          return res.status(400).json({
            error: `The "${version}" template is empty or unwritten — nothing was sent.`,
          });
        }
        attachments = await loadAttachments(db, version);
      }

      const sent = await sendTestMessage(to, { version, db, template, attachments });
      return res.status(200).json({
        ...sent,
        version: version || null,
        attachmentsSent: attachments.map(a => a.filename),
        note: version
          ? `Test of the ${version} template sent to ${to}, with sample details in place of a real registration.`
          : `Diagnostic test message sent to ${to}.`,
      });
    }

    // ── Clear the e-mail history on ONE registration ───────────────────────
    //
    // Exists because a blank e-mail was sent in error on 2026-08-19 and left a
    // registration claiming a confirmation had gone out. That history is worse
    // than no history: the next person to look would believe the registrant had
    // been contacted properly.
    //
    // Clears ONLY the four e-mail-tracking fields. Everything else on the row —
    // fees, dates, the contact, the course — is untouched, and there is
    // deliberately no general-purpose edit here.
    if (req.query?.clear === 'email') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
      if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'admin only' });
      const id = String(req.query?.workshopId || '').trim();
      if (!id) return res.status(400).json({ error: 'workshopId required' });
      const before = await readWorkshop(db, id);
      if (!before) return res.status(404).json({ error: 'no such registration' });
      // undefined rather than '' — JSON.stringify drops undefined keys, so the
      // fields go away entirely rather than becoming empty strings that still
      // read as "something was recorded here".
      const after = await patchWorkshop(db, id, {
        confirmationSent: undefined, emailVersionSent: undefined,
        lastEmailTo: undefined, lastEmailBy: undefined,
      });
      return res.status(200).json({
        cleared: id,
        was: {
          confirmationSent: before.confirmationSent ?? null,
          emailVersionSent: before.emailVersionSent ?? null,
          lastEmailTo: before.lastEmailTo ?? null,
          lastEmailBy: before.lastEmailBy ?? null,
        },
        now: {
          confirmationSent: after.confirmationSent ?? null,
          emailVersionSent: after.emailVersionSent ?? null,
          lastEmailTo: after.lastEmailTo ?? null,
          lastEmailBy: after.lastEmailBy ?? null,
        },
        untouched: { fee: after.feeTotal ?? null, course: after.courseNumber, contact: after.contactName },
      });
    }

    // ── Templates ──────────────────────────────────────────────────────────
    if (req.query?.templates === '1') {
      if (req.method === 'GET') {
        return res.status(200).json({
          templates: await readTemplates(db),
          versions: TEMPLATES,
          from: senderAddress(),
        });
      }
      if (req.method === 'POST') {
        if (!(await isAdminEmail(session.email))) return res.status(403).json({ error: 'admin only' });
        const { id, subject, body, attachments } = req.body || {};
        if (!isTemplateId(id)) return res.status(400).json({ error: 'unknown template id' });
        return res.status(200).json({ template: await writeTemplate(db, id, { subject, body, attachments }, session.email) });
      }
      return res.status(405).json({ error: 'GET or POST' });
    }

    const workshopId = String(req.query?.workshopId || '').trim();
    if (!workshopId) return res.status(400).json({ error: 'workshopId required' });
    const version = String(req.query?.version || req.body?.version || '').trim();
    if (!isTemplateId(version)) return res.status(400).json({ error: 'unknown e-mail version' });

    const workshop = await readWorkshop(db, workshopId);
    if (!workshop) return res.status(404).json({ error: 'no such registration' });

    const tpl = await readTemplate(db, version);
    const recipient = await recipientFor(db, workshop, req);
    const catalogue = await catalogueForCourse(db, workshop.courseNumber);
    const vars = templateVars({ workshop, catalogue, recipient });

    // The attachments are whatever is filed against this template in Vibe's
    // file store — not a list of ids kept on the template, which could drift
    // from the files actually there.
    const files = tpl ? await templateFiles(db, version) : [];
    const renderedBody = tpl ? render(tpl.body, vars) : '';
    const rendered = tpl ? {
      subject: render(tpl.subject, vars),
      body: renderedBody,
      // The actual HTML that would be delivered, merge fields resolved. The
      // preview shows what arrives, not an approximation of it.
      html: renderEmailHtml(renderedBody, { footer: 'High 5 Adventure Learning Center · workshops@high5adventure.org' }),
      attachments: files.map(f => ({ fileId: f.fileId, name: f.name, size: f.size, mime: f.mime })),
    } : null;

    // ── Preview ────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      return res.status(200).json({
        workshopId, version, from: senderAddress(),
        recipient, rendered, vars,
        templateMissing: !tpl,
        // Distinct from missing on purpose. "Not written" and "written but
        // empty" look identical to a user and need different fixes, and
        // conflating them is what let a blank message go out.
        templateEmpty: !!tpl && !templateIsSendable(tpl),
        alreadySent: workshop.confirmationSent || null,
        lastVersion: workshop.emailVersionSent || null,
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

    // ── Send ───────────────────────────────────────────────────────────────
    // Checks CONTENT, not presence. `if (!tpl)` passed an empty template and a
    // blank e-mail reached a registrant — subject and body both empty — because
    // an object had been saved. Existing was never the property that mattered.
    if (!tpl) return res.status(400).json({ error: `The "${version}" template has not been written yet.` });
    if (!templateIsSendable(tpl)) {
      return res.status(400).json({
        error: `The "${version}" template is empty — it has no subject and no body. Nothing was sent.`,
      });
    }
    const to = String(req.body?.to || recipient?.address || '').trim();
    if (!to) return res.status(400).json({ error: 'no e-mail address for this registrant' });

    // Resolve the template's attachments to bytes HERE, on the server. An
    // earlier draft passed `req.body.attachments` straight through, which meant
    // a template could list attachments, the preview could show them, and the
    // message would go out with none — a silent omission is worse than an
    // obvious absence.
    const attachments = await loadAttachments(db, version);

    const sent = await sendAsWorkshops({
      to, replyTo: replyToAddress(),
      subject: rendered.subject, body: rendered.body,
      attachments,
    });

    // Record it on the registration, mirroring the two FileMaker fields so the
    // history stays continuous across the changeover.
    const updated = await patchWorkshop(db, workshopId, {
      emailVersionSent: version,
      confirmationSent: new Date().toISOString(),
      lastEmailTo: to,
      lastEmailBy: session.email,
    });

    return res.status(200).json({
      ...sent, version, workshop: updated,
      attachmentsSent: attachments.map(a => a.filename),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
