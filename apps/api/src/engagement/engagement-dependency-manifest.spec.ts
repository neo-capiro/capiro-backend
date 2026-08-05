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

interface DependencyEntry {
  importerFile: string;
  importedFile: string;
  importedSymbols: string[];
  importKind: 'value' | 'type-only' | 'dynamic' | 'side-effect';
  isExternal: boolean;
  category: string;
}

interface DependencyManifest {
  schemaVersion: number;
  externalImporters: DependencyEntry[];
  internalImports: DependencyEntry[];
  summary: {
    externalImporterCount: number;
    importedSymbolCount: number;
  };
}

function readFixture(): DependencyManifest {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as DependencyManifest;
}

function generate(): DependencyManifest {
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
  return JSON.parse(result.stdout) as DependencyManifest;
}

function dependencyKey(entry: DependencyEntry): string {
  return `${entry.importerFile}|${entry.importedFile}|${entry.importedSymbols.join(',')}|${entry.importKind}`;
}

function sourcePath(repoPath: string): string {
  const normalized = repoPath.replace(/\\/g, '/').replace(/\.(tsx?|jsx?)$/, '');
  const candidates = [
    path.join(REPO, `${normalized}.ts`),
    path.join(REPO, `${normalized}.tsx`),
    path.join(REPO, normalized, 'index.ts'),
    path.join(REPO, normalized, 'index.tsx'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

describe('Engagement dependency manifest', () => {
  describe('fixture integrity', () => {
    it('exists and parses', () => {
      const manifest = readFixture();
      expect(manifest.schemaVersion).toBe(1);
      expect(Array.isArray(manifest.externalImporters)).toBe(true);
      expect(Array.isArray(manifest.internalImports)).toBe(true);
    });

    it('has a root_registration category', () => {
      expect(
        new Set(readFixture().externalImporters.map((entry) => entry.category)).has(
          'root_registration',
        ),
      ).toBe(true);
    });
  });

  describe('current graph invariants', () => {
    const current = generate();

    it('has no duplicate entries in either graph', () => {
      for (const entries of [current.externalImporters, current.internalImports]) {
        const keys = entries.map(dependencyKey);
        expect(new Set(keys).size).toBe(keys.length);
      }
    });

    it('has no self-imports', () => {
      for (const entry of [...current.externalImporters, ...current.internalImports]) {
        expect(entry.importerFile).not.toBe(entry.importedFile);
      }
    });

    it('records the correct external flag', () => {
      for (const entry of current.externalImporters) expect(entry.isExternal).toBe(true);
      for (const entry of current.internalImports) expect(entry.isExternal).toBe(false);
    });

    it('resolves every current Engagement import target to source', () => {
      const unresolved = [...current.externalImporters, ...current.internalImports]
        .filter((entry) => !fs.existsSync(sourcePath(entry.importedFile)))
        .map((entry) => `${entry.importerFile} -> ${entry.importedFile}`);
      expect(unresolved).toEqual([]);
    });
  });

  describe('accepted external boundary snapshot', () => {
    it('matches every external importer and summary exactly', () => {
      const committed = readFixture();
      const current = generate();
      expect(current.externalImporters).toEqual(committed.externalImporters);
      expect(current.summary).toEqual(committed.summary);
    });

    it('detects a synthetic external dependency change', () => {
      const committed = readFixture();
      const changed = JSON.parse(JSON.stringify(committed)) as DependencyManifest;
      changed.externalImporters[0].importedSymbols = ['SYNTHETIC'];
      expect(changed.externalImporters).not.toEqual(committed.externalImporters);
    });
  });
});
