// Inspection report PDF generator — matches the FileMaker "Print Report" output.
// pdfmake + bundled fonts/logos are lazy-loaded only when a report is generated.

const FOOTER = '130 Austine Drive  l  Brattleboro  l  VT  l  05301  l  (802) 254-8718  l  Fax (802) 251-7203';
const BOLD_PHRASES = ['THIS ELEMENT IS READY TO USE.', 'THIS ELEMENT SHOULD NOT BE USED UNTIL REPAIRS CAN BE MADE.'];

const fmtDateNoZero = v => {
  if (!v) return '';
  const [m, d, y] = String(v).split(' ')[0].split('/');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
};
const todayLong = () => {
  const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const t = new Date();
  return `${M[t.getMonth()]} ${t.getDate()}, ${t.getFullYear()}`;
};
function descRuns(text) {
  let runs = [{ text: String(text || '').replace(/\r/g, '\n'), bold: false }];
  for (const p of BOLD_PHRASES) {
    const next = [];
    for (const run of runs) {
      if (run.bold) { next.push(run); continue; }
      const parts = run.text.split(p);
      parts.forEach((part, i) => {
        if (part) next.push({ text: part, bold: false });
        if (i < parts.length - 1) next.push({ text: p, bold: true });
      });
    }
    runs = next;
  }
  return runs.length ? runs : [{ text: '' }];
}

export function inspectionMeta(record) {
  const f = record.fieldData || {};
  const id = f._kpt__Inspection_ID || '';
  const site = f['inspt_CNTCT__site::Name_Organization'] || f.Organization || 'Inspection';
  return { id, site, filename: `Inspection Report ${id}.pdf` };
}

