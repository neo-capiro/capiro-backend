// Generates the synthetic acceptance documents for the files family (cases
// 40-46). Every document is labeled synthetic; they are uploaded only into
// conversations on the QA test client.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire('C:/dev/main/meri-c1-20261002/apps/api/package.json');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const PptxGenJS = require('pptxgenjs');
const ExcelJS = require('exceljs');
const out = process.argv[2] ?? 'C:/dev/main/outputs/meri-simple-20261005/files';
mkdirSync(out, { recursive: true });

async function pdf(name, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [index, lines] of pages.entries()) {
    const page = doc.addPage([612, 792]);
    page.drawText(`SYNTHETIC QA DOCUMENT - page ${index + 1}`, { x: 50, y: 740, size: 10, font });
    lines.forEach((line, i) => page.drawText(line, { x: 50, y: 700 - i * 18, size: 12, font }));
  }
  writeFileSync(`${out}/${name}`, await doc.save());
}

// Case 40: the capability is stated on page 4 only.
await pdf('qa-capability-profile.pdf', [
  ['ZZ-QA capability profile (synthetic).', 'Company overview and history.'],
  ['Facilities: two synthetic test sites.'],
  ['Past performance: synthetic contracts only.'],
  ['Capability: unmanned maritime sensors for littoral surveillance.', 'Deployed on small surface vessels.'],
  ['Points of contact: synthetic.'],
  ['End of synthetic document.'],
]);

// Case 45: three recommendations spread across an 80-page report.
const recommendations = { 5: 'Recommendation 1: consolidate test range scheduling.',
  40: 'Recommendation 2: fund the sensor calibration backlog.', 78: 'Recommendation 3: brief the program office quarterly.' };
await pdf('qa-annual-report-80p.pdf', Array.from({ length: 80 }, (_, i) =>
  recommendations[i + 1] ? [`Section ${i + 1}.`, recommendations[i + 1]] : [`Section ${i + 1}.`, 'Narrative text with no recommendation.']));

// Case 41: slide 6 text differs from its speaker notes.
const deck = new PptxGenJS();
for (let n = 1; n <= 7; n += 1) {
  const slide = deck.addSlide();
  slide.addText(n === 6 ? 'Autonomy evaluation' : `Strategy slide ${n}`, { x: 0.5, y: 0.4, w: 9, h: 1, fontSize: 28 });
  slide.addText(n === 6 ? 'Evaluate autonomy maturity across three synthetic test events.' : 'Synthetic strategy content.', { x: 0.5, y: 1.6, w: 9, h: 1, fontSize: 16 });
  if (n === 6) slide.addNotes('Speaker notes: demo risk - the integration schedule may slip.');
}
await deck.writeFile({ fileName: `${out}/qa-strategy-deck.pptx` });

// Case 42: the total of the cost column is 7.50.
const book = new ExcelJS.Workbook();
const sheet = book.addWorksheet('Costs');
sheet.addRow(['Item', 'Cost ($M)']);
[['Sensors', 1.25], ['Integration', 2.5], ['Testing', 3.75]].forEach((r) => sheet.addRow(r));
await book.xlsx.writeFile(`${out}/qa-cost-sheet.xlsx`);

// Case 46: the briefing to export.
writeFileSync(`${out}/qa-briefing.txt`, 'Synthetic QA briefing v1\nThis briefing is synthetic test content for the ZZ-QA client.\n');
console.log('written', out);
