import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const { PDFDocument, StandardFonts, rgb } = apiRequire('pdf-lib');
const ExcelJS = apiRequire('exceljs');
const PptxGenJSImport = apiRequire('pptxgenjs');
const JSZip = apiRequire('jszip');
const PptxGenJS = PptxGenJSImport.default ?? PptxGenJSImport;

export const FROZEN_INSTANT = '2026-09-26T16:00:00.000Z';
const FROZEN_DATE = new Date(FROZEN_INSTANT);
const FIXTURE_VERSION = 'meri-live-v1-2026-09-26.1';
const PDF_TEXT = 'Develops unmanned maritime sensors';
const SLIDE_TEXT = 'Autonomy evaluation';
const SLIDE_NOTES = 'demo risk';
const ROW_A = 6178000;
const ROW_B = 2811000;
const TOTAL = 8989000;
const RECOMMENDATIONS = ['Synthetic recommendation Alpha', 'Synthetic recommendation Beta'];

const GENERATED_FILES = Object.freeze([
  'D-A-1.pdf',
  'DECK-A-1.pptx',
  'SHEET-A-1.xlsx',
  'FILE-B-1-restricted.pdf',
  'PDF-PENDING-1.pdf',
  'REPORT-A-v1.pdf',
  'REPORT-A-v2.pdf',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertFrozenFixtureMapping() {
  const { frozenFixture, FIXTURE_VERSION: actualVersion } = await import('../fixture.mjs');
  invariant(actualVersion === FIXTURE_VERSION, 'fixture version drifted');
  invariant(frozenFixture.clock.instant === FROZEN_INSTANT, 'fixture clock drifted');

  const sources = frozenFixture.sources;
  invariant(sources['D-A-1'].tenantId === 'T1' && sources['D-A-1'].clientId === 'ASTER', 'D-A-1 scope drifted');
  invariant(sources['D-A-1'].facts.page === 4 && sources['D-A-1'].facts.passage === PDF_TEXT, 'D-A-1 facts drifted');
  invariant(sources['DECK-A-1'].facts.slide === 6 && sources['DECK-A-1'].facts.slideText === SLIDE_TEXT, 'DECK-A-1 slide drifted');
  invariant(sources['DECK-A-1'].facts.speakerNotes === SLIDE_NOTES, 'DECK-A-1 notes drifted');
  invariant(JSON.stringify(sources['SHEET-A-1'].facts.cells) === JSON.stringify([ROW_A, ROW_B]), 'SHEET-A-1 cells drifted');
  invariant(sources['SHEET-A-1'].facts.total === TOTAL, 'SHEET-A-1 total drifted');
  invariant(sources['FILE-B-1'].tenantId === 'T1' && sources['FILE-B-1'].clientId === 'BLUEHAVEN', 'FILE-B-1 scope drifted');
  invariant(sources['PDF-PENDING-1'].facts.extraction === 'pending' && sources['PDF-PENDING-1'].facts.metadataOnly === true, 'PDF-PENDING-1 state drifted');
  invariant(sources['REPORT-A-v1'].facts.version === 'v1' && sources['REPORT-A-v1'].facts.current === false && sources['REPORT-A-v1'].facts.pages === 80, 'REPORT-A-v1 facts drifted');
  invariant(sources['REPORT-A-v2'].facts.version === 'v2' && sources['REPORT-A-v2'].facts.current === true && sources['REPORT-A-v2'].facts.pages === 80, 'REPORT-A-v2 facts drifted');
  invariant(JSON.stringify(sources['REPORT-A-v2'].facts.recommendations) === JSON.stringify(RECOMMENDATIONS), 'REPORT-A-v2 recommendations drifted');
}

async function makePdf({ title, pages }) {
  const document = await PDFDocument.create();
  document.setTitle(title);
  document.setAuthor('Meri synthetic fixture generator');
  document.setSubject('Synthetic Appendix F source binary');
  document.setKeywords(['synthetic', 'fixture', 'Appendix F']);
  document.setProducer('pdf-lib 1.17.1 deterministic fixture');
  document.setCreator('Meri source-binaries/generator.mjs');
  document.setCreationDate(FROZEN_DATE);
  document.setModificationDate(FROZEN_DATE);
  const font = await document.embedFont(StandardFonts.Helvetica);

  for (const lines of pages) {
    const page = document.addPage([612, 792]);
    let y = 730;
    for (const line of lines) {
      page.drawText(line, { x: 54, y, size: 12, font, color: rgb(0, 0, 0) });
      y -= 24;
    }
  }

  return Buffer.from(await document.save({
    addDefaultPage: false,
    objectsPerTick: Number.POSITIVE_INFINITY,
    useObjectStreams: false,
    updateFieldAppearances: false,
  }));
}

function reportPages(version) {
  return Array.from({ length: 80 }, (_, index) => {
    const page = index + 1;
    const lines = [`Synthetic report scope - REPORT-A-${version} - page ${page} of 80`];
    if (version === 'v2' && page === 4) lines.push(RECOMMENDATIONS[0]);
    if (version === 'v2' && page === 79) lines.push(RECOMMENDATIONS[1]);
    return lines;
  });
}

async function canonicalizeOoxml(bytes) {
  const input = await JSZip.loadAsync(bytes);
  const output = new JSZip();
  for (const name of Object.keys(input.files).sort((left, right) => left.localeCompare(right))) {
    const entry = input.files[name];
    if (entry.dir) {
      output.file(name, Buffer.alloc(0), { createFolders: false, date: FROZEN_DATE, dir: true });
      continue;
    }
    let content = await entry.async('nodebuffer');
    if (name === 'docProps/core.xml') {
      const xml = content.toString('utf8')
        .replace(/<dcterms:created([^>]*)>[^<]*<\/dcterms:created>/g, `<dcterms:created$1>${FROZEN_INSTANT}</dcterms:created>`)
        .replace(/<dcterms:modified([^>]*)>[^<]*<\/dcterms:modified>/g, `<dcterms:modified$1>${FROZEN_INSTANT}</dcterms:modified>`);
      content = Buffer.from(xml, 'utf8');
    }
    output.file(name, content, {
      binary: true,
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
      createFolders: false,
      date: FROZEN_DATE,
    });
  }
  return output.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'DOS',
    streamFiles: false,
  });
}