export function buildInspectionDoc(record, logos) {
  const f = record.fieldData || {};
  const li = (record.portalData && record.portalData['inspt_INSPLI']) || [];
  const site = f['inspt_CNTCT__site::Name_Organization'] || f.Organization || '';
  const courseDate = fmtDateNoZero(f.Date);
  const inspector = f['Inspectors Name'] || '';
  const indiv = (f['inspt_CNTCT::NameFirstLast'] || '').replace(/\s+/g, ' ').trim();
  const firstName = indiv.split(' ')[0] || indiv;
  const addrLines = String(f['Address_Block_Billing'] || '').split(/\r|\n/).map(s => s.trim()).filter(Boolean);
  const nameNorm = indiv.toLowerCase();
  const recip = [indiv, ...addrLines.filter(l => l.replace(/\s+/g, ' ').trim().toLowerCase() !== nameNorm)].filter(Boolean);

  const order = []; const groups = {};
  li.forEach(r => {
    const c = r['inspt_INSPLI::Category'] || '';
    if (!groups[c]) { groups[c] = []; order.push(c); }
    groups[c].push(r);
  });

  const content = [];

  // ── Cover ──
  content.push(
    { image: logos.cover, width: 175, alignment: 'center', margin: [0, 30, 0, 26] },
    { text: 'Inspection Report for', fontSize: 26, alignment: 'center', margin: [0, 6, 0, 22] },
    { text: site, fontSize: 26, alignment: 'center', margin: [0, 0, 0, 150] },
    { text: 'Performed On ' + courseDate, fontSize: 15, alignment: 'center', margin: [0, 0, 0, 8] },
    { text: 'By ' + inspector, fontSize: 15, alignment: 'center', pageBreak: 'after' },
  );

  // ── Cover letter ──
  const grade = (label, body) => ({
    columns: [{ width: 34, text: `"${label}"`, bold: true }, { width: '*', text: body }],
    columnGap: 6, margin: [36, 0, 0, 6],
  });
  const gradeBold = (label, pre, bold, post) => ({
    columns: [{ width: 34, text: `"${label}"`, bold: true }, { width: '*', text: [pre, { text: bold, bold: true }, post] }],
    columnGap: 6, margin: [36, 0, 0, 6],
  });
  content.push(
    { columns: [{ image: logos.header, width: 58 }, { text: todayLong(), alignment: 'right', margin: [0, 22, 0, 0] }], margin: [0, 6, 0, 16] },
    { text: recip.join('\n'), margin: [0, 6, 0, 22], lineHeight: 1.15 },
    { text: `Dear ${firstName},`, margin: [0, 0, 0, 14] },
    { text: `I would like to start out by saying thank you for the opportunity to assist you with the upkeep of your Adventure Ropes Course.  The following pages detail the information I gathered during the inspection of your course on ${courseDate}.  The report is broken down into sections that detail History, Equipment, Low Element, and High Element.`, margin: [0, 0, 0, 12] },
    { text: 'During the inspection I reviewed the physical environment of the course, the condition and quality of the materials that make up the course, as well as the design and manner in which the materials are used.  This inspection is a thorough tactile inspection.', margin: [0, 0, 0, 12] },
    { text: 'The elements have been reviewed in accordance to applicable industry standards as well as those of  High 5.  High 5 uses a five step numeric grading system to allow for the most accurate description of the condition of your elements.  The grades are broken down as follows.', margin: [0, 0, 0, 2] },
    { text: '.', margin: [0, 0, 0, 6] },
    grade('5', 'This grade is used when an element or equipment meets all of the standards with which High 5 uses to inspect.  There are no recommendations.  The element is perfect.'),
    grade('4', 'This grade is used when an element or equipment meets all industry standards. This element is ready to use.  Notes on this element may detail construction styles that are outdated or don’t meet current High 5 installation standards.'),
    grade('3', 'This grade is used when an element or equipment meets all industry standards but will need some attention in the near future.  The element is ready to use. Notes on these elements often detail tree growth encroaching on cable connections or that some part of the element is seeing normal wear.'),
    gradeBold('2', 'This grade is used when an element or equipment does not meet standards ', 'THIS ELEMENT SHOULD NOT BE USED UNTIL REPAIRS CAN BE MADE.', ' Notes on these elements generally detail minor to medium size repairs.'),
    gradeBold('1', 'This grade is used when an element or equipment does not meet standards. ', 'THIS ELEMENT SHOULD NOT BE USED UNTIL REPAIRS CAN BE MADE.', ' Notes on these elements generally detail major repairs, rebuilds, or redesigns.'),
    grade('NI', 'This grade is used when an element or equipment is not inspected.  Notes detail the reasons why.'),
    { text: 'The "Ready to use" label is based on the condition of the course during the inspection.  It is imperative that staff using the equipment and elements be diligent in verifying the continued proper working condition of the course with each use.   Frequent detailed inspection of your equipment and elements should also be performed and documented by the staff.  Any irregularities in condition or appearance should be checked out with a professional in the industry.', margin: [0, 18, 0, 12], pageBreak: 'before' },
    { text: '"Ready to use" does not imply that the element will be used correctly.  The skill level of the staff and their knowledge of the course operation is the most critical part of a program.  Skill and knowledge come from proper training and experience.  I strongly recommend you coordinate and document staff training to assure that staff stay up to date with the current standards in the industry.', margin: [0, 0, 0, 12] },
    { text: ['The Standard Operating Procedures (SOP) for these elements can be found in the ', { text: 'High 5 Guide 2nd Edition', italics: true }, '. Please review the procedures for each element. I also strongly recommend you take advantage of our on-line SOP templets to write your Local Operating Procedures (LOP). Information about an LOP manual can be found on page 17 of the guide. The web address for the templets is www.high5adventure.org/lops.'], margin: [0, 0, 0, 12] },
    { text: 'If repairs are required or recommended for any part of your course, and those repairs are performed by anyone other than a High 5 staff member, High 5 can not verify the condition of the element or equipment without a follow up inspection visit.', margin: [0, 0, 0, 12] },
    { text: 'It was a pleasure to visit your site.  Enjoy your course and continue to work safely.', margin: [0, 0, 0, 12] },
    { text: 'Thanks again,', margin: [0, 0, 0, 36] },
    { text: inspector },
    { text: 'Challenge Course Services' },
  );

  // ── Sections ──
  order.forEach(cat => {
    const rows = groups[cat];
    const title = cat;

    if (cat === 'History') {
      content.push(
        { text: title, fontSize: 22, alignment: 'center', margin: [0, 6, 0, 30], pageBreak: 'before' },
        ...rows.map((r, i) => ({ text: descRuns(r['inspt_INSPLI::Description']), margin: [44, i === 0 ? 64 : 0, 0, 10] })),
      );
      return;
    }

    const hasQty = cat === 'Equipment';
    const widths = hasQty ? [60, 44, 56, '*'] : [60, 44, '*'];
    const titleCell = { text: title, fontSize: 22, alignment: 'center', colSpan: widths.length, margin: [0, 4, 0, 24] };
    const titleRow = [titleCell, ...Array(widths.length - 1).fill({})];
    const headRow = hasQty
      ? [{}, { text: 'Grade', bold: true, fontSize: 11 }, { text: 'Quantity', bold: true, fontSize: 11, alignment: 'center' }, { text: 'Description', bold: true, fontSize: 11 }]
      : [{}, { text: 'Grade', bold: true, fontSize: 11 }, { text: 'Description', bold: true, fontSize: 11 }];
    const body = [titleRow, headRow];
    rows.forEach(r => {
      const g = r['inspt_INSPLI::Element_Grade'] || '';
      const desc = { text: descRuns(r['inspt_INSPLI::Description']), fontSize: 10, lineHeight: 1.04 };
      if (hasQty) body.push([{}, { text: g, alignment: 'center', fontSize: 10 }, { text: String(r['inspt_INSPLI::Quantity'] ?? ''), alignment: 'center', fontSize: 10 }, desc]);
      else body.push([{}, { text: g, alignment: 'center', fontSize: 10 }, desc]);
    });
    content.push({
      pageBreak: 'before',
      table: { headerRows: 2, dontBreakRows: true, widths, body },
      layout: { defaultBorder: false, paddingTop: i => i < 2 ? 0 : 3, paddingBottom: i => i < 2 ? 4 : 3, paddingLeft: () => 0, paddingRight: () => 8 },
    });
  });

  return {
    pageSize: 'LETTER',
    pageMargins: [72, 46, 72, 54],
    defaultStyle: { font: 'Liberation', fontSize: 10.5, lineHeight: 1.12 },
    header: currentPage => currentPage >= 4 ? { image: logos.header, width: 58, margin: [72, 26, 0, 0] } : undefined,
    footer: () => ({ text: FOOTER, alignment: 'center', fontSize: 9, color: '#8a8a8a', margin: [0, 14, 0, 0] }),
    content,
  };
}

// Lazy-load pdfmake + assets, return { blob, filename }
export async function generateInspectionReport(record) {
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
  const doc = buildInspectionDoc(record, assets.reportLogos);
  const { filename } = inspectionMeta(record);
  const blob = await new Promise((resolve, reject) => {
    try { pdfMake.createPdf(doc).getBlob(resolve); } catch (e) { reject(e); }
  });
  return { blob, filename };
}
