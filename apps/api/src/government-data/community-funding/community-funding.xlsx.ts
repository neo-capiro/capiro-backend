import ExcelJS from 'exceljs';
import { parseHouseXlsxRows } from './community-funding.parser.js';

/** Canonical House consolidated CPF header names, with known FY aliases. */
const HEADER_ALIASES: Record<string, string[]> = {
  'Member Last Name': ['Member Last Name'],
  'Member First Name': ['Member First Name'],
  District: ['District'],
  Party: ['Party'],
  Subcommittee: ['Subcommittee'],
  Recipient: ['Recipient'],
  'Project Description': ['Project Description', 'Project Purpose', 'Project'],
  'Recipient Address': ['Recipient Address'],
  'Amount Requested': ['Amount Requested', 'Amount'],
  'Member Website': ['Member Website', 'Website'],
};

const REQUIRED_CANONICAL = Object.keys(HEADER_ALIASES);

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapHeaders(rawNames: string[]): { canonical: string[]; projectField: string } {
  const lowerToRaw = new Map(rawNames.map(name => [name.toLowerCase(), name]));
  const canonical: string[] = [];
  let projectField = 'Project Description';

  for (const required of REQUIRED_CANONICAL) {
    const aliases = HEADER_ALIASES[required]!;
    const hit = aliases.find(alias => lowerToRaw.has(alias.toLowerCase()));
    if (!hit) {
      throw new Error(
        `unexpected CPF workbook columns: missing "${required}" (aliases ${JSON.stringify(aliases)}); got ${JSON.stringify(rawNames)}`,
      );
    }
    if (required === 'Project Description') projectField = hit;
    canonical.push(hit);
  }
  return { canonical, projectField };
}

function pickWorksheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  const preferred =
    workbook.getWorksheet('asRequestedCPFs_FY26') ??
    workbook.worksheets.find(sheet => /cpf|request/i.test(sheet.name)) ??
    workbook.worksheets[0];
  if (!preferred) throw new Error('CPF workbook contains no worksheet');
  return preferred;
}

export async function readHouseCpfWorkbook(path: string, fiscalYear: number) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = pickWorksheet(workbook);
  const header = sheet.getRow(1).values as unknown[];
  const names = header.slice(1).map(normalizeHeader).filter(Boolean);
  const { canonical, projectField } = mapHeaders(names);

  const rows: Record<string, unknown>[] = [];
  for (let number = 2; number <= sheet.rowCount; number++) {
    const values = sheet.getRow(number).values as unknown[];
    if (values.slice(1).every(value => value === null || value === undefined || value === '')) {
      continue;
    }
    const raw = Object.fromEntries(names.map((name, i) => [name, values[i + 1]]));
    // Normalize project field onto the parser's expected key.
    if (projectField !== 'Project Description') {
      raw['Project Description'] = raw[projectField];
    }
    rows.push(raw);
  }

  return {
    sheetName: sheet.name,
    sourceRows: rows.length,
    headerCanonical: canonical,
    projectField,
    ...parseHouseXlsxRows(rows, fiscalYear),
  };
}
