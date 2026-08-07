import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'src/defense-budget/stages/appropriations/hacd');
const PRODUCTION_FILES = [
  'hacd-source-profile-v1.ts',
  'hacd-composition-helpers-v1.ts',
  'hacd-reports-v1.ts',
  'hacd-emission-v1.ts',
  'hacd-composer-v1.ts',
];

describe('HAC-D Phase 6 containment', () => {
  it('contains no persistence, canonical writer, network, AWS, or paid-parser dependency', () => {
    const source = PRODUCTION_FILES.map((file) =>
      fs.readFileSync(path.join(ROOT, file), 'utf8'),
    ).join('\n');
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

  it('never emits authorization, Senate appropriations, conference, or enacted funding fields', () => {
    const source = PRODUCTION_FILES.map((file) =>
      fs.readFileSync(path.join(ROOT, file), 'utf8'),
    ).join('\n');
    for (const field of [
      'hascMark',
      'sascMark',
      'sacDMark',
      "field: 'conference'",
      "field: 'enacted'",
    ]) {
      expect(source).not.toContain(field);
    }
  });
});