async function makeDeck() {
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  deck.author = 'Meri synthetic fixture generator';
  deck.company = 'Synthetic fixture only';
  deck.subject = 'Appendix F DECK-A-1';
  deck.title = 'Synthetic Aster strategy deck';
  deck.lang = 'en-US';
  deck.comments = 'Generated deterministically at the frozen fixture clock.';

  for (let number = 1; number <= 6; number += 1) {
    const slide = deck.addSlide();
    const text = number === 6 ? SLIDE_TEXT : `Synthetic strategy deck scope - slide ${number} of 6`;
    slide.addText(text, {
      x: 0.8,
      y: 1.0,
      w: 11.7,
      h: 1.0,
      fontFace: 'Arial',
      fontSize: 24,
      color: '000000',
      margin: 0,
    });
    if (number === 6) slide.addNotes(SLIDE_NOTES);
  }

  const raw = await deck.write({ outputType: 'nodebuffer' });
  return canonicalizeOoxml(Buffer.from(raw));
}

async function makeWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Meri synthetic fixture generator';
  workbook.lastModifiedBy = 'Meri synthetic fixture generator';
  workbook.created = FROZEN_DATE;
  workbook.modified = FROZEN_DATE;
  workbook.lastPrinted = FROZEN_DATE;
  workbook.calcProperties.fullCalcOnLoad = false;
  workbook.calcProperties.forceFullCalc = false;
  const sheet = workbook.addWorksheet('Budget');
  sheet.getCell('A1').value = 'Synthetic cost category';
  sheet.getCell('B1').value = 'Amount';
  sheet.getCell('A2').value = 'cost-category-a';
  sheet.getCell('B2').value = ROW_A;
  sheet.getCell('A3').value = 'cost-category-b';
  sheet.getCell('B3').value = ROW_B;
  sheet.getCell('A4').value = 'Total (saved formula result; not recalculated)';
  sheet.getCell('B4').value = { formula: 'SUM(B2:B3)', result: TOTAL };
  const raw = Buffer.from(await workbook.xlsx.writeBuffer());
  return canonicalizeOoxml(raw);
}

