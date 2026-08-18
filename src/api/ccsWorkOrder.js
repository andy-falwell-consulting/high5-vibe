// CCS "Work Order" PDF — a one-page site-visit sheet for the builder crew,
// matching the FileMaker "Work Order" report. Client-side pdfmake, same
// pattern as inspectionReport.js.
import { uploadCcsAttachment } from './ccsAttachments';
import { getContact } from './vibeContacts';
import { formatPhone } from '../../api/_phone';

// Phone and e-mail for the work order come from VIBE'S contact store, not from
// FileMaker's related fields on RCD_New.
//
// Those fields (rcd_cntct_PHONE__work::Number, rcd_cntct_PHONE__mobile::Number,
// rcd_cntct_INADR__email::zz__Address__ct) are on the layout and readable, but
// measured across all 6,436 CCS projects they are populated on ZERO of them —
// the relationships resolve empty over the Data API, the same way the CCS
// financial portals do. So every work order ever generated printed "—" for
// Phone, Cell and E-mail.
//
// Vibe holds the same contacts keyed by _kft__Contact_ID (populated on 958 of
// 1,000 projects) and fills at least one of the three for 115 of a 120-contact
// sample. Numbers are stored E.164 and formatted here for print.
//
// Type vocabularies match METHOD_SPEC in ContactsV2 — the values actually in
// the data, in preference order. A fax is never offered as a phone number.
const WORK_TYPES = ['Work', 'Main Office', 'Work Parent'];
const CELL_TYPES = ['Mobile', 'Personal Mobile', 'Mobile Parent'];
const MAIL_TYPES = ['Email', 'Home Email', 'Billing'];

const pickByType = (rows, types) => {
  for (const t of types) {
    const hit = (rows || []).find(r => String(r.type || '').toLowerCase() === t.toLowerCase());
    if (hit) return hit;
  }
  return null;
};

// The contact a work order is associated with, reduced to what the sheet prints.
// Returns empty strings rather than throwing: a missing or unreachable contact
// should still produce a work order, just without the contact block filled.
export async function workOrderContact(record) {
  const id = String(record?.fieldData?._kft__Contact_ID || '').trim();
  if (!id) return { workPhone: '', cellPhone: '', email: '' };
  try {
    const d = await getContact(id);
    const e = d?.person || d?.organization;
    if (!e) return { workPhone: '', cellPhone: '', email: '' };
    const w = pickByType(e.phones, WORK_TYPES);
    const c = pickByType(e.phones, CELL_TYPES);
    const m = pickByType(e.emails, MAIL_TYPES)
      || (e.emails || []).find(x => String(x.type || '') !== 'Web');
    return {
      workPhone: w ? formatPhone(w.number, w.ext) : '',
      cellPhone: c ? formatPhone(c.number, c.ext) : '',
      email: m?.address || '',
    };
  } catch {
    return { workPhone: '', cellPhone: '', email: '' };
  }
}

const fmtDateNoZero = v => {
  if (!v) return '';
  const [m, d, y] = String(v).split(' ')[0].split('/');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
};

export function workOrderMeta(record) {
  const f = record.fieldData || {};
  const id = f._kpt__RCD_ID || record.recordId || '';
  const org = f.zz__Display_Organization__ct || 'Project';
  return { id, org, filename: `Work Order ${org} ${id}.pdf` };
}

