/**
 * verify-pe-budget-phase-4-negative-controls — the 20 mandatory defect
 * injections (Phase 4 plan §19).
 *
 * Each control:
 *   1. injects the defect into a COPY-tracked production file;
 *   2. runs the exact relevant test, which MUST FAIL (defect detected);
 *   3. reverts the defect;
 *   4. records the evidence.
 *
 * A final full rdte suite run confirms every revert restored green.
 * Exit 0 when all 20 controls detect their defect, 1 otherwise.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const API_ROOT = path.resolve(__dirname, '..');
const RDTE = path.join(API_ROOT, 'src', 'defense-budget', 'rdte');
const MIGRATION = path.join(
  API_ROOT,
  'prisma',
  'migrations',
  '20260817010000_rdte_phase4_projection_schema',
  'migration.sql',
);

interface ControlResult {
  id: number;
  description: string;
  detected: boolean;
  detail: string;
}

const results: ControlResult[] = [];

/* Resolve the package-local jest entry and run it with the current node
 * binary. Spawning bare 'npx' is unreliable on Windows/MSYS (ENOENT), and
 * spawning jest.cmd directly is blocked by Node's .cmd spawn restriction
 * (EINVAL without shell:true). Either failure mode would silently count
 * every control as 'detected' — hence the preflight below. */
const JEST_JS = path.join(API_ROOT, 'node_modules', 'jest', 'bin', 'jest.js');

function runJest(specPattern: string): { passed: boolean; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [JEST_JS, '--ci', '--runInBand', '--forceExit', '--no-coverage', specPattern],
      { cwd: API_ROOT, stdio: 'pipe', timeout: 180_000 },
    ).toString();
    return { passed: true, output };
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const output = [
      (err.stdout ?? Buffer.from('')).toString(),
      (err.stderr ?? Buffer.from('')).toString(),
      err.message ?? '',
    ].join('\n');
    return { passed: false, output };
  }
}

interface ReplacementControl {
  id: number;
  description: string;
  file: string;
  original: string;
  defect: string;
  spec: string;
}

