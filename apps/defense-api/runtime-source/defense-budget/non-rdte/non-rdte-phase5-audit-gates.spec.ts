import * as fs from 'node:fs';
import * as path from 'node:path';

const API_ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_ROOT = path.join(API_ROOT, 'src', 'defense-budget');
const MIGRATION = path.join(
  API_ROOT,
  'prisma',
  'migrations',
  '20260818030000_non_rdte_phase5_projection_schema',
  'migration.sql',
);

function read(relative: string): string {
  return fs.readFileSync(path.join(API_ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function importStatements(source: string): string {
  const stripped = stripComments(source);
  /* The clause body is restricted to characters an import clause can actually
   * contain. With `[\s\S]*?` the match ran past the end of one concatenated
   * file and swallowed unrelated code until it found the next `from '...'`,
   * which made these gates report the banned-symbol regex literal in
   * non-rdte-phase5-gates-v1.ts as though it were a real import. A genuine
   * `import { ProgramElementWriterService } from '...'` still matches. */
  const staticImports =
    stripped.match(/\bimport\s+(?:type\s+)?[\w$*{},\s]*?\s+from\s+['"][^'"]+['"]\s*;?/g) ?? [];
  const sideEffectImports = stripped.match(/\bimport\s+['"][^'"]+['"]\s*;?/g) ?? [];
  const dynamicImports = stripped.match(/\bimport\s*\(\s*['"][^'"]+['"]\s*\)/g) ?? [];
  const requires = stripped.match(/\brequire\s*\(\s*['"][^'"]+['"]\s*\)/g) ?? [];
  return [...staticImports, ...sideEffectImports, ...dynamicImports, ...requires].join('\n');
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

function productionPhase5Source(): string {
  const roots = [
    path.join(SRC_ROOT, 'non-rdte'),
    path.join(SRC_ROOT, 'procurement'),
    path.join(SRC_ROOT, 'om'),
    path.join(SRC_ROOT, 'milcon'),
  ];
  return stripComments(
    roots
      .flatMap(walk)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n'),
  );
}

function commandSource(): string {
  return stripComments(
    [
      'scripts/inspect-defense-budget-non-rdte.ts',
      'scripts/extract-defense-budget-non-rdte.ts',
      'scripts/verify-defense-budget-non-rdte.ts',
      'scripts/certify-defense-budget-non-rdte.ts',
      'scripts/plan-defense-budget-non-rdte-projection.ts',
    ]
      .map(read)
      .join('\n'),
  );
}

function operatorSource(): string {
  return `${commandSource()}\n${stripComments(
    read('scripts/lib/non-rdte-phase5-operator-lib.ts'),
  )}`;
}

describe('Phase 5 permanent audit gates', () => {
  it('NC01 — P-40 PE references remain relationships, never RDTE identities', () => {
    const source = stripComments(
      read('src/defense-budget/non-rdte/p40/p40-artifact-builder-v1.ts'),
    );
    expect(source).toContain("assertionKind: 'relationship'");
    expect(source).not.toContain("assertionKind: 'program_element_identity'");
    expect(source).not.toContain('__phase5Nc01');
  });

  it('NC02 — procurement short-line identity includes account context', () => {
    const source = read('src/defense-budget/non-rdte/identity-v1.ts');
    expect(source).toContain(
      'PROCUREMENT_BLIN:${input.component}:${normalizedAccount}:${normalizedCode}',
    );
    expect(source).not.toContain('PROCUREMENT_BLIN:${input.component}:${normalizedCode}:');
  });

  it('NC03 — base and advance procurement remain distinct', () => {
    const source = read('src/defense-budget/non-rdte/identity-v1.ts');
    expect(source).toContain("advanceProcurement ? 'advance' : 'base'");
    expect(source).not.toContain("const __phase5BaseAdvance = 'base'");
  });

  it('NC04 — printed units are never inferred by magnitude', () => {
    const source = productionPhase5Source();
    expect(source).not.toMatch(/inferUnitByMagnitude|Math\.abs\([^)]*\)\s*[><=]+\s*1_?000/);
  });

  it('NC05 — fractional quantities are never silently truncated', () => {
    expect(productionPhase5Source()).not.toMatch(
      /Math\.trunc\([^)]*quantity|parseInt\([^)]*quantity/i,
    );
  });

  it('NC06 — missing comparison cannot be represented as PASS', () => {
    const source = [
      read('src/defense-budget/procurement/procurement-reconciliation-v1.ts'),
      read('src/defense-budget/om/om-reconciliation-v1.ts'),
      read('src/defense-budget/milcon/milcon-reconciliation-v1.ts'),
    ].join('\n');
    expect(source).not.toContain("missingComparisonOutcome: 'PASS'");
    expect(source).toMatch(/not_run|NOT_RUN|missing/i);
  });

  it('NC07 — unit scaling remains explicit exact decimal logic', () => {
    const source = stripComments(read('src/defense-budget/non-rdte/unit-semantics-v1.ts'));
    expect(source).not.toMatch(/parseFloat\s*\(/);
    // Number(singleDigit) is used only to add/subtract decimal characters exactly.
    // Whole-value coercion would reintroduce binary floating-point semantics.
    expect(source).not.toMatch(/Number\s*\(\s*['"][+-]?\d+(?:\.\d+)?['"]\s*\)/);
    expect(source).not.toMatch(/Number\s*\(\s*(?:value|rawValue|canonical|amount|quantity)\b/);
    expect(source).toMatch(/thousands|millions/);
  });

  it('NC08 — quantity-times-unit-cost is not universally blocking', () => {
    const source = read('src/defense-budget/non-rdte/p40/p40-extractor-v1.ts');
    expect(source).toMatch(/applicable/i);
    expect(source).not.toContain('const __phase5UniversalArithmetic = true');
  });

  it('NC09 — O-1 identities remain OM_SAG', () => {
    const source = stripComments(read('src/defense-budget/non-rdte/o1/o1-artifact-builder-v1.ts'));
    expect(source).toContain("lineKind: 'OM_SAG'");
    expect(source).not.toContain("lineKind: 'PROCUREMENT_BLIN'");
  });

  it('NC10 — O&M identity includes account context', () => {
    const source = read('src/defense-budget/non-rdte/identity-v1.ts');
    expect(source).toContain('OM_SAG:${input.component}:${normalizedAccount}:${normalizedCode}');
    expect(source).not.toContain('OM_SAG:${input.component}:${normalizedCode}');
  });

  it('NC11 — OP-5 prose cannot manufacture money assertions', () => {
    const source = read('src/defense-budget/non-rdte/op5/op5-extractor-v1.ts');
    expect(source).not.toMatch(/narrativePercent(?:age)?ToMoney|moneyFromNarrative/i);
  });

  it('NC12 — MILCON certification uses account-complete native identity, not title matching', () => {
    const source = read('src/defense-budget/milcon/proof-bound-milcon-composer-v1.ts');
    expect(source).toContain('buildPhase5MilconNativeIdentityV1');
    expect(source).toContain('accountByDocumentKey');
    expect(source).not.toMatch(/fuzzyTitle|titleSimilarity|matchByTitle/);
  });

  it('NC13 — low-confidence DD1391 OCR cannot auto-pass', () => {
    const source = [
      read('src/defense-budget/milcon/milcon-verification-policy-v1.ts'),
      read('src/defense-budget/non-rdte/non-rdte-projection-planner-v1.ts'),
    ].join('\n');
    expect(source).toMatch(/ocr.*review|review.*ocr/i);
    expect(source).not.toContain('const __phase5OcrAutoPass = true');
  });

  it('NC14 — DD1391 cost categories remain explicit facts', () => {
    const source = read('src/defense-budget/non-rdte/dd1391/dd1391-artifact-builder-v1.ts');
    expect(source).toMatch(/costCategory/);
    expect(source).not.toContain('const __phase5DropCostCategories = true');
  });

  it('NC15 — required missing detail prevents cycle certification', () => {
    const source = read('src/defense-budget/non-rdte/non-rdte-cycle-certifier-v1.ts');
    expect(source).toMatch(/missing|required|INCOMPLETE/i);
    expect(source).not.toContain('const __phase5CertifyMissingDetail = true');
  });

  it('NC16 — parser-result SHA and evidence-page proof are mandatory', () => {
    const source = read('src/defense-budget/non-rdte/non-rdte-proof-bound-artifact-v1.ts');
    expect(source).toContain('verifyResultContentSha256');
    expect(source).toContain('evidence_page_not_covered');
    expect(source).not.toContain('const __phase5TrustCallerParserSha = true');
  });

  it('NC17 — Phase 5 commands expose no paid parser bypass', () => {
    const source = operatorSource();
    expect(source).not.toMatch(/allow-paid|allow-vendor|LLAMA_CLOUD_API_KEY|LlamaParseClient/);
    expect(source).toContain('paidParserCalls: false');
  });

  it('NC18 — canonical writers remain absent from all Phase 5 paths', () => {
    const imports = importStatements(`${productionPhase5Source()}\n${operatorSource()}`);
    expect(imports).not.toMatch(
      /ProgramElementWriterService|program-element-writer\.service|program-element-writer/,
    );
  });

  it('NC19 — projection requires exact accepted assertion ledgers', () => {
    const source = read(
      'src/defense-budget/non-rdte/non-rdte-proof-bound-projection-planner-v1.ts',
    );
    expect(source).toContain('verificationResultsByRunId');
    expect(source).toContain('acceptedAssertionIds');
    expect(source).toContain('verification_assertion_unknown');
    expect(source).not.toContain('const __phase5RawArtifactProjection = true');
  });

  it('NC20 — Phase 5 operators and projection execute no Prisma DML', () => {
    const source = `${operatorSource()}\n${stripComments(
      read('src/defense-budget/non-rdte/non-rdte-proof-bound-projection-planner-v1.ts'),
    )}`;
    const imports = importStatements(source);
    expect(imports).not.toMatch(/@prisma\/client|prisma\.service/);
    expect(source).not.toMatch(
      /\b(?:prisma|tx|db)\s*\.\s*[A-Za-z_$][\w$]*\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
    expect(source).not.toMatch(/\$executeRaw|\$queryRawUnsafe/);
    expect(commandSource()).not.toContain('--commit');
    const guard = read('scripts/lib/non-rdte-phase5-operator-lib.ts');
    expect(guard).toContain("argv.includes('--commit')");
    expect(guard).toContain('Phase 5 has no --commit or promotion mode');
  });

  it('native schema is additive, proof-bound, and separate from program_element', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    expect(sql).toContain('CREATE TABLE "procurement_budget_line"');
    expect(sql).toContain('CREATE TABLE "om_sag"');
    expect(sql).toContain('CREATE TABLE "milcon_project"');
    expect(sql).toContain('CREATE TABLE "non_rdte_budget_line_source_observation"');
    expect(sql).toContain('CREATE TABLE "non_rdte_budget_line_relationship"');
    expect(sql).toContain('NUMERIC(20,6)');
    expect(sql).toContain('verification_run_id');
    expect(sql).toContain('jsonb_array_length("evidence_ids_jsonb") > 0');
    expect(sql).not.toMatch(/REFERENCES\s+"program_element"/);
    expect(sql).not.toMatch(/^\s*(?:UPDATE|DELETE|INSERT\s+INTO)\b/im);
  });
});
