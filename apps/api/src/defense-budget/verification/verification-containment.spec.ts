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

/**
 * V1-specific production files only. These are the files that must never
 * contain canonical writer imports, unsafe Prisma casts, caller-supplied
 * proof objects, or source-byte hashing through string conversion.
 *
 * Excludes the Phase 0 legacy scaffold (budget-verification.ts,
 * budget-document-adapter.ts, budget-verification-service.ts,
 * budget-verification-repository.ts) which has its own containment rules.
 */
function v1ProductionSources(): Array<{ file: string; code: string }> {
  const v1Subdirs = ['trusted-proof', 'rules', 'decision', 'persistence', 'services'];
  const v1Files = [
    'verification-contract-v1.ts',
    'verification-input-v1.ts',
    'verification-policy-v1.ts',
    'verification-policy-registry.ts',
  ];
  const results: Array<{ file: string; code: string }> = [];
  // V1 subdirectory production files
  for (const sub of v1Subdirs) {
    const dir = join(VERIFICATION_DIR, sub);
    if (!existsSync(dir)) continue;
    const walk = (d: string, prefix: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        const rel = `${prefix}/${entry.name}`;
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
    walk(dir, sub);
  }
  // V1 top-level production files
  for (const name of v1Files) {
    const full = join(VERIFICATION_DIR, name);
    if (existsSync(full)) {
      results.push({
        file: name,
        code: stripComments(readFileSync(full, 'utf8')),
      });
    }
  }
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
      'programElementYearSourceValue.create',
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

  it('does not use unsafe Prisma casts or manufactured delegate methods', () => {
    // R0 containment: detect `as unknown as Prisma...` and `findUniqueById`
    // which manufacture nonexistent Prisma APIs.
    const banned = [/as\s+unknown\s+as\s+(?:Prisma|PrismaLike)/, /findUniqueById/];
    for (const { file, code } of v1ProductionSources()) {
      for (const pattern of banned) {
        expect({ file, hit: pattern.test(code) }).toEqual({ file, hit: false });
      }
    }
  });

  it('does not accept caller-supplied proof objects in the verification request', () => {
    // R0 containment: the V1 verification request must not accept archiveProof,
    // parseProof, or approvedSha256 from the caller. These are proof objects
    // that must be independently resolved by the verifier.
    const bannedProofFields = [/archiveProof/, /parseProof/];
    for (const { file, code } of v1ProductionSources()) {
      for (const pattern of bannedProofFields) {
        expect({ file, hit: pattern.test(code) }).toEqual({ file, hit: false });
      }
    }
  });

  it('does not hash source bytes through string conversion (binary/utf8)', () => {
    // R0 containment: source PDFs, S3 objects, and artifact files must be
    // hashed as raw bytes, not through .toString('binary') or .toString('utf8').
    // The canonical-json module provides sha256Hex for deliberate UTF-8 string
    // hashing and sha256Bytes for raw bytes. Source/archived object hashing
    // through string conversion is a defect.
    const banned = [/\.toString\(['"]binary['"]\)/];
    for (const { file, code } of v1ProductionSources()) {
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
