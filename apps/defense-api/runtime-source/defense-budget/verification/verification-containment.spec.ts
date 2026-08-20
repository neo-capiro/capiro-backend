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

function v1ProductionSources(): Array<{ file: string; code: string }> {
  const v1Subdirs = ['trusted-proof', 'rules', 'decision', 'persistence', 'services'];
  const v1Files = [
    'verification-contract-v1.ts',
    'verification-input-v1.ts',
    'verification-policy-v1.ts',
    'verification-policy-registry.ts',
    'authority-policy-resolution.ts',
  ];
  const results: Array<{ file: string; code: string }> = [];
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
  for (const name of v1Files) {
    const full = join(VERIFICATION_DIR, name);
    if (existsSync(full)) {
      results.push({ file: name, code: stripComments(readFileSync(full, 'utf8')) });
    }
  }
  return results;
}

const APPROVED_VERIFICATION_OPERATOR_SCRIPTS = new Set([
  'verify-defense-budget-extraction-v1.ts',
  'review-defense-budget-verification-v1.ts',
  'report-defense-budget-verification-cycle-v1.ts',
  'rehearse-budget-verification-v1.ts',
  'extract-defense-budget-cycle.ts',
  'build-rdte-cycle.ts',
  'verify-defense-budget-non-rdte.ts',
  'certify-defense-budget-non-rdte.ts',
  'plan-defense-budget-non-rdte-projection.ts',
  // Phase 7 Gap 5 decision 1. Non-promoting by construction: it writes only
  // `family` and `extraction_method` on `budget_extraction_candidate_v1`, an
  // audit table, and refuses `--promote` outright. Listed here rather than
  // exempted from the rule, so the "approved operators import no canonical
  // writers" check below covers it too.
  'backfill-budget-candidate-source-metadata-v1.ts',
]);

const CANONICAL_WRITER_PATTERNS = [
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

const VERIFICATION_IMPORT_PATTERN =
  /(?:from\s*|import\s*\(\s*|import\s*)['"][^'"]*defense-budget\/verification/;

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
    const banned = [...CANONICAL_WRITER_PATTERNS, /CANONICAL/, /PROMOTED/];
    for (const { file, code } of verificationSources()) {
      for (const pattern of banned) {
        expect({ file, hit: pattern.test(code) }).toEqual({ file, hit: false });
      }
    }
  });

  it('does not use unsafe Prisma casts or manufactured delegate methods', () => {
    const banned = [/as\s+unknown\s+as\s+(?:Prisma|PrismaLike)/, /findUniqueById/];
    for (const { file, code } of v1ProductionSources()) {
      for (const pattern of banned) {
        expect({ file, hit: pattern.test(code) }).toEqual({ file, hit: false });
      }
    }
  });

  it('does not accept caller-supplied proof objects in the verification request', () => {
    const requestFile = join(VERIFICATION_DIR, 'verification-contract-v1.ts');
    const requestInputFile = join(VERIFICATION_DIR, 'verification-input-v1.ts');
    const bannedProofFields = [/\barchiveProof\b/, /\bparseProof\b/];
    for (const filePath of [requestFile, requestInputFile]) {
      if (!existsSync(filePath)) continue;
      const code = stripComments(readFileSync(filePath, 'utf8'));
      for (const pattern of bannedProofFields) {
        expect({ file: filePath, hit: pattern.test(code) }).toEqual({
          file: filePath,
          hit: false,
        });
      }
    }
  });

  it('does not hash source bytes through string conversion', () => {
    const banned = [/\.toString\(['"]binary['"]\)/];
    for (const { file, code } of v1ProductionSources()) {
      for (const pattern of banned) {
        expect({ file, hit: pattern.test(code) }).toEqual({ file, hit: false });
      }
    }
  });

  it('is imported only by named non-promoting operator scripts', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(SCRIPTS_DIR)) {
      if (!name.endsWith('.ts')) continue;
      const code = stripComments(readFileSync(join(SCRIPTS_DIR, name), 'utf8'));
      if (VERIFICATION_IMPORT_PATTERN.test(code)) offenders.push(name);
    }
    const real = offenders.filter((script) => !APPROVED_VERIFICATION_OPERATOR_SCRIPTS.has(script));
    expect(real).toEqual([]);
  });

  it('approved verification operators import no canonical writers', () => {
    for (const name of APPROVED_VERIFICATION_OPERATOR_SCRIPTS) {
      const fullPath = join(SCRIPTS_DIR, name);
      if (!existsSync(fullPath)) continue;
      const code = stripComments(readFileSync(fullPath, 'utf8'));
      for (const pattern of CANONICAL_WRITER_PATTERNS) {
        expect({ file: name, hit: pattern.test(code) }).toEqual({
          file: name,
          hit: false,
        });
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
