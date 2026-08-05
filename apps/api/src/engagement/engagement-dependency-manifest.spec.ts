import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE = path.join(__dirname, '__fixtures__', 'engagement-dependency-manifest.v1.json');
const SCRIPT = path.join(
  REPO,
  'apps',
  'api',
  'scripts',
  'engagement-phase0-dependency-manifest.ts',
);
const TSX_CLI = require.resolve('tsx/cli');

function readFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
}

function generate() {
  const result = spawnSync(process.execPath, [TSX_CLI, SCRIPT], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30_000,
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`dependency manifest generator failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

describe('Engagement dependency manifest', () => {
  describe('fixture integrity', () => {
    it('exists and parses', () => {
      const manifest = readFixture();
      expect(manifest.schemaVersion).toBe(1);
      expect(Array.isArray(manifest.externalImporters)).toBe(true);
    });

    it('has a root_registration category', () => {
      expect(
        new Set(readFixture().externalImporters.map((entry: any) => entry.category)).has(
          'root_registration',
        ),
      ).toBe(true);
    });
  });

  describe('structural invariants', () => {
    let manifest: any;
    beforeAll(() => {
      manifest = readFixture();
    });

    it('has no duplicate entries', () => {
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const entry of manifest.externalImporters) {
        const key = `${entry.importerFile}|${entry.importedFile}|${entry.importedSymbols.join(
          ',',
        )}|${entry.importKind}`;
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
      }
      expect(duplicates).toEqual([]);
    });

    it('has no self-import', () => {
      for (const entry of manifest.externalImporters) {
        expect(entry.importerFile).not.toBe(entry.importedFile);
      }
    });

    it('records isExternal as a boolean', () => {
      for (const entry of [...manifest.externalImporters, ...manifest.internalImports]) {
        expect(typeof entry.isExternal).toBe('boolean');
      }
    });
  });

  describe('snapshot comparison', () => {
    it('matches the current source dependency graph exactly', () => {
      expect(generate()).toEqual(readFixture());
    });
  });

  describe('negative controls', () => {
    it('detects a synthetic dependency change', () => {
      const committed = readFixture();
      const changed = JSON.parse(JSON.stringify(committed));
      changed.externalImporters[0].importedSymbols = ['SYNTHETIC'];
      expect(changed).not.toEqual(committed);
    });
  });
});
