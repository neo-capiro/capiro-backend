import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../..');
const rehearsal = readFileSync(
  join(
    REPO_ROOT,
    'apps/api/prisma/security-rehearsals/business-development-phase5-watch-isolation.sql',
  ),
  'utf8',
);

describe('Business Development Phase 5 RLS rehearsal fixtures', () => {
  test('every generated SHA-256 fingerprint uses lowercase hexadecimal characters', () => {
    const repeatedFingerprintParts = [...rehearsal.matchAll(/repeat\('([^']+)',\s*64\)/g)].map(
      (match) => match[1],
    );

    expect(repeatedFingerprintParts.length).toBeGreaterThan(0);
    for (const part of repeatedFingerprintParts) {
      expect(part).toMatch(/^[0-9a-f]+$/);
    }
  });
});
