import { getGoogleSession } from './_googleSession.js';
import { ALLOWED_DBS } from './_fmp.js';
import { isAdminEmail } from './_admin.js';
import { readWorkshop, patchWorkshop } from './_oeTraining.js';
import {
  TEMPLATES, isTemplateId, readTemplate, readTemplates, writeTemplate,
  pickEmail, render, templateVars, sendAsWorkshops, senderAddress, catalogueForCourse,
  templateFiles, loadAttachments, checkDelegation, replyToAddress,
} from './_workshopEmail.js';

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
      return res.status(200).json(await checkDelegation());
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
    const rendered = tpl ? {
      subject: render(tpl.subject, vars),
      body: render(tpl.body, vars),
      attachments: files.map(f => ({ fileId: f.fileId, name: f.name, size: f.size, mime: f.mime })),
    } : null;

    // ── Preview ────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      return res.status(200).json({
        workshopId, version, from: senderAddress(),
        recipient, rendered, vars,
        templateMissing: !tpl,
        alreadySent: workshop.confirmationSent || null,
        lastVersion: workshop.emailVersionSent || null,
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

    // ── Send ───────────────────────────────────────────────────────────────
    if (!tpl) return res.status(400).json({ error: `The "${version}" template has not been written yet.` });
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
