#!/usr/bin/env tsx
/**
 * Phase 5 mandatory negative controls.
 *
 * Each case mutates an actual production/operator source file with the named
 * defect, runs the exact permanent gate expected to catch it, requires a
 * non-zero result for that reason, restores byte-for-byte in finally, and then
 * runs the complete gate after all cases. No database, AWS, or provider access.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SourceMutationJournal } from './lib/source-mutation-journal.js';

const API_ROOT = path.resolve(__dirname, '..');
const GATE = 'src/defense-budget/non-rdte/non-rdte-phase5-audit-gates.spec.ts';
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

interface NegativeControl {
  id: string;
  title: string;
  file: string;
  defect: string;
}

const controls: NegativeControl[] = [
  {
    id: 'NC01',
    title: 'P-40 PE references remain relationships',
    file: 'src/defense-budget/non-rdte/p40/p40-artifact-builder-v1.ts',
    defect: "\nexport const __phase5Nc01 = { lineKind: 'RDTE_PE' as const };\n",
  },
  {
    id: 'NC02',
    title: 'procurement short-line identity includes account context',
    file: 'src/defense-budget/non-rdte/identity-v1.ts',
    defect:
      '\nexport const __phase5Nc02 = `PROCUREMENT_BLIN:${input.component}:${normalizedCode}:base`;\n',
  },
  {
    id: 'NC03',
    title: 'base and advance procurement remain distinct',
    file: 'src/defense-budget/non-rdte/identity-v1.ts',
    defect: "\nexport const __phase5BaseAdvance = 'base';\n",
  },
  {
    id: 'NC04',
    title: 'printed units are never inferred by magnitude',
    file: 'src/defense-budget/non-rdte/unit-semantics-v1.ts',
    defect:
      '\nexport function inferUnitByMagnitude(value: number) { return Math.abs(value) > 1000 ? "thousands" : "dollars"; }\n',
  },
  {
    id: 'NC05',
    title: 'fractional quantities are never silently truncated',
    file: 'src/defense-budget/non-rdte/unit-semantics-v1.ts',
    defect: '\nexport function __phase5Nc05(quantity: number) { return Math.trunc(quantity); }\n',
  },
  {
    id: 'NC06',
    title: 'missing comparison cannot be represented as PASS',
    file: 'src/defense-budget/procurement/procurement-reconciliation-v1.ts',
    defect: "\nexport const __phase5Nc06 = { missingComparisonOutcome: 'PASS' as const };\n",
  },
  {
    id: 'NC07',
    title: 'unit scaling remains explicit exact decimal logic',
    file: 'src/defense-budget/non-rdte/unit-semantics-v1.ts',
    defect: '\nexport const __phase5Nc07 = Number("1000");\n',
  },
  {
    id: 'NC08',
    title: 'quantity-times-unit-cost is not universally blocking',
    file: 'src/defense-budget/non-rdte/p40/p40-extractor-v1.ts',
    defect: '\nexport const __phase5UniversalArithmetic = true;\n',
  },
  {
    id: 'NC09',
    title: 'O-1 identities remain OM_SAG',
    file: 'src/defense-budget/non-rdte/o1/o1-artifact-builder-v1.ts',
    defect: "\nexport const __phase5Nc09 = { lineKind: 'PROCUREMENT_BLIN' as const };\n",
  },
  {
    id: 'NC10',
    title: 'O&M identity includes account context',
    file: 'src/defense-budget/non-rdte/identity-v1.ts',
    defect: '\nexport const __phase5Nc10 = `OM_SAG:${input.component}:${normalizedCode}`;\n',
  },
  {
    id: 'NC11',
    title: 'OP-5 prose cannot manufacture money assertions',
    file: 'src/defense-budget/non-rdte/op5/op5-extractor-v1.ts',
    defect: '\nexport function moneyFromNarrative(text: string) { return text.length; }\n',
  },
  {
    id: 'NC12',
    title: 'MILCON certification uses account-complete native identity',
    file: 'src/defense-budget/milcon/proof-bound-milcon-composer-v1.ts',
    defect:
      '\nexport function matchByTitle(left: string, right: string) { return left === right; }\n',
  },
  {
    id: 'NC13',
    title: 'low-confidence DD1391 OCR cannot auto-pass',
    file: 'src/defense-budget/milcon/milcon-verification-policy-v1.ts',
    defect: '\nexport const __phase5OcrAutoPass = true;\n',
  },
  {
    id: 'NC14',
    title: 'DD1391 cost categories remain explicit facts',
    file: 'src/defense-budget/non-rdte/dd1391/dd1391-artifact-builder-v1.ts',
    defect: '\nexport const __phase5DropCostCategories = true;\n',
  },
  {
    id: 'NC15',
    title: 'required missing detail prevents cycle certification',
    file: 'src/defense-budget/non-rdte/non-rdte-cycle-certifier-v1.ts',
    defect: '\nexport const __phase5CertifyMissingDetail = true;\n',
  },
  {
    id: 'NC16',
    title: 'parser-result SHA and evidence-page proof are mandatory',
    file: 'src/defense-budget/non-rdte/non-rdte-proof-bound-artifact-v1.ts',
    defect: '\nexport const __phase5TrustCallerParserSha = true;\n',
  },
  {
    id: 'NC17',
    title: 'Phase 5 commands expose no paid parser bypass',
    file: 'scripts/extract-defense-budget-non-rdte.ts',
    defect: '\nconst LlamaParseClient = true;\n',
  },
  {
    id: 'NC18',
    title: 'canonical writers remain absent from all Phase 5 paths',
    file: 'src/defense-budget/non-rdte/non-rdte-cycle-pipeline-v1.ts',
    defect:
      "\nimport { ProgramElementWriterService } from '../../program-element/program-element-writer.service.js';\n",
  },
  {
    id: 'NC19',
    title: 'projection requires exact accepted assertion ledgers',
    file: 'src/defense-budget/non-rdte/non-rdte-proof-bound-projection-planner-v1.ts',
    defect: '\nexport const __phase5RawArtifactProjection = true;\n',
  },
  {
    id: 'NC20',
    title: 'Phase 5 operators and projection execute no Prisma DML',
    file: 'scripts/plan-defense-budget-non-rdte-projection.ts',
    defect: '\nprisma.nonRdteBudgetLine.create({});\n',
  },
];

function resolvePnpm(): { command: string; prefix: string[]; shell: boolean } {
  const corepack = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'corepack',
    'dist',
    'pnpm.js',
  );
  if (fs.existsSync(corepack)) {
    return { command: process.execPath, prefix: [corepack], shell: false };
  }
  const hermesPnpm = 'C:/Users/neoma/AppData/Local/hermes/node/node_modules/corepack/dist/pnpm.js';
  if (fs.existsSync(hermesPnpm)) {
    return { command: process.execPath, prefix: [hermesPnpm], shell: false };
  }
  return {
    command: 'pnpm',
    prefix: [],
    shell: process.platform === 'win32',
  };
}

const pnpm = resolvePnpm();

function runGate(title?: string): { status: number | null; output: string } {
  const args = [
    ...pnpm.prefix,
    'exec',
    'jest',
    '--runInBand',
    '--forceExit',
    GATE,
    ...(title == null ? [] : ['-t', title]),
  ];
  const result = spawnSync(pnpm.command, args, {
    cwd: API_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    shell: pnpm.shell,
    timeout: 10 * 60 * 1000,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error != null) throw result.error;
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

/**
 * A killed run must not leave an injected defect on disk — the in-memory
 * `original` below is unreachable once the process dies, and `finally` never
 * runs. See `lib/source-mutation-journal.ts` for the incident this prevents.
 */
