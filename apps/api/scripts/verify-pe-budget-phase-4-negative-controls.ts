/**
 * Phase 4 mandatory mutate-fail-restore controls.
 *
 * Every control modifies the real local worktree, requires a named test/gate
 * to fail, restores the exact bytes, and requires the complete RDT&E suite to
 * return green at the end. No control is recorded as passed by assertion.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_ROOT = path.resolve(__dirname, '..');
const RDTE = path.join(API_ROOT, 'src', 'defense-budget', 'rdte');
const BASE_MIGRATION = path.join(
  API_ROOT,
  'prisma',
  'migrations',
  '20260817010000_rdte_phase4_projection_schema',
  'migration.sql',
);
const JEST_JS = path.join(API_ROOT, 'node_modules', 'jest', 'bin', 'jest.js');

interface ControlResult {
  id: number;
  description: string;
  detected: boolean;
  restored: boolean;
  detail: string;
}
interface ReplacementControl {
  id: number;
  description: string;
  file: string;
  original: string;
  defect: string;
  spec: string;
}

const results: ControlResult[] = [];

function runJest(spec: string): { passed: boolean; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [JEST_JS, '--ci', '--runInBand', '--forceExit', '--no-coverage', spec],
      { cwd: API_ROOT, stdio: 'pipe', timeout: 180_000, encoding: 'utf8' },
    );
    return { passed: true, output };
  } catch (error) {
    const value = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    return {
      passed: false,
      output: [value.stdout, value.stderr, value.message].filter(Boolean).map(String).join('\n'),
    };
  }
}

function whitespacePattern(value: string): RegExp {
  return new RegExp(
    value
      .replace(/\r\n/g, '\n')
      .split(/(\s+)/)
      .map((part) => (/^\s+$/.test(part) ? '\\s+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join(''),
  );
}

function runReplacement(control: ReplacementControl): void {
  const originalBytes = fs.readFileSync(control.file);
  try {
    const source = originalBytes.toString('utf8').replace(/\r\n/g, '\n');
    const pattern = whitespacePattern(control.original);
    if (!pattern.test(source)) {
      results.push({
        id: control.id,
        description: control.description,
        detected: false,
        restored: false,
        detail: `injection point missing in ${path.relative(API_ROOT, control.file)}`,
      });
      return;
    }
    fs.writeFileSync(
      control.file,
      source.replace(pattern, control.defect.replace(/\$/g, '$$$$')),
      'utf8',
    );
    const injected = runJest(control.spec);
    fs.writeFileSync(control.file, originalBytes);
    const restored = runJest(control.spec);
    results.push({
      id: control.id,
      description: control.description,
      detected: !injected.passed,
      restored: restored.passed,
      detail: !injected.passed
        ? restored.passed
          ? 'defect failed the gate and exact bytes restored green'
          : `defect detected but restored test failed: ${restored.output.slice(-1200)}`
        : `SAFETY GAP: injected defect passed: ${injected.output.slice(-1200)}`,
    });
  } finally {
    fs.writeFileSync(control.file, originalBytes);
  }
}

const CONTROLS: ReplacementControl[] = [
  {
    id: 1,
    description: 'Remove the R-1 unit requirement',
    file: path.join(RDTE, 'r1', 'r1-extractor-v1.ts'),
    original: "if (unitResolution.status !== 'resolved') {",
    defect: 'if (false) {',
    spec: 'src/defense-budget/rdte/r1/r1-extractor-v1.spec.ts',
  },
  {
    id: 2,
    description: 'Shift an R-1 FY header by one column',
    file: path.join(RDTE, 'r1', 'r1-extractor-v1.ts'),
    original:
      'columnRoles.set(column.columnIndex, classifyRdteColumn({ column, cycleFiscalYear }));',
    defect:
      'columnRoles.set(column.columnIndex + 1, classifyRdteColumn({ column, cycleFiscalYear }));',
    spec: 'src/defense-budget/rdte/r1/r1-extractor-v1.spec.ts',
  },
  {
    id: 3,
    description: 'Map an FYDP outyear to ProgramElementYear.request',
    file: path.join(RDTE, 'projection', 'rdte-projection-planner-v1.ts'),
    original:
      "if (columnRole === 'outyear_projection' || assertion.fiscalYear !== cycleFiscalYear) {",
    defect: 'if (false) {',
    spec: 'src/defense-budget/rdte/projection/rdte-projection-planner-v1.spec.ts',
  },
  {
    id: 4,
    description: 'Map contextual enacted history to a canonical target',
    file: path.join(RDTE, 'projection', 'rdte-projection-planner-v1.ts'),
    original: "if (disposition === 'contextual_only') {",
    defect: 'if (false) {',
    spec: 'src/defense-budget/rdte/gates/rdte-negative-control-probes-v1.spec.ts',
  },
  {
    id: 5,
    description: 'Treat a repeated R-1 header as a PE row',
    file: path.join(RDTE, 'r1', 'r1-table-detector.ts'),
    original: 'if (HEADER_HINT_RE.test(rowText) && !PE_CODE_CELL_RE.test(firstText)) {',
    defect: 'if (false) {',
    spec: 'src/defense-budget/rdte/r1/r1-extractor-v1.spec.ts',
  },
  {
    id: 6,
    description: 'Allow R-2 narrative continuation to bleed across PEs',
    file: path.join(RDTE, 'r2', 'r2-exhibit-segmenter.ts'),
    original: 'const continuationEvidence: string[] = [];',
    defect: "const continuationEvidence: string[] = ['R-2 header present'];",
    spec: 'src/defense-budget/rdte/r2/r2-segmentation.spec.ts',
  },
  {
    id: 7,
    description: 'Allow an R-2A project without a valid parent PE',
    file: path.join(RDTE, 'r2a', 'r2a-project-extractor-v1.ts'),
    original: 'if (!isValidPeCode(parentPeCode)) {',
    defect: 'if (false) {',
    spec: 'src/defense-budget/rdte/r2a/r2a-project-extractor-v1.spec.ts',
  },
  {
    id: 8,
    description: 'Make an R-2A money fact optional',
    file: path.join(RDTE, 'r2a', 'r2a-artifact-builder-v1.ts'),
    original: "category: 'money',\n        requiredForCompleteness: true,",
    defect: "category: 'money',\n        requiredForCompleteness: false,",
    spec: 'src/defense-budget/rdte/gates/rdte-negative-control-probes-v1.spec.ts',
  },
  {
    id: 9,
    description: 'Disable R-2 total to R-2A project-sum reconciliation',
    file: path.join(RDTE, 'cycle', 'rdte-cycle-pipeline-v1.ts'),
    original: 'projectSumReconciliations: projectSums,',
    defect: 'projectSumReconciliations: [],',
    spec: 'src/defense-budget/rdte/cycle/rdte-cycle-pipeline-v1.spec.ts',
  },
  {
    id: 10,
    description: 'Replace printed-unit tolerance with fixed 0.1',
    file: path.join(RDTE, 'rdte-rounding-policy-v1.ts'),
    original:
      'const halfUnits = nPlusOne % 2 === 0 ? String(nPlusOne / 2) : `${Math.floor(nPlusOne / 2)}.5`;',
    defect: "const halfUnits = '0.1';",
    spec: 'src/defense-budget/rdte/rdte-contracts.spec.ts',
  },
  {
    id: 11,
    description: 'Default company-looking R-3 rows to PRIME_CONTRACTOR',
    file: path.join(RDTE, 'r3', 'r3-role-classifier.ts'),
    original: "return { role: 'PERFORMING_ACTIVITY', explicit: false, evidence: performerText };",
    defect: "return { role: 'PRIME_CONTRACTOR', explicit: false, evidence: performerText };",
    spec: 'src/defense-budget/rdte/r3/r3-extractor-v1.spec.ts',
  },
  {
    id: 12,
    description: 'Leak R-3 total cost into annual PE funding',
    file: path.join(RDTE, 'r3', 'r3-artifact-builder-v1.ts'),
    original: '/* Conflicting rows: blocking warnings, never last-wins. */',
    defect:
      'for (const performer of result.performers) {\n' +
      '  if (performer.totalCost && performer.fiscalYear) {\n' +
      "    builder.addAssertion({ assertionKind: 'funding', assertionId: `defect_${performer.naturalKey}`, sourceFactIds: [], evidenceIds: [], confidence: 1, identity: { lineKind: 'RDTE_PE', peCode: performer.parentPeCode }, fiscalYear: performer.fiscalYear, field: 'request', money: performer.totalCost });\n" +
      '  }\n' +
      '}\n' +
      '/* Conflicting rows: blocking warnings, never last-wins. */',
    spec: 'src/defense-budget/rdte/gates/rdte-negative-control-probes-v1.spec.ts',
  },
  {
    id: 13,
    description: 'Fabricate January 1 for a fiscal-quarter milestone',
    file: path.join(RDTE, 'r4', 'r4-schedule-period-v1.ts'),
    original:
      "return {\n      kind: 'fiscal_quarter',\n      rawText: text,\n      fiscalYear: fy,\n      fiscalQuarter: q,\n      confidence: 0.9,\n    };",
    defect:
      "return { kind: 'fiscal_quarter', rawText: text, exactDate: `${fy}-01-01`, fiscalYear: fy, fiscalQuarter: q, confidence: 0.9 };",
    spec: 'src/defense-budget/rdte/r4/r4-extractor-v1.spec.ts',
  },
  {
    id: 14,
    description: 'Project a NEEDS_REVIEW artifact',
    file: path.join(RDTE, 'projection', 'rdte-projection-planner-v1.ts'),
    original:
      "if (\n      verification.decision === 'NEEDS_REVIEW' &&\n      !input.allowedReviewedAcceptances?.has(verification.decisionId)\n    ) {",
    defect: 'if (false) {',
    spec: 'src/defense-budget/rdte/projection/rdte-projection-planner-v1.spec.ts',
  },
  {
    id: 15,
    description: 'Restore last-wins projection duplicate handling',
    file: path.join(RDTE, 'projection', 'rdte-projection-planner-v1.ts'),
    original:
      "result.push({\n        ...candidate,\n        operation: 'conflict',\n        exclusionReason: 'duplicate_conflict',\n      });",
    defect: "result.push({ ...candidate, operation: 'insert' });",
    spec: 'src/defense-budget/rdte/projection/rdte-projection-planner-v1.spec.ts',
  },
  {
    id: 16,
    description: 'Ignore a missing required manifest document',
    file: path.join(RDTE, 'reconciliation', 'rdte-cycle-certifier-v1.ts'),
    original: 'if (!source) {',
    defect: 'if (false) {',
    spec: 'src/defense-budget/rdte/reconciliation/rdte-cycle-reconciler-v1.spec.ts',
  },
  {
    id: 19,
    description: 'Truncate an R-2A project code',
    file: path.join(RDTE, 'r2a', 'r2a-project-extractor-v1.ts'),
    original: 'info.projectCode = codeMatch[1];',
    defect: 'info.projectCode = codeMatch[1].slice(0, 3);',
    spec: 'src/defense-budget/rdte/r2a/r2a-project-extractor-v1.spec.ts',
  },
];

