import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('District Nexus dead-code contract', () => {
  it('does not retain superseded priority-intelligence helpers', () => {
    const cpfCds = readFileSync(
      resolve(__dirname, 'priority-intelligence/priority-intelligence-cpf-cds.ts'),
      'utf8',
    );
    const service = readFileSync(
      resolve(__dirname, 'priority-intelligence/priority-intelligence.service.ts'),
      'utf8',
    );

    expect(cpfCds).not.toContain('cpfCdsChangeKindFromRow');
    expect(service).not.toContain('changeRowsToRecords');
  });
});
