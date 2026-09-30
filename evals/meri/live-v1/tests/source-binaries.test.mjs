import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { buildSourceBinaries, verifyAssetBytes } from '../source-binaries/generator.mjs';
import { cases } from '../cases.mjs';
import { frozenFixture } from '../fixture.mjs';

const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const ExcelJS = apiRequire('exceljs');
const JSZip = apiRequire('jszip');
const { XMLParser } = apiRequire('fast-xml-parser');
const pdfParsePath = apiRequire.resolve('pdf-parse');
const { PDFParse } = await import(pathToFileURL(pdfParsePath).href);

const ROOT = new URL('../source-binaries/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('asset-manifest.json', ROOT), 'utf8'));
const byId = new Map(manifest.assets.map((asset) => [asset.logicalSourceId, asset]));
const expectedIds = ['D-A-1', 'DECK-A-1', 'SHEET-A-1', 'FILE-B-1', 'PDF-PENDING-1', 'REPORT-A-v1', 'REPORT-A-v2'];

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function assetBytes(id, base = ROOT) {
  const entry = byId.get(id);
  assert.ok(entry, `missing manifest entry ${id}`);
  return readFile(new URL(entry.filename, base));
}

async function parsePdf(id) {
  const parser = new PDFParse({ data: await assetBytes(id) });
  try {
    const info = await parser.getInfo();
    const extracted = await parser.getText();
    return {
      total: info.total,
      pages: extracted.pages.map((page) => String(page.text ?? '').replace(/\s+/g, ' ').trim()),
    };
  } finally {
    await parser.destroy();
  }
}

function collectTextRuns(node, output = []) {
  if (node == null) return output;
  if (Array.isArray(node)) {
    for (const child of node) collectTextRuns(child, output);
    return output;
  }
  if (typeof node !== 'object') return output;
  for (const [key, value] of Object.entries(node)) {
    if (key.split(':').pop() === 't') {
      if (typeof value === 'string' || typeof value === 'number') output.push(String(value));
      else collectTextRuns(value, output);
    } else collectTextRuns(value, output);
  }
  return output;
}

function relationshipList(parsed) {
  const value = parsed.Relationships?.Relationship;
  return Array.isArray(value) ? value : value ? [value] : [];
}

test('manifest maps the immutable fixture without claiming access or production authority', () => {
  assert.equal(cases.length, 75);
  assert.deepEqual(cases.slice(39, 45).map((entry) => entry.id), ['40', '41', '42', '43', '44', '45']);
  assert.deepEqual(manifest.assets.map((asset) => asset.logicalSourceId), expectedIds);
  assert.equal(manifest.fixtureVersion, frozenFixture.version);
  assert.equal(manifest.frozenClock, frozenFixture.clock.instant);
  assert.match(manifest.definitionSemantics, /not a current-access attestation/i);
  assert.match(manifest.definitionSemantics, /not.*production identity proof/i);
  assert.match(manifest.qualificationBoundary, /remain unimplemented/i);
  assert.match(manifest.qualificationBoundary, /canonical API loader/i);

  for (const asset of manifest.assets) {
    assert.equal(asset.tenantId, frozenFixture.sources[asset.logicalSourceId].tenantId);
    assert.equal(asset.clientId, frozenFixture.sources[asset.logicalSourceId].clientId);
    assert.equal(asset.fixtureMapping.sourceId, asset.logicalSourceId);
    assert.equal(asset.fixtureMapping.fixtureVersion, frozenFixture.version);
    assert.equal(asset.logicalBindingAuthority, 'manifest-only-until-canonical-api-loader');
    assert.equal(asset.accessAttestation, 'none');
  }

  assert.equal(byId.get('FILE-B-1').classification, 'synthetic-restricted-client');
  assert.equal(byId.get('FILE-B-1').filename, 'FILE-B-1-restricted.pdf');
  assert.equal(byId.get('PDF-PENDING-1').extractionState, 'pending');
  assert.equal(byId.get('PDF-PENDING-1').metadataOnly, true);
  assert.equal(byId.get('REPORT-A-v1').fixtureLifecycle, 'superseded');
  assert.equal(byId.get('REPORT-A-v1').current, false);
  assert.equal(byId.get('REPORT-A-v2').fixtureLifecycle, 'current');
  assert.equal(byId.get('REPORT-A-v2').current, true);
});

test('committed PDF assets have real pages and exact page-scoped text', async () => {
  const capability = await parsePdf('D-A-1');
  assert.equal(capability.total, 4);
  assert.match(capability.pages[3], /Develops unmanned maritime sensors/);
  assert.ok(capability.pages.slice(0, 3).every((text) => !text.includes('unmanned maritime sensors')));

  const pending = await parsePdf('PDF-PENDING-1');
  assert.equal(pending.total, 1);
  assert.equal(byId.get('PDF-PENDING-1').expectedLocations.length, 0);

  const restricted = await parsePdf('FILE-B-1');
  assert.equal(restricted.total, 1);
  assert.notEqual(byId.get('FILE-B-1').filename, byId.get('D-A-1').filename);
  assert.notEqual(byId.get('FILE-B-1').byteSha256, byId.get('D-A-1').byteSha256);

  const [oldReport, currentReport] = await Promise.all([parsePdf('REPORT-A-v1'), parsePdf('REPORT-A-v2')]);
  assert.equal(oldReport.total, 80);
  assert.equal(currentReport.total, 80);
  assert.ok(oldReport.pages.every((text) => !text.includes('Synthetic recommendation')));

  const alphaPages = currentReport.pages.flatMap((text, index) => text.includes('Synthetic recommendation Alpha') ? [index + 1] : []);
  const betaPages = currentReport.pages.flatMap((text, index) => text.includes('Synthetic recommendation Beta') ? [index + 1] : []);
  assert.deepEqual(alphaPages, [4]);
  assert.deepEqual(betaPages, [79]);
  assert.ok(alphaPages[0] < betaPages[0]);
  assert.ok(betaPages[0] > 20, 'the complete recommendation list must require pagination beyond the initial 20 pages');
  for (const [index, text] of currentReport.pages.entries()) {
    if (index + 1 === 4 || index + 1 === 79) continue;
    assert.equal(text, `Synthetic report scope - REPORT-A-v2 - page ${index + 1} of 80`);
  }
});

test('committed PPTX has six slides and real slide-6 speaker notes', async () => {
  const zip = await JSZip.loadAsync(await assetBytes('DECK-A-1'));
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]));
  assert.equal(slidePaths.length, 6);

  const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, trimValues: true });
  const slideSixRuns = collectTextRuns(xmlParser.parse(await zip.file('ppt/slides/slide6.xml').async('string')));
  assert.ok(slideSixRuns.includes('Autonomy evaluation'));
  assert.ok(!slideSixRuns.includes('demo risk'), 'speaker notes must not be flattened into visible slide text');

  const relationships = relationshipList(xmlParser.parse(await zip.file('ppt/slides/_rels/slide6.xml.rels').async('string')));
  const noteRelationship = relationships.find((entry) => String(entry.Type).endsWith('/notesSlide') && entry.TargetMode !== 'External');
  assert.ok(noteRelationship, 'slide 6 must link to a real notesSlide part');
  const notesPath = posix.normalize(posix.join('ppt/slides', noteRelationship.Target));
  assert.match(notesPath, /^ppt\/notesSlides\/notesSlide\d+\.xml$/);
  const notesRuns = collectTextRuns(xmlParser.parse(await zip.file(notesPath).async('string')));
  assert.ok(notesRuns.includes('demo risk'));
});

