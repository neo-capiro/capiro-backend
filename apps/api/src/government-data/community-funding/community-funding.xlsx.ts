import ExcelJS from 'exceljs';
import { parseHouseXlsxRows } from './community-funding.parser.js';

export async function readHouseCpfWorkbook(path: string, fiscalYear: number) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet('asRequestedCPFs_FY26') ?? workbook.worksheets[0];
  if (!sheet) throw new Error('CPF workbook contains no worksheet');
  const header = sheet.getRow(1).values as unknown[];
  const names = header.slice(1).map(value => String(value ?? '').trim());
  const required = ['Member Last Name', 'Member First Name', 'District', 'Party', 'Subcommittee', 'Recipient', 'Project Description', 'Recipient Address', 'Amount Requested', 'Member Website'];
  if (names.length !== required.length || required.some((name, i) => names[i] !== name)) throw new Error(`unexpected CPF workbook columns: ${JSON.stringify(names)}`);
  const rows: Record<string, unknown>[] = [];
  for (let number = 2; number <= sheet.rowCount; number++) {
    const values = sheet.getRow(number).values as unknown[];
    if (values.slice(1).every(value => value === null || value === undefined || value === '')) continue;
    rows.push(Object.fromEntries(names.map((name, i) => [name, values[i + 1]])));
  }
  return { sheetName: sheet.name, sourceRows: rows.length, ...parseHouseXlsxRows(rows, fiscalYear) };
}
