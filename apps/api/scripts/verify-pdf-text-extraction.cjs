/* Image-build and test gate for Core's two PDF text readers.
 *
 * unpdf (Meri attachments, funding documents) bundles pdf.js with no native
 * module. pdf-parse (engagement attachments, Florida calendars) requires
 * @napi-rs/canvas when its pdf.js module loads and only WARNS when that native
 * binding fails, so a broken binding would otherwise ship silently. Both must
 * read the fixture with no pdf.js warning at all.
 *
 * pdf-parse runs first on purpose: pdf.js 5 adopts whichever worker is already
 * registered on globalThis, and unpdf's pdf.js 6 registers one on first use,
 * so the reverse order fails with an API/Worker version mismatch.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const warnings = [];
console.warn = (...args) => warnings.push(args.join(' '));
const bytes = fs.readFileSync(path.join(__dirname, '__fixtures__', 'HRPT-119-NDAA-sample.pdf'));
const expected = 'NATIONAL DEFENSE AUTHORIZATION ACT FY2027 (SAMPLE)';
const normalize = (text) => text.replace(/\s+/g, ' ');

async function main() {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: bytes });
  try {
    assert(normalize((await parser.getText()).text).includes(expected), 'pdf-parse did not read the fixture');
  } finally {
    await parser.destroy();
  }

  const { getDocumentProxy } = require('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const content = await (await pdf.getPage(1)).getTextContent();
    assert(normalize(content.items.map((item) => item.str).join(' ')).includes(expected), 'unpdf did not read the fixture');
  } finally {
    await pdf.loadingTask.destroy();
  }

  assert.deepEqual(warnings, [], 'pdf.js warned while loading or reading');
  console.log('pdf text extraction ok: pdf-parse and unpdf read the fixture with no pdf.js warnings');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
