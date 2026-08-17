import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');

function resolveTsxEntry(): string {
  const candidates = [
    path.join(API_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(API_ROOT, 'node_modules', 'tsx', 'dist', 'cli.js'),
    path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('tsx CLI entry not found under apps/api or repo root node_modules');
}

/**
 * Invoke build-rdte-cycle via node + tsx entry.
 * Avoids Windows spawnSync ENOENT/EINVAL on pnpm / pnpm.cmd shims, which is
 * especially flaky under the Phase 4 negative-control final suite load.
 */
function run(args: string[]) {
  const tsxEntry = resolveTsxEntry();
  return spawnSync(
    process.execPath,
    [tsxEntry, path.join('scripts', 'build-rdte-cycle.ts'), ...args],
    {
      cwd: API_ROOT,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '' },
    },
  );
}

describe('build-rdte-cycle operator boundary', () => {
  it('rejects unknown flags before parser or database setup', () => {
    const result = run(['--unknown']);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('unknown flag');
  });

  it('rejects the obsolete page-dump workflow', () => {
    const result = run([
      '--manifest',
      'manifest.json',
      '--out',
      'out',
      '--source-root',
      'sources',
      '--pages-dir',
      'pages',
    ]);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('unknown flag: --pages-dir');
  });

  it('rejects hand-authored verification input', () => {
    const result = run([
      '--manifest',
      'manifest.json',
      '--out',
      'out',
      '--source-root',
      'sources',
      '--verifications',
      'verification.json',
    ]);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('unknown flag: --verifications');
  });

  it('requires an explicit source-root or source-map', () => {
    const result = run(['--manifest', 'manifest.json', '--out', 'out']);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('supply --source-root or --source-map');
  });

  it('requires a positive cap for paid parsing', () => {
    const result = run([
      '--manifest',
      'manifest.json',
      '--out',
      'out',
      '--source-root',
      'sources',
      '--allow-paid-parse',
    ]);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('--max-paid-pages');
  });
});
