// CCS "Work Order" PDF — a one-page site-visit sheet for the builder crew,
// matching the FileMaker "Work Order" report. Client-side pdfmake, same
// pattern as inspectionReport.js.
import { uploadCcsAttachment } from './ccsAttachments';

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

export function buildWorkOrderDoc(record, logos) {
  const f = record.fieldData || {};
  const org = f.zz__Display_Organization__ct || '—';
  const contact = f.zz__Display_Contact__ct || '';
  const addrLines = String(f['Address_Block_Billing'] || '').split(/\r|\n/).map(s => s.trim()).filter(Boolean);
  const email = f['rcd_cntct_INADR__email::zz__Address__ct'] || '';
  const workPhone = f['rcd_cntct_PHONE__work::Number'] || '';
  const cellPhone = f['rcd_cntct_PHONE__mobile::Number'] || '';
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
          { text: 'Work order', fontSize: 22, alignment: 'right', margin: [0, 10, 0, 0] },
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
              { text: [org, contact, ...addrLines].filter(Boolean).join('\n'), fontSize: 11, lineHeight: 1.3 },
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

      row('Project', org),
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

async function generateWorkOrderPdf(record) {
  const [pdfmakeMod, assets] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('../assets/reportAssets.js'),
  ]);
  const pdfMake = pdfmakeMod.default || pdfmakeMod;
  pdfMake.vfs = assets.reportFonts;
  pdfMake.fonts = {
    Liberation: {
      normal: 'LiberationSans-Regular.ttf', bold: 'LiberationSans-Bold.ttf',
      italics: 'LiberationSans-Italic.ttf', bolditalics: 'LiberationSans-BoldItalic.ttf',
    },
  };
  const doc = buildWorkOrderDoc(record, assets.reportLogos);
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
  const { blob, filename } = await generateWorkOrderPdf(record);
  const file = new File([blob], filename, { type: 'application/pdf' });
  const rcdId = record.fieldData?._kpt__RCD_ID;
  onStage?.('Uploading…');
  return uploadCcsAttachment(rcdId, file, filename);
}

// Generate + download (no attach).
export async function downloadWorkOrder(record, onStage) {
  onStage?.('Building PDF…');
  const { blob, filename } = await generateWorkOrderPdf(record);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}
