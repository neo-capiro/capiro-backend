import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [absolute] : [];
  });
}

describe('Jev import boundary', () => {
  it('has no application imports before app-side factories are introduced', () => {
    const repository = path.resolve(__dirname, '../../../..');
    const offenders = sourceFiles(path.join(repository, 'apps'))
      .filter((file) => file.includes(`${path.sep}src${path.sep}`))
      .filter((file) => /(?:from\s+|require\()['"][^'"]*jev(?:\/|['"])/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('keeps all apps free of direct Jev source imports', () => {
    const repository = path.resolve(__dirname, '../../../..');
    const offenders = sourceFiles(path.join(repository, 'apps')).filter((file) =>
      /packages[\\/]meriv2-core[\\/]src[\\/]jev|@capiro\/meriv2-core\/jev/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
