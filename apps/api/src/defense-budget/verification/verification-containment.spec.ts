import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const VERIFICATION_DIR = 'src/defense-budget/verification';
const SCRIPTS_DIR = 'scripts';
const ENTRYPOINT = 'scripts/entrypoint-dispatcher.inc';

/** Strip line + block comments so comment-documented words never false-positive. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function verificationSources(): Array<{ file: string; code: string }> {
  return readdirSync(VERIFICATION_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .map((name) => ({
      file: name,
      code: stripComments(readFileSync(join(VERIFICATION_DIR, name), 'utf8')),
    }));
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
      /@prisma\/client/,
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
    expect(offenders).toEqual([]);
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