function runProbe(id: number, description: string, file: string, content: string): void {
  try {
    fs.writeFileSync(file, content, 'utf8');
    const injected = runJest('src/defense-budget/rdte/gates/rdte-phase4-gates-v1.spec.ts');
    results.push({
      id,
      description,
      detected: !injected.passed,
      restored: true,
      detail: !injected.passed ? 'architecture gate rejected probe' : 'SAFETY GAP: probe passed',
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function runMigrationControl(): void {
  const originalBytes = fs.readFileSync(BASE_MIGRATION);
  try {
    const source = originalBytes.toString('utf8');
    const original = 'CREATE UNIQUE INDEX "program_element_project_budget_position_natural_key"';
    if (!source.includes(original)) {
      results.push({
        id: 20,
        description: 'Remove project-position natural-key uniqueness',
        detected: false,
        restored: false,
        detail: 'migration injection point missing',
      });
      return;
    }
    fs.writeFileSync(
      BASE_MIGRATION,
      source.replace(
        original,
        'CREATE INDEX "program_element_project_budget_position_natural_key"',
      ),
      'utf8',
    );
    const injected = runJest(
      'src/defense-budget/rdte/gates/rdte-negative-control-probes-v1.spec.ts',
    );
    fs.writeFileSync(BASE_MIGRATION, originalBytes);
    const restored = runJest(
      'src/defense-budget/rdte/gates/rdte-negative-control-probes-v1.spec.ts',
    );
    results.push({
      id: 20,
      description: 'Remove project-position natural-key uniqueness',
      detected: !injected.passed,
      restored: restored.passed,
      detail: !injected.passed
        ? restored.passed
          ? 'migration defect detected and restored green'
          : 'migration restored but gate remained red'
        : 'SAFETY GAP: migration defect passed',
    });
  } finally {
    fs.writeFileSync(BASE_MIGRATION, originalBytes);
  }
}

function main(): void {
  const preflight = runJest('src/defense-budget/rdte/gates/rdte-phase4-gates-v1.spec.ts');
  if (!preflight.passed) {
    console.error(`negative-control runner preflight failed:\n${preflight.output.slice(-2000)}`);
    process.exit(2);
  }
  CONTROLS.forEach(runReplacement);
  runProbe(
    17,
    'Import ProgramElementWriterService',
    path.join(RDTE, '__nc17_writer_probe.ts'),
    "import { ProgramElementWriterService } from '../../../program-element/program-element-writer.service.js';\nexport const probe = ProgramElementWriterService;\n",
  );
  runProbe(
    18,
    'Add a Prisma canonical upsert',
    path.join(RDTE, 'projection', '__nc18_upsert_probe.ts'),
    'export async function probe(prisma: any) { return prisma.programElementProjectBudgetPosition.upsert({}); }\n',
  );
  runMigrationControl();

  const final = runJest('src/defense-budget/rdte');
  const failed = results.filter((result) => !result.detected || !result.restored);
  console.log(
    JSON.stringify(
      {
        controls: results.sort((left, right) => left.id - right.id),
        finalRdteSuiteGreen: final.passed,
        allControlsDetected: failed.length === 0 && results.length === 20 && final.passed,
        ...(!final.passed ? { finalFailure: final.output.slice(-2000) } : {}),
      },
      null,
      2,
    ),
  );
  process.exit(failed.length === 0 && results.length === 20 && final.passed ? 0 : 1);
}

main();
