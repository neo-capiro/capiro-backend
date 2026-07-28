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
  test('supported entrypoint scripts contain no automatic Prisma migration-history mutation', () => {
    const active = apiFile('scripts/entrypoint.sh');
    const compatibility = apiFile('scripts/entrypoint-legacy.sh');

    for (const source of [active, compatibility]) {
      expect(source).not.toContain('_prisma_migrations');
      expect(source).not.toContain('rolled_back_at = NOW()');
      expect(source).not.toContain('Resolving failed migration:');
    }

    expect(active).toMatch(/node .*prisma.* migrate deploy/);
    expect(compatibility).toContain('Refusing legacy migrate dispatch');
  });

  test('canonical PDF promotion requires exact SHA approval before Prisma construction', () => {
    const source = apiFile('scripts/ingest-defense-budget-pdf.ts');
    const approvalParse = source.indexOf("requireApprovedSha256(arg('approved-sha256'))");
    const byteComparison = source.indexOf('assertApprovedShaMatches(sourceSha256, approvedSha256)');
    const prismaConstruction = source.indexOf('const prisma = new PrismaClient()');

    expect(approvalParse).toBeGreaterThan(-1);
    expect(byteComparison).toBeGreaterThan(approvalParse);
    expect(prismaConstruction).toBeGreaterThan(byteComparison);
    expect(source).toContain('--commit promotes exactly one processable PDF');
    expect(source).toContain('onePdfPerTransaction: true');
    expect(source).toContain('CANONICAL_TRANSACTION_TIMEOUT_MS');
  });

  test('preflight stays network-free and vendor parsing remains explicitly authorized', () => {
    const source = apiFile('scripts/ingest-defense-budget-pdf.ts');
    const loaderStart = source.indexOf('function loadVendorParseEnvironment');
    const beforeLoader = source.slice(0, loaderStart);

    expect(loaderStart).toBeGreaterThan(-1);
    expect(beforeLoader).not.toContain('dotenvConfig(');
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
