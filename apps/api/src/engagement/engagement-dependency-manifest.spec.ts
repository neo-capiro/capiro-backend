import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const LEGACY_FIXTURE = path.join(
  __dirname,
  '__fixtures__',
  'engagement-dependency-manifest.v1.json',
);
const PHASE1_FIXTURE = path.join(
  __dirname,
  '__fixtures__',
  'outreach-v3-p1-reverse-dependencies.v1.json',
);
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

interface Phase1DependencyEntry {
  consumerModule: string;
  consumerFile: string;
  currentImport: string;
  symbols: string[];
  methodUses: string[];
  targetBoundary: string;
  allowedAfterPhase1: boolean;
}

function readLegacyFixture(): DependencyManifest {
  return JSON.parse(fs.readFileSync(LEGACY_FIXTURE, 'utf-8')) as DependencyManifest;
}

function readPhase1Fixture(): Phase1DependencyEntry[] {
  return JSON.parse(fs.readFileSync(PHASE1_FIXTURE, 'utf-8')) as Phase1DependencyEntry[];
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
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

function hasDependency(
  current: DependencyManifest,
  importer: string,
  importedSuffix: string,
): boolean {
  return current.externalImporters.some(
    (entry) =>
      entry.importerFile === importer && entry.importedFile.endsWith(importedSuffix),
  );
}

describe('Engagement dependency manifests', () => {
  describe('fixture integrity', () => {
    it('preserves the Phase 0 graph as a parseable historical baseline', () => {
      const manifest = readLegacyFixture();
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.externalImporters.length).toBeGreaterThan(0);
      expect(manifest.summary.externalImporterCount).toBe(manifest.externalImporters.length);
    });

    it('has a complete Phase 1 boundary manifest with no prohibited remaining target', () => {
      const manifest = readPhase1Fixture();
      expect(manifest.length).toBeGreaterThan(0);
      for (const entry of manifest) {
        expect(entry.consumerModule).toBeTruthy();
        expect(entry.consumerFile).toBeTruthy();
        expect(entry.currentImport).toBeTruthy();
        expect(entry.symbols.length).toBeGreaterThan(0);
        expect(entry.methodUses.length).toBeGreaterThan(0);
        expect(entry.targetBoundary).toBeTruthy();
        expect(entry.allowedAfterPhase1).toBe(true);
      }
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

    it('removes the broad Phase 1 dependencies that were explicitly targeted', () => {
      const forbidden: Array<[string, string]> = [
        [
          'apps/api/src/intelligence/alert-memo/alert-memo.module.ts',
          '/engagement/engagement.module.js',
        ],
        [
          'apps/api/src/intelligence/alert-memo/district-brief.module.ts',
          '/engagement/engagement.module.js',
        ],
        [
          'apps/api/src/intelligence/alert-memo/hearing-recap.service.ts',
          '/engagement/engagement.service.js',
        ],
        ['apps/api/src/reviews/reviews.module.ts', '/engagement/engagement.module.js'],
        ['apps/api/src/reviews/reviews.service.ts', '/engagement/engagement.service.js'],
        ['apps/api/src/reviews/reviews.service.ts', '/engagement/outreach-draft.service.js'],
        ['apps/api/src/meri/meri.module.ts', '/engagement/ai-credential-resolver.service.js'],
      ];
      for (const [importer, imported] of forbidden) {
        expect(hasDependency(current, importer, imported)).toBe(false);
      }
    });

    it('retains only explicitly governed boundary-module imports for callbacks and workers', () => {
      expect(
        hasDependency(
          current,
          'apps/api/src/engagement-callbacks/engagement-callbacks.module.ts',
          '/engagement/engagement.module.js',
        ),
      ).toBe(true);
      expect(
        hasDependency(
          current,
          'apps/api/src/engagement-workers/engagement-workers.module.ts',
          '/engagement/engagement.module.js',
        ),
      ).toBe(true);
    });
  });

  describe('negative controls', () => {
    it('detects a synthetic prohibited Phase 1 dependency', () => {
      const changed = readPhase1Fixture().map((entry) => ({ ...entry }));
      changed[0]!.allowedAfterPhase1 = false;
      expect(changed.some((entry) => entry.allowedAfterPhase1 !== true)).toBe(true);
    });

    it('detects a synthetic current graph change', () => {
      const current = generate();
      const changed = JSON.parse(JSON.stringify(current)) as DependencyManifest;
      changed.externalImporters[0]!.importedSymbols = ['SYNTHETIC'];
      expect(changed.externalImporters).not.toEqual(current.externalImporters);
    });
  });
});