const journal = new SourceMutationJournal({
  root: API_ROOT,
  directoryName: '.p5-nc-restore',
});
journal.recoverAbandoned();

for (const control of controls) {
  const absolute = path.join(API_ROOT, control.file);
  const original = fs.readFileSync(absolute);
  try {
    journal.record(control.id, control.file, original);
    fs.writeFileSync(absolute, Buffer.concat([original, Buffer.from(control.defect, 'utf8')]));
    const result = runGate(control.title);
    if (result.status === 0) {
      throw new Error(`${control.id} was not detected by ${control.title}`);
    }
    if (!result.output.includes(control.title.split(' — ')[0] ?? control.title)) {
      console.warn(
        `${control.id}: gate failed as expected; focused output did not echo full title`,
      );
    }
    console.log(`${control.id}: detected expected defect`);
  } finally {
    fs.writeFileSync(absolute, original);
    const restored = fs.readFileSync(absolute);
    if (!restored.equals(original)) throw new Error(`${control.id}: byte-for-byte restore failed`);
    // Only after the restore is verified byte-for-byte.
    journal.clear();
  }
}

const final = runGate();
if (final.status !== 0) {
  process.stderr.write(final.output);
  throw new Error('Phase 5 audit gate failed after all defects were restored');
}
console.log(`Phase 5 negative controls passed: ${controls.length}/${controls.length}`);
