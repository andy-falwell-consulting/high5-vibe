// Training "Work Order" PDF — a one-page trainer-facing sheet, same pattern as
// ccsWorkOrder.js (mirrored here: name de-duplication, 'Work Order' title
// case, Vibe-sourced email/cell/phone, and a Training-type row). Client-side
// pdfmake.
import { trainingAttachments } from './trainingAttachments';
import { contactDetailsFor } from './contactLookup';

const fmtDateNoZero = v => {
  if (!v) return '';
  const [m, d, y] = String(v).split(' ')[0].split('/');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
};

const STAFF_FIELDS = ['Lead Trainer', 'Trainers', 'trainers2', 'trainers3', 'trainers4', 'trainers5', 'trainers6', 'trainers7', 'trainers8', 'trainers9'];

// Mirrors TRAINER_COSTS in Trainings.jsx — the same seven lines the Costs and
// Expenses tab shows, so what prints is exactly what was entered there.
const TRAINER_COST_LINES = [
  { label: 'Food',        est: 'Prog Food',        act: 'Act Prog Food' },
  { label: 'Lodging',     est: 'Prog Lodging',     act: 'Act Prog Lodging' },
  { label: 'Mileage',     est: 'Prog Mileage',     act: null },
  { label: 'Airfare',     est: 'Prog Airfare',     act: 'Act Prog Airfare' },
  { label: 'Car rental',  est: 'Prog Car Rental',  act: 'Act Prog Car Rental' },
  { label: 'Misc travel', est: 'Prog Misc Travel', act: 'Act Prog Misc Travel' },
];

export function workOrderMeta(record) {
  const f = record.fieldData || {};
  const id = f._kpt__TrainingProposal_ID || record.recordId || '';
  const org = f.zz__Display_Organization__ct || 'Training';
  return { id, org, filename: `Work Order ${org} ${id}.pdf` };
}

// Two names are "the same" for de-duplication if they match once case and
// punctuation are ignored, or if one is a prefix of the other — same rule
// ccsWorkOrder.js uses, for the identical reason: a billing address block
// often already opens with the organization and/or contact name.
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
  // Prepend org/contact only when the billing block doesn't already carry
  // them, so a record with a block that opens "Weston Public Schools..."
  // doesn't print the name twice.
  const blockHasOrg = addrLines.some(l => sameish(l, org));
  const blockHasContact = addrLines.some(l => sameish(l, contact));
  const addressStack = [
    ...(blockHasOrg ? [] : [org]),
    ...(blockHasContact ? [] : [contact]),
    ...addrLines,
  ].filter(Boolean);

  const trainingType = f['Type of Program'] || '';
  // Vibe's contact store first (see contactLookup.js — FileMaker's related
  // fields on trainings_New are largely empty, same problem CCS had), the
  // raw FileMaker related fields as fallback.
  const email = contactInfo?.email || '';
  const workPhone = contactInfo?.workPhone || f['trnpp_cntct_PHONE::Number'] || '';
  const cellPhone = contactInfo?.cellPhone || f['trnpp_cntct_PHONE_mobile::Number'] || '';
  const staff = STAFF_FIELDS.map(k => f[k]).filter(Boolean).join(', ');
  const start = fmtDateNoZero(f['Start Date']);
  const end = fmtDateNoZero(f['End Date']);
  const dates = start && end ? `${start} to ${end}` : (start || end || '');
  // 'Work Order' is a Vibe-only field (trainings_New is Vibe-owned, and
  // FileMaker has no such field) — mirrors CCS's own RCD_New 'Work Order'
  // field, which is likewise separate from its general 'Notes'.
  const notes = String(f['Work Order'] || '').replace(/\r/g, '\n');

  // Trainer costs, included only when the record says so.
  //
  // Off by default and per-record on purpose: the work order is handed to a
  // CLIENT for signature, and trainer food, lodging, mileage and airfare are
  // internal figures. Printing them on every sheet would disclose them by
  // accident; printing them on request is a deliberate act by whoever knows
  // this particular job.
  //
  // `include_trainer_costs` is Vibe-only — trainings_New has no such field and
  // is Vibe-owned, so it needs no FileMaker schema change.
  const includeTrainerCosts = String(f.include_trainer_costs || '') === '1';
  const money = v => {
    const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) && n !== 0 ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '';
  };
  // Actual where it exists, estimate otherwise — the sheet should carry the
  // best figure available, and a row with neither is omitted rather than
  // printed as a blank line.
  const trainerCostRows = !includeTrainerCosts ? [] : TRAINER_COST_LINES
    .map(({ label, est, act }) => {
      const value = money(act ? f[act] : '') || money(f[est]);
      return value ? { label, value, actual: !!(act && money(f[act])) } : null;
    })
    .filter(Boolean);
  const trainerCostTotal = trainerCostRows.reduce((n, r) =>
    n + Number(String(r.value).replace(/[^0-9.-]/g, '')), 0);

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

      row('Training', trainingType),
      row('Staff', staff),
      row('Dates', dates),

      ...(trainerCostRows.length ? [
        { text: 'Trainer costs', bold: true, fontSize: 10, fillColor: '#c9cfb8', margin: [0, 12, 0, 6] },
        {
          table: {
            widths: ['*', 70],
            body: [
              ...trainerCostRows.map(r => ([
                { text: r.label + (r.actual ? '' : ' (est.)'), fontSize: 10, border: [false, false, false, true], borderColor: ['#ffffff', '#ffffff', '#ffffff', '#dddddd'], margin: [0, 2, 0, 2] },
                { text: r.value, fontSize: 10, alignment: 'right', border: [false, false, false, true], borderColor: ['#ffffff', '#ffffff', '#ffffff', '#dddddd'], margin: [0, 2, 0, 2] },
              ])),
              [
                { text: 'Total', fontSize: 10, bold: true, border: [false, false, false, false], margin: [0, 3, 0, 0] },
                { text: trainerCostTotal.toLocaleString('en-US', { style: 'currency', currency: 'USD' }), fontSize: 10, bold: true, alignment: 'right', border: [false, false, false, false], margin: [0, 3, 0, 0] },
              ],
            ],
          },
          layout: { hLineWidth: () => 0.5, vLineWidth: () => 0, hLineColor: () => '#dddddd', paddingLeft: () => 0, paddingRight: () => 0 },
          margin: [0, 0, 0, 8],
        },
      ] : []),

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
  // rather than after them, so it costs no extra wall-clock — same as
  // ccsWorkOrder.js. firstEmail: true, since Trainings always reads the
  // person's own first email rather than CCS's type-preference pick.
  onStage?.('Reading contact…');
  const [pdfmakeMod, assets, contactInfo] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('../assets/reportAssets.js'),
    contactDetailsFor(record, { firstEmail: true }),
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

// Generate the work order PDF and attach it to the training record's
// photo/file table (Training_Pics, via the shared trainingAttachments pipeline).
export async function generateAndAttachWorkOrder(record, onStage) {
  onStage?.('Building PDF…');
  const { blob, filename } = await generateWorkOrderPdf(record, onStage);
  const file = new File([blob], filename, { type: 'application/pdf' });
  const trainingId = record.fieldData?._kpt__TrainingProposal_ID;
  onStage?.('Uploading…');
  return trainingAttachments.upload(trainingId, file, filename);
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
