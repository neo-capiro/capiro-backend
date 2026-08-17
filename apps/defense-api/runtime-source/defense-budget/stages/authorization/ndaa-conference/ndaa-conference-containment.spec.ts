import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'src/defense-budget/stages/authorization/ndaa-conference');

describe('NDAA conference Phase 6 containment', () => {
  it('contains no canonical writer, persistence, AWS, network, or paid-parser calls', () => {
    const source = fs
      .readdirSync(ROOT)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n');
    for (const token of [
      'ProgramElementWriterService',
      'PrismaClient',
      '$queryRaw',
      '$executeRaw',
      'llamaparse',
      'boto3',
      'fetch(',
      'axios',
    ]) {
      expect(source).not.toContain(token);
    }
  });

  it('never emits appropriations conference or enacted funding fields', () => {
    const source = fs
      .readdirSync(ROOT)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/field:\s*['"]conference['"]/);
    expect(source).not.toMatch(/field:\s*['"]enacted['"]/);
  });
});