function definition(logicalSourceId, values) {
  return {
    logicalSourceId,
    fixtureMapping: {
      fixturePath: '../fixture.mjs',
      fixtureVersion: FIXTURE_VERSION,
      sourceId: logicalSourceId,
    },
    tenantId: 'T1',
    accessAttestation: 'none',
    ...values,
  };
}

function manifestDefinitions() {
  return [
    definition('D-A-1', {
      caseIds: ['40', '43'], clientId: 'ASTER', classification: 'synthetic-client-confidential', version: 'v1',
      fixtureLifecycle: 'defined', logicalBindingAuthority: 'manifest-only-until-canonical-api-loader',
      filename: 'D-A-1.pdf', mediaType: 'application/pdf',
      expectedLocations: [{ kind: 'pdf-page-text', page: 4, text: PDF_TEXT }],
    }),
    definition('DECK-A-1', {
      caseIds: ['41'], clientId: 'ASTER', classification: 'synthetic-client-confidential', version: 'v1',
      fixtureLifecycle: 'defined', logicalBindingAuthority: 'manifest-only-until-canonical-api-loader',
      filename: 'DECK-A-1.pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      expectedLocations: [
        { kind: 'pptx-slide-text', slide: 6, text: SLIDE_TEXT },
        { kind: 'pptx-speaker-notes', slide: 6, text: SLIDE_NOTES },
      ],
    }),
    definition('SHEET-A-1', {
      caseIds: ['42'], clientId: 'ASTER', classification: 'synthetic-client-confidential', version: 'v1',
      fixtureLifecycle: 'defined', logicalBindingAuthority: 'manifest-only-until-canonical-api-loader',
      filename: 'SHEET-A-1.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      expectedLocations: [
        { kind: 'xlsx-cell', worksheet: 'Budget', cell: 'B2', value: ROW_A },
        { kind: 'xlsx-cell', worksheet: 'Budget', cell: 'B3', value: ROW_B },
        { kind: 'xlsx-formula-cell', worksheet: 'Budget', cell: 'B4', formula: 'SUM(B2:B3)', savedResult: TOTAL, disclosure: 'saved formula result; not recalculated' },
      ],
    }),
    definition('FILE-B-1', {
      caseIds: ['43'], clientId: 'BLUEHAVEN', classification: 'synthetic-restricted-client', version: 'v1',
      fixtureLifecycle: 'defined', logicalBindingAuthority: 'manifest-only-until-canonical-api-loader',
      filename: 'FILE-B-1-restricted.pdf', mediaType: 'application/pdf',
      expectedLocations: [{ kind: 'separate-restricted-binary-asset' }],
    }),
    definition('PDF-PENDING-1', {
      caseIds: ['44'], clientId: 'ASTER', classification: 'synthetic-client-confidential', version: 'v1',
      fixtureLifecycle: 'defined', logicalBindingAuthority: 'manifest-only-until-canonical-api-loader',
      filename: 'PDF-PENDING-1.pdf', mediaType: 'application/pdf', extractionState: 'pending', metadataOnly: true,
      expectedLocations: [],
    }),
    definition('REPORT-A-v1', {
      caseIds: ['45'], clientId: 'ASTER', classification: 'synthetic-client-confidential', version: 'v1',
      fixtureLifecycle: 'superseded', supersededBy: 'REPORT-A-v2', current: false,
      logicalBindingAuthority: 'manifest-only-until-canonical-api-loader',
      filename: 'REPORT-A-v1.pdf', mediaType: 'application/pdf',
      expectedLocations: [{ kind: 'pdf-page-count', pages: 80 }],
    }),
    definition('REPORT-A-v2', {
      caseIds: ['45'], clientId: 'ASTER', classification: 'synthetic-client-confidential', version: 'v2',
      fixtureLifecycle: 'current', current: true, initialRead: 'paginated/truncated',
      logicalBindingAuthority: 'manifest-only-until-canonical-api-loader',
      filename: 'REPORT-A-v2.pdf', mediaType: 'application/pdf',
      expectedLocations: [
        { kind: 'pdf-page-count', pages: 80 },
        { kind: 'pdf-page-text', page: 4, logicalOrder: 1, text: RECOMMENDATIONS[0] },
        { kind: 'pdf-page-text', page: 79, logicalOrder: 2, text: RECOMMENDATIONS[1] },
      ],
    }),
  ];
}

