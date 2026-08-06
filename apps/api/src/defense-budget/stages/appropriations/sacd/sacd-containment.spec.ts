import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'src/defense-budget/stages/appropriations/sacd');
const PRODUCTION_FILES = [
  'sacd-source-profile-v1.ts',
  'sacd-composition-helpers-v1.ts',
  'sacd-reports-v1.ts',
  'sacd-emission-v1.ts',
  'sacd-composer-v1.ts',
];

describe('SAC-D Phase 6 containment', () => {
  it('contains no persistence, canonical writer, network, AWS, or paid-parser dependency', () => {
    const source = PRODUCTION_FILES.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
    for (const token of [
      'PrismaClient',
      '$queryRaw',
      '$executeRaw',
      'ProgramElementWriterService',
      'llamaparse',
      'boto3',
      'fetch(',
      'axios',
    ]) {
      expect(source).not.toContain(token);
    }
  });

  it('cannot emit HAC-D, authorization, conference, or enacted funding fields', () => {
    const source = PRODUCTION_FILES.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
    for (const field of ['hascMark', 'sascMark', 'hacDMark', 'conference', 'enacted']) {
      expect(source).not.toContain(`field: '${field}'`);
    }
  });
});
