import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'src/defense-budget/stages/authorization/provisions');
const PRODUCTION_FILES = [
  'authorization-provision-v1.ts',
  'authorization-provision-linker-v1.ts',
  'authorization-provision-evidence-dedupe-v1.ts',
  'authorization-provision-link-utils-v1.ts',
  'authorization-provision-reference-linking-v1.ts',
  'authorization-provision-targets-v1.ts',
];

describe('authorization provision Phase 6 containment', () => {
  it('contains no persistence, canonical writer, network, or paid-parser dependency', () => {
    const source = PRODUCTION_FILES.map((file) =>
      fs.readFileSync(path.join(ROOT, file), 'utf8'),
    ).join('\n');
    const prohibited = [
      'PrismaClient',
      '$queryRaw',
      '$executeRaw',
      'ProgramElementWriterService',
      'committeeReportProvision',
      'provisionPeLink',
      'llamaparse',
      'boto3',
      'fetch(',
      'axios',
    ];
    for (const token of prohibited) expect(source).not.toContain(token);
  });

  it('does not import the legacy provision loader or sync script', () => {
    const source = PRODUCTION_FILES.map((file) =>
      fs.readFileSync(path.join(ROOT, file), 'utf8'),
    ).join('\n');
    expect(source).not.toContain('provision-loader');
    expect(source).not.toContain('sync-report-provisions');
  });
});