test('committed XLSX exposes exact cells and a saved, disclosed formula result', async () => {
  const bytes = await assetBytes('SHEET-A-1');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Budget']);
  const sheet = workbook.getWorksheet('Budget');
  assert.equal(sheet.getCell('B2').value, 6178000);
  assert.equal(sheet.getCell('B3').value, 2811000);
  assert.deepEqual(sheet.getCell('B4').value, { formula: 'SUM(B2:B3)', result: 8989000 });
  assert.match(String(sheet.getCell('A4').value), /saved formula result; not recalculated/i);

  const zip = await JSZip.loadAsync(bytes);
  const worksheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(worksheetXml, /<c r="B4"[^>]*><f>SUM\(B2:B3\)<\/f><v>8989000<\/v><\/c>/);
  const expected = byId.get('SHEET-A-1').expectedLocations.find((location) => location.cell === 'B4');
  assert.deepEqual(expected, {
    kind: 'xlsx-formula-cell', worksheet: 'Budget', cell: 'B4', formula: 'SUM(B2:B3)',
    savedResult: 8989000, disclosure: 'saved formula result; not recalculated',
  });
});

test('manifest byte checks fail closed for malformed, hash-drifted, and mismatched sources', async () => {
  for (const entry of manifest.assets) assert.equal(verifyAssetBytes(entry, await assetBytes(entry.logicalSourceId)), true);
  const pdf = byId.get('D-A-1');
  const bytes = await assetBytes('D-A-1');
  const malformed = Buffer.alloc(pdf.byteSize);
  assert.throws(
    () => verifyAssetBytes({ ...pdf, byteSha256: hash(malformed) }, malformed),
    /malformed PDF bytes/,
  );
  assert.throws(() => verifyAssetBytes({ ...pdf, byteSha256: '0'.repeat(64) }, bytes), /byte hash mismatch/);
  assert.throws(() => verifyAssetBytes(pdf, bytes, 'DECK-A-1'), /logical source mismatch/);
});

test('two fresh generations and committed assets are byte-for-byte deterministic', async (t) => {
  const scratchRoot = process.env.TMPDIR ?? process.cwd();
  const first = await mkdtemp(join(scratchRoot, 'meri-source-binaries-a-'));
  const second = await mkdtemp(join(scratchRoot, 'meri-source-binaries-b-'));
  t.after(async () => Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]));

  const [firstManifest, secondManifest] = await Promise.all([
    buildSourceBinaries(first),
    buildSourceBinaries(second),
  ]);
  assert.deepEqual(firstManifest, secondManifest);
  assert.deepEqual(firstManifest, manifest);

  for (const entry of manifest.assets) {
    const [committed, firstBytes, secondBytes] = await Promise.all([
      assetBytes(entry.logicalSourceId),
      readFile(join(first, entry.filename)),
      readFile(join(second, entry.filename)),
    ]);
    assert.equal(hash(firstBytes), entry.byteSha256);
    assert.deepEqual(firstBytes, secondBytes);
    assert.deepEqual(committed, firstBytes);
  }
  assert.deepEqual(
    await readFile(new URL('asset-manifest.json', ROOT)),
    await readFile(join(first, 'asset-manifest.json')),
  );
});