async function buildBytes() {
  return new Map([
    ['D-A-1.pdf', await makePdf({
      title: 'D-A-1 synthetic Aster capability fixture',
      pages: Array.from({ length: 4 }, (_, index) => {
        const page = index + 1;
        const lines = [`Synthetic Aster PDF scope - page ${page} of 4`];
        if (page === 4) lines.push(PDF_TEXT);
        return lines;
      }),
    })],
    ['DECK-A-1.pptx', await makeDeck()],
    ['SHEET-A-1.xlsx', await makeWorkbook()],
    ['FILE-B-1-restricted.pdf', await makePdf({
      title: 'FILE-B-1 restricted synthetic Bluehaven fixture',
      pages: [['Synthetic Bluehaven restricted scope - separate fixture asset']],
    })],
    ['PDF-PENDING-1.pdf', await makePdf({
      title: 'PDF-PENDING-1 synthetic pending extraction fixture',
      pages: [['Synthetic pending PDF scope - valid bytes awaiting extraction']],
    })],
    ['REPORT-A-v1.pdf', await makePdf({ title: 'REPORT-A-v1 superseded synthetic report', pages: reportPages('v1') })],
    ['REPORT-A-v2.pdf', await makePdf({ title: 'REPORT-A-v2 current synthetic report', pages: reportPages('v2') })],
  ]);
}

export function verifyAssetBytes(entry, bytes, requestedLogicalSourceId = entry.logicalSourceId) {
  invariant(requestedLogicalSourceId === entry.logicalSourceId, `logical source mismatch: requested ${requestedLogicalSourceId}, received ${entry.logicalSourceId}`);
  invariant(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'asset bytes are required');
  const value = Buffer.from(bytes);
  invariant(value.length === entry.byteSize, `byte size mismatch for ${entry.logicalSourceId}`);
  invariant(sha256(value) === entry.byteSha256, `byte hash mismatch for ${entry.logicalSourceId}`);
  if (entry.mediaType === 'application/pdf') invariant(value.subarray(0, 5).toString('ascii') === '%PDF-', `malformed PDF bytes for ${entry.logicalSourceId}`);
  else invariant(value[0] === 0x50 && value[1] === 0x4b, `malformed OOXML bytes for ${entry.logicalSourceId}`);
  return true;
}

export async function buildSourceBinaries(outputDirectory) {
  invariant(typeof outputDirectory === 'string' && outputDirectory.trim() !== '', 'an explicit output directory is required');
  const output = resolve(outputDirectory);
  await assertFrozenFixtureMapping();
  await mkdir(output, { recursive: true });
  invariant((await stat(output)).isDirectory(), 'output path must be a directory');

  const binaries = await buildBytes();
  invariant(JSON.stringify([...binaries.keys()]) === JSON.stringify(GENERATED_FILES), 'generated file set drifted');
  for (const [filename, bytes] of binaries) await writeFile(join(output, filename), bytes);

  const assets = manifestDefinitions().map((entry) => {
    const bytes = binaries.get(entry.filename);
    invariant(bytes, `missing generated bytes for ${entry.filename}`);
    return { ...entry, byteSha256: sha256(bytes), byteSize: bytes.length };
  });
  const manifest = {
    schemaVersion: 1,
    fixtureVersion: FIXTURE_VERSION,
    frozenClock: FROZEN_INSTANT,
    definitionSemantics: 'Fixture definition only. This manifest is not a current-access attestation, trusted-capture receipt, production identity proof, or proof that a hash matches production.',
    qualificationBoundary: 'The committed binaries prepare synthetic inputs only. Original Appendix F cases 40-45 remain unimplemented until a trusted capture path and canonical API loader independently establish source identity, current-version authority, authorization at read/use time, and parser receipts.',
    generatedBy: 'source-binaries/generator.mjs',
    assets,
  };
  await writeFile(join(output, 'asset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function parseOutputArgument(argv) {
  invariant(argv.length === 2 && argv[0] === '--out', 'usage: node generator.mjs --out <owned-output-directory>');
  return argv[1];
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  const output = parseOutputArgument(process.argv.slice(2));
  const manifest = await buildSourceBinaries(output);
  process.stdout.write(`${JSON.stringify({ output: resolve(output), assets: manifest.assets.length })}\n`);
}