function runReplacementControl(control: ReplacementControl): void {
  const backup = `${control.file}.nc-bak`;
  try {
    fs.copyFileSync(control.file, backup);
    const raw = fs.readFileSync(control.file, 'utf8');
    const hadCrlf = raw.includes('\r\n');
    /* Normalize to LF for matching (files may be CRLF on this worktree). */
    const content = raw.replace(/\r\n/g, '\n');
    const original = control.original.replace(/\r\n/g, '\n');
    const defect = control.defect.replace(/\r\n/g, '\n');
    /* Whitespace-tolerant matching: prettier reflows long lines and wraps
     * object literals, so anchors must match across whitespace variations.
     * Build a regex from the anchor where every whitespace run becomes \s+
     * and all other characters are escaped literally. */
    const anchorPattern = original
      .split(/(\s+)/)
      .map((part) => (/^\s+$/.test(part) ? '\\s+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    const anchorRe = new RegExp(anchorPattern);
    if (!anchorRe.test(content)) {
      results.push({
        id: control.id,
        description: control.description,
        detected: false,
        detail: `injection point not found in ${path.relative(API_ROOT, control.file)}`,
      });
      return;
    }
    let defected = content.replace(anchorRe, defect.replace(/\$/g, '$$$$'));
    if (hadCrlf) defected = defected.replace(/\n/g, '\r\n');
    fs.writeFileSync(control.file, defected, 'utf8');
    const { passed } = runJest(control.spec);
    results.push({
      id: control.id,
      description: control.description,
      detected: !passed,
      detail: !passed ? 'defect detected (test failed as required)' : 'SAFETY GAP: test passed',
    });
  } finally {
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, control.file);
      fs.unlinkSync(backup);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Controls 1-16, 19: source defects                                   */
/* ------------------------------------------------------------------ */

const CONTROLS: ReplacementControl[] = [
  {
    id: 1,
    description: 'Remove R-1 unit requirement',
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
    description: 'Map an outyear to ProgramElementYear.request',
    file: path.join(RDTE, 'projection', 'rdte-projection-planner-v1.ts'),
    original:
      "if (columnRole === 'outyear_projection' || assertion.fiscalYear !== cycleFiscalYear) {",
    defect: 'if (false) {',
    spec: 'src/defense-budget/rdte/projection/rdte-projection-planner-v1.spec.ts',
  },
  {
    id: 4,
    description: 'Map historical enacted context to canonical stages',
    file: path.join(RDTE, 'projection', 'rdte-projection-planner-v1.ts'),
    original: "if (disposition === 'contextual_only') {",
    defect: 'if (false) {',
    spec: 'src/defense-budget/rdte/gates/rdte-negative-control-probes-v1.spec.ts',
  },
  {
    id: 5,
    description: 'Treat repeated header as PE row',
    file: path.join(RDTE, 'r1', 'r1-table-detector.ts'),
    original: 'if (HEADER_HINT_RE.test(rowText) && !PE_CODE_CELL_RE.test(firstText)) {',
    defect: 'if (false) {',
    spec: 'src/defense-budget/rdte/r1/r1-extractor-v1.spec.ts',
  },
  {
    id: 6,
    description: 'Allow R-2 narrative to bleed into the next PE',
    file: path.join(RDTE, 'r2', 'r2-exhibit-segmenter.ts'),
    original: 'const continuationEvidence: string[] = [];',
    defect: "const continuationEvidence: string[] = ['R-2 header present'];",
    spec: 'src/defense-budget/rdte/r2/r2-segmentation.spec.ts',
  },
  {
    id: 7,
    description: 'Allow R-2A project without parent PE',
    file: path.join(RDTE, 'r2a', 'r2a-project-extractor-v1.ts'),
    original: 'if (!isValidPeCode(parentPeCode)) {',
    defect: 'if (false) {',
    spec: 'src/defense-budget/rdte/r2a/r2a-project-extractor-v1.spec.ts',
  },
  {
    id: 8,
    description: 'Drop one project money fact silently',
    file: path.join(RDTE, 'r2a', 'r2a-artifact-builder-v1.ts'),
    original: "        category: 'money',\n        requiredForCompleteness: true,",
    defect: "        category: 'money',\n        requiredForCompleteness: false,",
    spec: 'src/defense-budget/rdte/gates/rdte-negative-control-probes-v1.spec.ts',
  },
  {
    id: 9,
    description: 'Disable project-sum reconciliation',
    file: path.join(RDTE, 'cycle', 'rdte-cycle-pipeline-v1.ts'),
    original: 'projectSumResults.push(reconcileR2aProjectColumn(columnInput));',
    defect: 'void columnInput; /* project-sum reconciliation disabled */',
    spec: 'src/defense-budget/rdte/cycle/rdte-cycle-pipeline-v1.spec.ts',
  },
  {
    id: 10,
    description: 'Replace unit-based tolerance with a fixed 0.1-unit tolerance',
    file: path.join(RDTE, 'rdte-rounding-policy-v1.ts'),
    original:
      'const halfUnits = nPlusOne % 2 === 0 ? String(nPlusOne / 2) : `${Math.floor(nPlusOne / 2)}.5`;',
    defect: "const halfUnits = '0.1';",
    /* The contracts spec pins the exact (N+1)*0.5 tolerance table; the R-2A
     * extractor spec alone cannot detect a STRICTER tolerance. */
    spec: 'src/defense-budget/rdte/rdte-contracts.spec.ts',
  },
  {
    id: 11,
    description: 'Default all R-3 company-looking rows to PRIME_CONTRACTOR',
    file: path.join(RDTE, 'r3', 'r3-role-classifier.ts'),
    original: "return { role: 'PERFORMING_ACTIVITY', explicit: false, evidence: performerText };",
    defect: "return { role: 'PRIME_CONTRACTOR', explicit: false, evidence: performerText };",
    spec: 'src/defense-budget/rdte/r3/r3-extractor-v1.spec.ts',
  },
  {
    id: 12,
    description: 'Treat R-3 total cost as PE annual funding',
    file: path.join(RDTE, 'r3', 'r3-artifact-builder-v1.ts'),
    original: '    /* Conflicting rows: blocking warnings, never last-wins. */',
    defect:
      '    /* DEFECT: total cost leaked as annual funding. */\n' +
      '    for (const performer of result.performers) {\n' +
      '      if (performer.totalCost != null && performer.fiscalYear != null) {\n' +
      '        builder.addAssertion({\n' +
      "          assertionKind: 'funding',\n" +
      '          assertionId: `defect_funding_${performer.naturalKey}`,\n' +
      '          sourceFactIds: [],\n' +
      '          evidenceIds: [],\n' +
      '          confidence: 1,\n' +
      "          identity: { lineKind: 'RDTE_PE', peCode: performer.parentPeCode },\n" +
      '          fiscalYear: performer.fiscalYear,\n' +
      "          field: 'request',\n" +
      '          money: {\n' +
      '            originalValue: performer.totalCost.originalValue,\n' +
      '            originalUnit: performer.totalCost.originalUnit,\n' +
      '            valueMillions: performer.totalCost.valueMillions,\n' +
      '          },\n' +
      '        });\n' +
      '      }\n' +
      '    }\n' +
      '    /* Conflicting rows: blocking warnings, never last-wins. */',
    spec: 'src/defense-budget/rdte/gates/rdte-negative-control-probes-v1.spec.ts',
  },
  {
    id: 13,
    description: 'Convert 3Q FY2028 into an arbitrary date',
    file: path.join(RDTE, 'r4', 'r4-schedule-period-v1.ts'),
    original:
      "return {\n      kind: 'fiscal_quarter',\n      rawText: text,\n      fiscalYear: fy,\n      fiscalQuarter: q,\n      confidence: 0.9,\n    };",
    defect:
      "return {\n      kind: 'fiscal_quarter',\n      rawText: text,\n      exactDate: `${fy}-01-01`,\n      fiscalYear: fy,\n      fiscalQuarter: q,\n      confidence: 0.9,\n    };",
    spec: 'src/defense-budget/rdte/r4/r4-extractor-v1.spec.ts',
  },
  {
    id: 14,
    description: 'Include a NEEDS_REVIEW artifact in projection',
    file: path.join(RDTE, 'projection', 'rdte-projection-planner-v1.ts'),
    original:
      "if (\n      verification.decision === 'NEEDS_REVIEW' &&\n      !input.allowedReviewedAcceptances?.has(verification.decisionId)\n    ) {",
    defect: 'if (false) {',
    spec: 'src/defense-budget/rdte/projection/rdte-projection-planner-v1.spec.ts',
  },
  {
    id: 15,
    description: 'Restore last-wins duplicate behavior',
    file: path.join(RDTE, 'projection', 'rdte-projection-planner-v1.ts'),
    original:
      "result.push({\n        ...candidate,\n        operation: 'conflict',\n        exclusionReason: 'duplicate_conflict',\n      });",
    defect: "result.push({ ...candidate, operation: 'insert' });",
    spec: 'src/defense-budget/rdte/projection/rdte-projection-planner-v1.spec.ts',
  },
  {
    id: 16,
    description: 'Certify a cycle with a missing required R-2 volume',
    file: path.join(RDTE, 'reconciliation', 'rdte-cycle-certifier-v1.ts'),
    original: 'if (v == null) {',
    defect: 'if (false) {',
    spec: 'src/defense-budget/rdte/cycle/rdte-cycle-pipeline-v1.spec.ts',
  },
  {
    id: 19,
    description: 'Truncate a long project code',
    file: path.join(RDTE, 'r2a', 'r2a-project-extractor-v1.ts'),
    original: 'info.projectCode = codeMatch[1];',
    defect: 'info.projectCode = codeMatch[1].slice(0, 3);',
    spec: 'src/defense-budget/rdte/r2a/r2a-project-extractor-v1.spec.ts',
  },
];

/* ------------------------------------------------------------------ */
/* Controls 17, 18: probe-file architecture gate defects               */
/* ------------------------------------------------------------------ */

function runProbeFileControl(
  id: number,
  description: string,
  probePath: string,
  probeContent: string,
  gateId: string,
): void {
  try {
    fs.writeFileSync(probePath, probeContent, 'utf8');
    const { passed } = runJest('src/defense-budget/rdte/gates/rdte-phase4-gates-v1.spec.ts');
    results.push({
      id,
      description,
      detected: !passed,
      detail: !passed
        ? `defect detected (gate ${gateId} fired as required)`
        : 'SAFETY GAP: architecture gate did not fire',
    });
  } finally {
    if (fs.existsSync(probePath)) fs.unlinkSync(probePath);
  }
}

/* ------------------------------------------------------------------ */
/* Control 20: migration constraint removal                            */
/* ------------------------------------------------------------------ */

function runMigrationControl(): void {
  const backup = `${MIGRATION}.nc-bak`;
  try {
    fs.copyFileSync(MIGRATION, backup);
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const original = 'CREATE UNIQUE INDEX "program_element_project_budget_position_natural_key"';
    if (!sql.includes(original)) {
      results.push({
        id: 20,
        description: 'Remove a project-position natural-key constraint',
        detected: false,
        detail: 'injection point not found in migration',
      });
      return;
    }
    fs.writeFileSync(
      MIGRATION,
      sql.replace(original, 'CREATE INDEX "program_element_project_budget_position_natural_key"'),
      'utf8',
    );
    const { passed } = runJest(
      'src/defense-budget/rdte/gates/rdte-negative-control-probes-v1.spec.ts',
    );
    results.push({
      id: 20,
      description: 'Remove a project-position natural-key constraint',
      detected: !passed,
      detail: !passed
        ? 'defect detected (migration contract test failed)'
        : 'SAFETY GAP: test passed',
    });
  } finally {
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, MIGRATION);
      fs.unlinkSync(backup);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function main(): void {
  /* Preflight: the runner itself must be able to execute jest and see a
   * green suite. Without this, a broken runner (e.g. spawn ENOENT) would
   * falsely report every defect as 'detected'. */
  const preflight = runJest('src/defense-budget/rdte/gates/rdte-phase4-gates-v1.spec.ts');
  if (!preflight.passed) {
    console.error(
      `RUNNER BROKEN — preflight jest run failed; refusing to report controls:\n${preflight.output.slice(-2000)}`,
    );
    process.exit(2);
  }

  for (const control of CONTROLS) {
    runReplacementControl(control);
  }

  runProbeFileControl(
    17,
    'Import ProgramElementWriterService',
    path.join(RDTE, '__nc17_writer_probe.ts'),
    "import { ProgramElementWriterService } from '../../../program-element/program-element-writer.service.js';\nexport const __nc17 = ProgramElementWriterService;\n",
    'writer_import',
  );

  runProbeFileControl(
    18,
    'Add a Prisma upsert in projection scope',
    path.join(RDTE, 'projection', '__nc18_upsert_probe.ts'),
    'export async function __nc18(prisma: { programElementProjectBudgetPosition: { upsert: (x: unknown) => Promise<unknown> } }): Promise<unknown> {\n  return prisma.programElementProjectBudgetPosition.upsert({});\n}\n',
    'prisma_canonical_mutation',
  );

  runMigrationControl();

  /* Final: confirm every revert restored a green tree. Retry once — the
   * worktree is shared and a concurrent sibling run can contend on the
   * ts-jest cache; a retry distinguishes contention from a real revert gap
   * (the failure output is recorded either way). */
  let finalGreen = false;
  let finalDetail = '';
  for (let attempt = 1; attempt <= 2 && !finalGreen; attempt++) {
    const { passed, output } = runJest('src/defense-budget/rdte');
    finalGreen = passed;
    if (!passed) {
      finalDetail = output.split('\n').slice(-30).join('\n');
    }
  }

  const failed = results.filter((r) => !r.detected);
  console.log(
    JSON.stringify(
      {
        controls: results,
        finalRdteSuiteGreen: finalGreen,
        ...(finalGreen ? {} : { finalFailureDetail: finalDetail }),
        allControlsDetected: failed.length === 0 && finalGreen,
      },
      null,
      2,
    ),
  );
  process.exit(failed.length === 0 && finalGreen ? 0 : 1);
}

main();
