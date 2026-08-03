import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const VERIFICATION_DIR = 'src/defense-budget/verification';
const SCRIPTS_DIR = 'scripts';
const ENTRYPOINT = 'scripts/entrypoint-dispatcher.inc';

/** Strip line + block comments so comment-documented words never false-positive. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function verificationSources(): Array<{ file: string; code: string }> {
  const results: Array<{ file: string; code: string }> = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        results.push({
          file: rel,
          code: stripComments(readFileSync(full, 'utf8')),
        });
      }
    }
  };
  walk(VERIFICATION_DIR, '');
  return results;
}

describe('verification scaffold containment', () => {
  it('contains no promotion or canonical API symbols in executable source', () => {
    const prohibited = [
          'promotionReady',
          'canonicalEligible',
          'assertPromotionReady',
          'getCanonicalPromotionRecords',
          'VERIFIED_AUTOMATIC',
          'VERIFIED_REVIEWED',
          'persistVerificationResult',
          'verifyAndPersistBudgetDocument',
        ];
        // Phase 2 V1 allows a real Prisma repository under the V1 namespace.
        // The Phase 0 scaffold prohibited the non-V1 PrismaBudgetVerificationRepository
        // (a fake placeholder). The V1 class PrismaBudgetVerificationRepositoryV1 is
        // the approved concrete repository and is permitted.
        for (const { file, code } of verificationSources()) {
          for (const symbol of prohibited) {
            expect({ file, hit: code.includes(symbol) }).toEqual({ file, hit: false });
          }
        }
  });

  it('accepts no approval SHA parameter anywhere in the scaffold', () => {
    for (const { file, code } of verificationSources()) {
      expect({ file, hit: /approvedSha256/.test(code) }).toEqual({ file, hit: false });
    }
  });

  it('does not import canonical writers or Prisma PE-year write APIs', () => {
    const banned = [
      /ProgramElementWriterService/,
      /program-element-writer\.service/,
      /programElementYear\.(create|update|upsert|updateMany|createMany)/,
      /programElement\.create/,
      /programElement\.update/,
      /upsertProgramElement/,
      /upsertProgramElementYear/,
      /promotionReady/,
      /canonicalEligible/,
      /CANONICAL/,
      /PROMOTED/,
    ];
    for (const { file, code } of verificationSources()) {
      for (const pattern of banned) {
        expect({ file, hit: pattern.test(code) }).toEqual({ file, hit: false });
      }
    }
  });

  it('is not imported by any operational script', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(SCRIPTS_DIR)) {
      if (!name.endsWith('.ts')) continue;
      const code = stripComments(readFileSync(join(SCRIPTS_DIR, name), 'utf8'));
      if (/defense-budget\/verification/.test(code)) offenders.push(name);
    }
    // Phase 2 V1 CLI scripts import from the verification directory — those are allowed.
    // Filter out the approved V1 CLI scripts.
    const approvedV1 = new Set([
      'verify-defense-budget-extraction-v1.ts',
      'review-defense-budget-verification-v1.ts',
      'report-defense-budget-verification-cycle-v1.ts',
    ]);
    const real = offenders.filter((s) => !approvedV1.has(s));
    expect(real).toEqual([]);
  });

  it('V1 CLI scripts import no canonical writers (O4)', () => {
    const v1Scripts = [
      'verify-defense-budget-extraction-v1.ts',
      'review-defense-budget-verification-v1.ts',
      'report-defense-budget-verification-cycle-v1.ts',
    ];
    const banned = [
      /ProgramElementWriterService/,
      /program-element-writer\.service/,
      /programElementYear\.(create|update|upsert|updateMany|createMany)/,
      /programElement\.create/,
      /programElement\.update/,
      /upsertProgramElement/,
      /upsertProgramElementYear/,
      /promotionReady/,
      /canonicalEligible/,
    ];
    for (const name of v1Scripts) {
      const fullPath = join(SCRIPTS_DIR, name);
      if (!existsSync(fullPath)) continue;
      const code = stripComments(readFileSync(fullPath, 'utf8'));
      for (const pattern of banned) {
        expect({ file: name, hit: pattern.test(code) }).toEqual({ file: name, hit: false });
      }
    }
  });

  it('exposes no verification or promotion command in the entrypoint dispatcher', () => {
    const entrypoint = readFileSync(ENTRYPOINT, 'utf8');
    expect(entrypoint).not.toMatch(/structurally-validate/);
    expect(entrypoint).not.toMatch(/verify-budget-document/);
    expect(entrypoint).not.toMatch(/budget-verification/);
    expect(entrypoint).not.toMatch(/promote-budget/);
  });

  it('registers no scaffold provider in any Nest module', () => {
    const moduleFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.module.ts')) moduleFiles.push(full);
      }
    };
    walk('src');
    for (const file of moduleFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect({ file, hit: /BudgetVerification|structurallyValidateAndPersist/.test(code) }).toEqual(
        { file, hit: false },
      );
    }
  });
});