// Two names are "the same" for de-duplication if they match once case and
// punctuation are ignored, or if one is a prefix of the other. The prefix case
// is not hypothetical: one RPI project's billing block opens with "Rensselaer
// Polytechnic Institute " while the organization field reads "Rensselaer
// Polytechnic Institute RPI", so an exact comparison would print both.
const nameKey = v => String(v || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function sameish(a, b) {
  const x = nameKey(a), y = nameKey(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

export function buildWorkOrderDoc(record, logos, contactInfo) {
  const f = record.fieldData || {};
  const org = f.zz__Display_Organization__ct || '—';
  const contact = f.zz__Display_Contact__ct || '';
  const addrLines = String(f['Address_Block_Billing'] || '').split(/\r|\n/).map(s => s.trim()).filter(Boolean);
  // The billing block ALREADY opens with the organization and contact names,
  // so prepending them printed each one twice. They are still prepended when
  // the block does not carry them — 189 of 1,000 projects have no block at all,
  // and those would otherwise lose the name entirely.
  const blockHasOrg = addrLines.some(l => sameish(l, org));
  const blockHasContact = addrLines.some(l => sameish(l, contact));
  const addressStack = [
    ...(blockHasOrg ? [] : [org]),
    ...(blockHasContact ? [] : [contact]),
    ...addrLines,
  ].filter(Boolean);

  // The project's type(s), not its organization name — the organization is
  // already the first line of the address above. Type of Project is a 3-rep
  // field and a project can carry more than one.
  const projectTypes = [1, 2, 3].map(i => f[`Type of Project(${i})`]).filter(Boolean).join(' · ');
  // Vibe's values, with FileMaker's related fields left as the fallback. They
  // are empty on every record measured, so this is belt-and-braces rather than
  // a real second source — but it costs nothing and keeps the sheet working if
  // the contact lookup fails.
  const email = contactInfo?.email || f['rcd_cntct_INADR__email::zz__Address__ct'] || '';
  const workPhone = contactInfo?.workPhone || f['rcd_cntct_PHONE__work::Number'] || '';
  const cellPhone = contactInfo?.cellPhone || f['rcd_cntct_PHONE__mobile::Number'] || '';
  const staff = ['Lead Builder', 'Builder1', 'Builder2', 'Builder3'].map(k => f[k]).filter(Boolean).join(', ');
  const start = fmtDateNoZero(f['rcd start date']);
  const end = fmtDateNoZero(f['rcd end date']);
  const dates = start && end ? `${start} to ${end}` : (start || end || '');
  const notes = String(f['Work Order'] || '').replace(/\r/g, '\n');

  const row = (label, value) => ({
    columns: [{ width: 70, text: label, color: '#444444', fontSize: 10 }, { width: '*', text: value || '—', fontSize: 10, margin: [0, 0, 0, 5], border: [false, false, false, true] }],
    columnGap: 4, margin: [0, 0, 0, 4],
  });

  return {
    pageSize: 'LETTER',
    pageMargins: [54, 46, 54, 46],
    defaultStyle: { font: 'Liberation', fontSize: 10.5, lineHeight: 1.15 },
    content: [
      {
        columns: [
          { image: logos.header, width: 58 },
          { text: 'Work Order', fontSize: 22, alignment: 'right', margin: [0, 10, 0, 0] },
        ],
        margin: [0, 0, 0, 10],
      },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 486, y2: 0, lineWidth: 1.5 }], margin: [0, 0, 0, 14] },

      {
        columns: [
          {
            width: '*',
            stack: [
              { text: 'Address', color: '#444444', fontSize: 10, margin: [0, 0, 0, 3] },
              { text: addressStack.join('\n'), fontSize: 11, lineHeight: 1.3 },
            ],
          },
          {
            width: 180,
            stack: [
              row('Phone', workPhone),
              row('Cell', cellPhone),
              row('E-mail', email),
            ],
          },
        ],
        columnGap: 20, margin: [0, 0, 0, 16],
      },

      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 486, y2: 0, dash: { length: 3 }, lineWidth: 0.75, lineColor: '#999999' }], margin: [0, 0, 0, 14] },

      row('Project', projectTypes),
      row('Staff', staff),
      row('Dates', dates),

      { text: 'Notes', bold: true, fontSize: 10, fillColor: '#c9cfb8', margin: [0, 12, 0, 0] },
      { text: notes || ' ', fontSize: 10, margin: [0, 0, 0, 40], border: [true, false, true, true] },

      {
        columns: [
          { text: ["Customer's signature: ", { text: '_'.repeat(40), color: '#999999' }], fontSize: 10 },
          { text: ['Date: ', { text: '_'.repeat(20), color: '#999999' }], fontSize: 10 },
        ],
        margin: [0, 18, 0, 0],
      },
    ],
  };
}

async function generateWorkOrderPdf(record, onStage) {
  // The contact lookup runs alongside the (heavy) pdfmake and font imports
  // rather than after them, so it costs no extra wall-clock.
  onStage?.('Reading contact…');
  const [pdfmakeMod, assets, contactInfo] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('../assets/reportAssets.js'),
    workOrderContact(record),
  ]);
  const pdfMake = pdfmakeMod.default || pdfmakeMod;
  pdfMake.vfs = assets.reportFonts;
  pdfMake.fonts = {
    Liberation: {
      normal: 'LiberationSans-Regular.ttf', bold: 'LiberationSans-Bold.ttf',
      italics: 'LiberationSans-Italic.ttf', bolditalics: 'LiberationSans-BoldItalic.ttf',
    },
  };
  onStage?.('Building PDF…');
  const doc = buildWorkOrderDoc(record, assets.reportLogos, contactInfo);
  const { filename } = workOrderMeta(record);
  const blob = await new Promise((resolve, reject) => {
    try { pdfMake.createPdf(doc).getBlob(resolve); } catch (e) { reject(e); }
  });
  return { blob, filename };
}

// Generate the work order PDF and attach it to the CCS record's photo/file
// table (RCD_Pics, via the shared ccsAttachments pipeline).
export async function generateAndAttachWorkOrder(record, onStage) {
  onStage?.('Building PDF…');
  const { blob, filename } = await generateWorkOrderPdf(record, onStage);
  const file = new File([blob], filename, { type: 'application/pdf' });
  const rcdId = record.fieldData?._kpt__RCD_ID;
  onStage?.('Uploading…');
  return uploadCcsAttachment(rcdId, file, filename);
}

// Generate + download (no attach).
export async function downloadWorkOrder(record, onStage) {
  onStage?.('Building PDF…');
  const { blob, filename } = await generateWorkOrderPdf(record, onStage);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}
