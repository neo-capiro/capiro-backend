import path from 'node:path';
import { readHouseCpfWorkbook } from './community-funding.xlsx.js';

const FIXTURE = path.resolve(
  process.cwd(),
  'scripts/__data__/cpf_cds_source_documents/house_fy2026_cpf_consolidated.xlsx',
);

describe('house CPF workbook reader', () => {
  it('reads the committed FY2026 consolidated workbook with Project Description header', async () => {
    const fs = await import('node:fs');
    if (!fs.existsSync(FIXTURE)) {
      // Fixture may be git-lfs sparse in some worktrees; skip rather than fail CI shape.
      return;
    }
    const result = await readHouseCpfWorkbook(FIXTURE, 2026);
    expect(result.sourceRows).toBeGreaterThan(5000);
    expect(result.candidates.length + result.rejected.length).toBe(result.sourceRows);
    expect(result.candidates[0]?.chamber).toBe('house');
    expect(result.candidates[0]?.amountStageRaw).toBe('amount_requested');
    expect(result.projectField).toBe('Project Description');
  });

  it('accepts Project Purpose as an alias for Project Description (FY24/FY25 shape)', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const os = await import('node:os');
    const fs = await import('node:fs');
    const tmp = path.join(os.tmpdir(), `cpf-xlsx-alias-${Date.now()}.xlsx`);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('FY24 House CPF Requests');
    ws.addRow([
      'Member Last Name',
      'Member First Name',
      'District',
      'Party',
      'Subcommittee',
      'Recipient',
      'Project Purpose',
      'Recipient Address',
      'Amount Requested',
      'Member Website',
    ]);
    ws.addRow([
      'Adams',
      'Alma',
      'NC12',
      'D',
      'CJS',
      'City of Charlotte',
      'Community Assistance',
      '600 E 4th St',
      '1000000',
      'https://example.gov',
    ]);
    await wb.xlsx.writeFile(tmp);
    try {
      const result = await readHouseCpfWorkbook(tmp, 2024);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({
        recipientName: 'City of Charlotte',
        projectTitle: 'Community Assistance',
        requestedAmountUsd: '1000000.00',
        fiscalYear: 2024,
      });
      expect(result.projectField).toBe('Project Purpose');
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
