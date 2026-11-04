/** Rebuild the pinned official NAICS/PSC snapshot; no database or model access. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ExcelJS from 'exceljs';

const OUTPUT = resolve(__dirname, '../src/clients/reference-data/naics-psc.generated.json');
const RETRIEVED_AT = '2026-11-04';
const USAGE = `Usage: node --import tsx scripts/generate-profile-build-reference-catalog.ts [--source-dir DIR | --download] [--check]
  --source-dir DIR  Read the two checksum-pinned workbooks from DIR, without network.
  --download        Download official pinned workbooks to the system temporary directory.
  --check           Compare byte-for-byte with the committed snapshot; do not write it.
  --help            Show usage without network or writes.
Exit codes: 0 success; 1 source/validation/reproduction failure; 2 invalid arguments.
See src/clients/reference-data/README.md for source attribution and refresh instructions.`;

const SOURCES = {
  naics: {
    publisher: 'U.S. Census Bureau',
    version: '2022',
    sourcePageUrl: 'https://www.census.gov/naics/',
    sourceUrl: 'https://www.census.gov/naics/2022NAICS/2022_NAICS_Structure.xlsx',
    filename: '2022_NAICS_Structure.xlsx',
    sourceSha256: '217c9e0d4d74e7517bc288f5f308b73aa0de5ee787976a6dd222412be28ada22',
    sourcePublishedAt: null,
    sourceEffectivePeriod: '2022',
    sheet: '2022 NAICS Structure',
    sourceRows: 2125,
    activeCount: 1012,
    inactiveCount: 0,
  },
  psc: {
    publisher: 'U.S. General Services Administration',
    version: '2025-04',
    sourcePageUrl: 'https://www.acquisition.gov/psc-manual',
    sourceUrl: 'https://www.acquisition.gov/sites/default/files/manual/PSC%20April%202025.xlsx',
    filename: 'PSC_April_2025.xlsx',
    sourceSha256: '5ae8159d8dff645f24e5b397decc4914f7efebb25f7777cbea8e75ab7e8430f4',
    sourcePublishedAt: '2025-04-08',
    sourceEffectivePeriod: '2025-04',
    sheet: 'PSC for 042025',
    sourceRows: 6108,
    activeCount: 2344,
    inactiveCount: 1310,
  },
} as const;

type Entry = { code: string; label: string; validFrom: string | null; validTo: null };
type Kind = keyof typeof SOURCES;

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') {
    ensure(Number.isSafeInteger(value), 'Non-integral code in workbook');
    return String(value);
  }
  if (typeof value === 'object' && 'richText' in value) {
    return value.richText.map((part) => part.text).join('').trim();
  }
  throw new Error('Unexpected workbook cell type');
}

function cellDate(cell: ExcelJS.Cell): string | null {
  if (cell.value === null || cell.value === undefined) return null;
  ensure(cell.value instanceof Date && Number.isFinite(cell.value.getTime()), 'Invalid PSC date');
  return cell.value.toISOString().slice(0, 10);
}

async function parseSource(kind: Kind, sourceDir: string) {
  const source = SOURCES[kind];
  const bytes = await readFile(join(sourceDir, source.filename));
  ensure(createHash('sha256').update(bytes).digest('hex') === source.sourceSha256,
    `${kind}: source checksum changed; review the new official edition before updating its pin`);
  // Reuse the repository's ExcelJS dependency; no custom XLSX parser or runtime fetching.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet(source.sheet);
  ensure(sheet, `${kind}: expected worksheet missing`);
  const entries: Entry[] = [];
  const inactiveCodes = new Set<string>();
  let sourceRows = 0;

  if (kind === 'naics') {
    ensure(cellText(sheet.getCell('B3')) === '2022 NAICS Code'
      && cellText(sheet.getCell('C3')) === '2022 NAICS Title', 'NAICS header changed');
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= 3) return;
      const code = cellText(row.getCell(2));
      if (!code) return;
      sourceRows += 1;
      ensure(/^\d{2,6}$|^(31-33|44-45|48-49)$/.test(code), 'Unexpected NAICS code format');
      // Only national industries are assignable. Sector/subsector groups are not codes to save.
      if (code.length !== 6) return;
      const label = cellText(row.getCell(3));
      ensure(label, `NAICS ${code}: title missing`);
      entries.push({ code, label, validFrom: null, validTo: null });
    });
  } else {
    ensure(cellText(sheet.getCell('A1')) === 'PSC CODE'
      && cellText(sheet.getCell('B1')) === 'PRODUCT AND SERVICE CODE NAME'
      && cellText(sheet.getCell('D1')) === 'END DATE', 'PSC header changed');
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const code = cellText(row.getCell(1));
      if (!code) return;
      sourceRows += 1;
      ensure(/^[A-Z0-9]{1,4}$/.test(code), 'Unexpected PSC code format');
      if (code.length !== 4) return;
      const start = cellDate(row.getCell(3));
      const end = cellDate(row.getCell(4));
      if (end !== null) {
        inactiveCodes.add(code);
        return;
      }
      ensure(start !== null && start <= RETRIEVED_AT, `PSC ${code}: future or missing start date`);
      const label = cellText(row.getCell(2));
      ensure(label, `PSC ${code}: title missing`);
      entries.push({ code, label, validFrom: start, validTo: null });
    });
  }
  entries.sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  ensure(new Set(entries.map((entry) => entry.code)).size === entries.length, `${kind}: duplicate active code`);
  for (const entry of entries) inactiveCodes.delete(entry.code);
  ensure(sourceRows === source.sourceRows, `${kind}: source row count changed (${sourceRows})`);
  ensure(entries.length === source.activeCount, `${kind}: active code count changed (${entries.length})`);
  ensure(inactiveCodes.size === source.inactiveCount, `${kind}: inactive code count changed (${inactiveCodes.size})`);
  return {
    ...source,
    sourceRetrievedAt: RETRIEVED_AT,
    status: 'authoritative_snapshot',
    entries,
    inactiveCodes: [...inactiveCodes].sort(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(USAGE); return; }
  let sourceDir: string | undefined;
  let download = false;
  let check = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--source-dir' && args[i + 1] && !args[i + 1]!.startsWith('--') && !sourceDir) {
      sourceDir = resolve(args[++i]!);
    } else if (arg === '--download' && !download) download = true;
    else if (arg === '--check' && !check) check = true;
    else { console.error(USAGE); process.exitCode = 2; return; }
  }
  if ((!sourceDir && !download) || (sourceDir && download)) {
    console.error(USAGE); process.exitCode = 2; return;
  }
  if (download) {
    sourceDir = join(tmpdir(), 'capiro-profile-build-reference-sources');
    await mkdir(sourceDir, { recursive: true });
    for (const [kind, source] of Object.entries(SOURCES)) {
      // The Census canonical XLSX URL sometimes returns 403 without its download query.
      const url = kind === 'naics' ? `${source.sourceUrl}?download=1` : source.sourceUrl;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: source.sourcePageUrl },
      });
      ensure(response.ok, `${kind}: official source download failed (${response.status})`);
      const bytes = Buffer.from(await response.arrayBuffer());
      ensure(bytes.byteLength <= 2_000_000, `${kind}: unexpected source size`);
      ensure(createHash('sha256').update(bytes).digest('hex') === source.sourceSha256,
        `${kind}: source checksum changed; refusing to replace the reviewed edition`);
      await writeFile(join(sourceDir, source.filename), bytes);
    }
  }
  ensure(sourceDir, 'Source directory required');
  const snapshot = {
    schemaVersion: 1,
    naics: await parseSource('naics', sourceDir),
    psc: await parseSource('psc', sourceDir),
  };
  const output = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (check) ensure(await readFile(OUTPUT, 'utf8') === output, 'Generated snapshot differs from committed data');
  else { await mkdir(resolve(OUTPUT, '..'), { recursive: true }); await writeFile(OUTPUT, output); }
  console.log(`${check ? 'Verified' : 'Generated'} 1,012 NAICS and 2,344 active PSC codes; 1,310 retired PSC codes retained for validation.`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Reference catalog generation failed');
    process.exitCode = 1;
  });
}
