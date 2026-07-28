import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';

function apiFile(relativePath: string): string {
  const cwd = process.cwd();
  const apiRoot = cwd.replace(/\\/g, '/').endsWith('/apps/api')
    ? cwd
    : resolve(cwd, 'apps/api');
  return readFileSync(resolve(apiRoot, relativePath), 'utf8');
}

describe('Program Elements operational safety guards', () => {
  test('supported entrypoints contain no automatic migration-history mutation', () => {
    const active = apiFile('scripts/entrypoint.sh');
    const compatibility = apiFile('scripts/entrypoint-legacy.sh');
    const dispatcher = apiFile('scripts/entrypoint-dispatcher.inc');
    for (const source of [active, compatibility, dispatcher]) {
      expect(source).not.toContain('_prisma_migrations');
      expect(source).not.toContain('rolled_back_at = NOW()');
      expect(source).not.toContain('Resolving failed migration:');
      expect(source).not.toMatch(/prisma[^\n]*migrate\s+resolve/);
    }
    expect(active).toMatch(/node .*prisma.* migrate deploy/);
    expect(compatibility).toContain('Refusing legacy migrate dispatch');
    expect(dispatcher).toContain('Refusing legacy migrate dispatch');
  });

  test('exactly one supported entrypoint can execute a migration', () => {
    const executable = (source: string): string =>
      source
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
    const sources = [
      apiFile('scripts/entrypoint.sh'),
      apiFile('scripts/entrypoint-legacy.sh'),
      apiFile('scripts/entrypoint-dispatcher.inc'),
    ].map(executable);
    expect(sources.filter((source) => /migrate deploy/.test(source))).toHaveLength(1);
  });

  test('canonical promotion gates SHA approval and comparison before DB access', () => {
    const source = apiFile('scripts/ingest-defense-budget-pdf.ts');
    const mainStart = source.indexOf('async function main(): Promise<void>');
    const approvalParse = source.indexOf(
      "requireApprovedSha256(arg('approved-sha256'))",
      mainStart,
    );
    const commitDispatch = source.indexOf(': await runCommit(', approvalParse);
    expect(approvalParse).toBeGreaterThan(mainStart);
    expect(commitDispatch).toBeGreaterThan(approvalParse);

    const runCommitStart = source.indexOf('async function runCommit(');
    const comparison = source.indexOf(
      'assertApprovedShaMatches(sourceSha256, approvedSha256)',
      runCommitStart,
    );
    const prismaConstruction = source.indexOf(
      'const prisma = new PrismaClient()',
      runCommitStart,
    );
    expect(comparison).toBeGreaterThan(runCommitStart);
    expect(prismaConstruction).toBeGreaterThan(comparison);
    expect(source).toContain('--commit promotes exactly one processable PDF');
    expect(source).toContain('onePdfPerTransaction: true');
    expect(source).toContain('Immutable source archive did not return an S3 VersionId');
    expect(source).toContain('const preExistingObservationIds = new Set');
    expect(source).toContain('function listLocalPdfsRequired');
  });

  test('preflight stays network-free and vendor parsing requires explicit authorization', () => {
    const source = apiFile('scripts/ingest-defense-budget-pdf.ts');
    const loaderStart = source.indexOf('function loadVendorParseEnvironment');
    expect(loaderStart).toBeGreaterThan(-1);
    expect(source.slice(0, loaderStart)).not.toContain('dotenvConfig(');
    expect(source).toContain("const ALLOW_VENDOR_PARSE = '--allow-vendor-parse'");
    expect(source).toContain(
      '--extract-only requires explicit --allow-vendor-parse authorization before any archive or LlamaParse call.',
    );
    expect(source).toContain('Preflight performs no S3 list/get call');
  });

  test('historical LlamaParse unit audit remains SELECT-only', () => {
    const source = apiFile('scripts/audit-llamaparse-pe-units.ts');
    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/);
    expect(source).not.toMatch(/\$executeRaw|\$executeRawUnsafe|\$queryRawUnsafe/);
    expect(source).toContain('SELECT_ONLY_NO_AUTOMATIC_DIVISION');
  });
});
