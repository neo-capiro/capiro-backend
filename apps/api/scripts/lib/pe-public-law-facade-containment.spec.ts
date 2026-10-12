import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from '@jest/globals';
import * as ts from 'typescript';
import { publicLawFacadeContainmentFailures } from './pe-public-law-facade-containment.js';

const facade = readFileSync(
  resolve(__dirname, '..', 'parse-defense-approps-public-law.ts'),
  'utf8',
);
const refusal =
  "  if (process.argv.includes('--commit')) {\n    throw new Error(\n      'parse-defense-approps-public-law: canonical enacted commit is disabled in Phase 6; use proof-gated cycle inspection/certification',\n    );\n  }\n";
const spoofMarkers = `
// from './lib/pe-exact-sha-loader-contract.js'
// resolvePeDollarLoaderPosture assertExactShaCommitAllowed 'approved-sha256'
// INSPECT_ONLY canonicalWrites: false canonical enacted commit is disabled
`;

function replace(before: string, after: string): string {
  expect(facade).toContain(before);
  const mutated = facade.replace(before, after);
  expect(mutated).not.toBe(facade);
  return mutated;
}

const mutants: Array<[string, () => string]> = [
  ['empty program with inert markers', () => spoofMarkers],
  ['unreachable decoy facade', () => `if (false) {\n${facade}\n}\n${spoofMarkers}`],
  ['DB import', () => "import { PrismaClient } from '@prisma/client';\n" + facade],
  [
    'writer import',
    () =>
      "import { ProgramElementWriterService } from '../src/program-element/program-element-writer.service.js';\n" +
      facade,
  ],
  ['provider import', () => "import { S3Client } from '@aws-sdk/client-s3';\n" + facade],
  ['child process import', () => "import * as child from 'node:child_process';\n" + facade],
  ['side-effect import', () => "import './mutate-canonical-budget.js';\n" + facade],
  ['extra top-level operation', () => facade + '\nfetch("https://invalid.example/");'],
  ['extra hidden operation', () => facade + '\nvoid (() => process.exit(0))();'],
  [
    'dynamic import',
    () =>
      replace(
        'function main(): void {',
        "function main(): void {\n  void import('./mutate-canonical-budget.js');",
      ),
  ],
  ['filesystem import target', () => replace("from 'node:fs'", "from './write-capable-fs.js'")],
  ['filesystem binding alias', () => facade.replace(/\bfs\b/g, 'otherFs')],
  [
    'schema import target',
    () => replace('stages/enacted/enactment-proof-v1.js', 'stages/enacted/no-validation.js'),
  ],
  [
    'type-only schema import',
    () => replace('import {\n  defenseBudget', 'import type {\n  defenseBudget'),
  ],
  [
    'type-only schema binding',
    () =>
      replace(
        '  defenseBudgetEnactmentProofV1Schema,',
        '  type defenseBudgetEnactmentProofV1Schema,',
      ),
  ],
  [
    'schema alias',
    () =>
      replace(
        '  defenseBudgetEnactmentProofV1Schema,',
        '  defenseBudgetEnactmentProofV1Schema as otherSchema,',
      ),
  ],
  [
    'schema shadow',
    () =>
      replace(
        'function main(): void {',
        'function main(): void {\n  const defenseBudgetEnactmentProofV1Schema = { parse: (value: unknown) => value };',
      ),
  ],
  [
    'schema method rebinding',
    () =>
      replace(
        'function main(): void {',
        'function main(): void {\n  enactedLineCandidateV1Schema.parse = (value: unknown) => value as never;',
      ),
  ],
  [
    'filesystem method rebinding',
    () =>
      replace(
        'function main(): void {',
        'function main(): void {\n  fs.readFileSync = (() => "{}") as never;',
      ),
  ],
  ['commit refusal removed with marker decoy', () => replace(refusal, spoofMarkers)],
  [
    'commit refusal becomes return',
    () =>
      replace(
        "    throw new Error(\n      'parse-defense",
        "    return;\n    throw new Error(\n      'parse-defense",
      ),
  ],
  [
    'commit refusal becomes conditional',
    () =>
      replace(
        "if (process.argv.includes('--commit'))",
        "if (process.env.PE_LEGACY_BUDGET_WRITES !== 'allow' && process.argv.includes('--commit'))",
      ),
  ],
  [
    'commit refusal becomes unreachable',
    () =>
      replace(
        "if (process.argv.includes('--commit'))",
        "if (false && process.argv.includes('--commit'))",
      ),
  ],
  [
    'commit refusal tests another flag',
    () => replace("process.argv.includes('--commit')", "process.argv.includes('--other')"),
  ],
  [
    'artifact read before refusal',
    () =>
      replace(
        'function main(): void {',
        "function main(): void {\n  fs.readFileSync('proof.json', 'utf8');",
      ),
  ],
  [
    'refusal moved after proof read',
    () => {
      const removed = replace(refusal, '');
      return removed.replace('  const candidatesRaw', refusal + '  const candidatesRaw');
    },
  ],
  [
    'argument helper bypass',
    () =>
      replace(
        'return index >= 0 ? process.argv[index + 1] : undefined;',
        'return "unvalidated.json";',
      ),
  ],
  [
    'required paths guard removed',
    () => replace('if (proofPath == null || candidatesPath == null)', 'if (false)'),
  ],
  [
    'proof parse bypass',
    () =>
      replace(
        "  const proof = defenseBudgetEnactmentProofV1Schema.parse(\n    JSON.parse(fs.readFileSync(proofPath, 'utf8')),\n  );",
        "  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));",
      ),
  ],
  [
    'proof safeParse result ignored',
    () =>
      replace(
        'defenseBudgetEnactmentProofV1Schema.parse(',
        'defenseBudgetEnactmentProofV1Schema.safeParse(',
      ),
  ],
  [
    'optional proof parse',
    () =>
      replace(
        'defenseBudgetEnactmentProofV1Schema.parse(',
        'defenseBudgetEnactmentProofV1Schema.parse?.(',
      ),
  ],
  ['non-array accepted', () => replace('if (!Array.isArray(candidatesRaw))', 'if (false)')],
  [
    'array predicate inverted',
    () => replace('if (!Array.isArray(candidatesRaw))', 'if (Array.isArray(candidatesRaw))'),
  ],
  [
    'candidate map bypass',
    () => replace('enactedLineCandidateV1Schema.parse(candidate)', 'candidate'),
  ],
  [
    'candidate safeParse ignored',
    () =>
      replace(
        'enactedLineCandidateV1Schema.parse(candidate)',
        'enactedLineCandidateV1Schema.safeParse(candidate)',
      ),
  ],
  [
    'optional candidate parse',
    () =>
      replace(
        'enactedLineCandidateV1Schema.parse(candidate)',
        'enactedLineCandidateV1Schema?.parse(candidate)',
      ),
  ],
  ['mutable declaration instead of const', () => replace('  const proof =', '  let proof =')],
  [
    'disposal declaration instead of const',
    () => replace('  const proof =', '  await using proof ='),
  ],
  [
    'write-capable success report',
    () => replace('canonicalWrites: false', 'canonicalWrites: true'),
  ],
  ['commit success report', () => replace("mode: 'INSPECT_ONLY'", "mode: 'COMMIT'")],
  [
    'success output before validation',
    () =>
      replace(
        'function main(): void {',
        'function main(): void {\n  console.log(JSON.stringify({ canonicalWrites: false }));',
      ),
  ],
  [
    'false certification claim',
    () =>
      replace(
        'candidateCount: candidates.length,',
        'candidateCount: candidates.length,\n        certified: true,',
      ),
  ],
  ['caught failures return success', () => replace('process.exitCode = 1', 'process.exitCode = 0')],
  ['main never invoked', () => replace('  main();', '  void main;')],
  [
    'conditional invocation',
    () => replace('  main();', '  if (process.env.ENABLE_INSPECT) main();'),
  ],
  [
    'extra catch operation',
    () =>
      replace(
        'process.exitCode = 1;',
        'process.exitCode = 1;\n  fetch("https://invalid.example/");',
      ),
  ],
  ['malformed syntax', () => facade + '\nfunction broken( {'],
];

describe('public-law facade executable containment', () => {
  test('accepts the exact current inspect-only owner', () => {
    expect(publicLawFacadeContainmentFailures(facade)).toEqual([]);
  });

  test('ignores harmless comments, line endings, whitespace and equivalent quotes', () => {
    const formatting = (spoofMarkers + facade.replace(/'/g, '"')).replace(/\n/g, '\r\n');
    expect(publicLawFacadeContainmentFailures(formatting)).toEqual([]);
  });

  test.each(mutants)('rejects %s even with inert gate markers', (_name, mutate) => {
    const mutated = mutate();
    expect(publicLawFacadeContainmentFailures(mutated + spoofMarkers).length).toBeGreaterThan(0);
  });
});

interface ProbeResult {
  exitCode: number | undefined;
  reads: string[];
  parsed: string[];
  stdout: string[];
  stderr: string[];
}

/** Execute only the facade's transpiled statements against inert fake dependencies. */
function inspectProbe(
  argv: string[],
  files: Record<string, unknown> = {},
  environment: Record<string, string> = {},
): ProbeResult {
  const result: ProbeResult = {
    exitCode: undefined,
    reads: [],
    parsed: [],
    stdout: [],
    stderr: [],
  };
  const fakeProcess = {
    argv: ['node', 'facade.ts', ...argv],
    env: environment,
    exitCode: undefined as number | undefined,
  };
  const fakeFs = Object.freeze({
    readFileSync(file: string, encoding: string) {
      expect(encoding).toBe('utf8');
      result.reads.push(file);
      if (!Object.prototype.hasOwnProperty.call(files, file))
        throw new Error('inert fixture missing');
      return JSON.stringify(files[file]);
    },
  });
  const schemas = Object.freeze({
    defenseBudgetEnactmentProofV1Schema: Object.freeze({
      parse(value: { valid?: boolean }) {
        result.parsed.push('proof');
        if (value.valid !== true) throw new Error('inert proof schema refusal');
        return value;
      },
    }),
    enactedLineCandidateV1Schema: Object.freeze({
      parse(value: { valid?: boolean }) {
        result.parsed.push('candidate');
        if (value.valid !== true) throw new Error('inert candidate schema refusal');
        return value;
      },
    }),
  });
  const emitted = ts.transpileModule(facade, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  runInNewContext(
    emitted,
    {
      exports: {},
      process: fakeProcess,
      console: {
        log: (text: string) => result.stdout.push(text),
        error: (text: string) => result.stderr.push(text),
      },
      require: (module: string) => {
        if (module === 'node:fs') return fakeFs;
        if (module === '../src/defense-budget/stages/enacted/enactment-proof-v1.js') return schemas;
        throw new Error('forbidden probe dependency: ' + module);
      },
      Error,
    },
    { timeout: 1000 },
  );
  result.exitCode = fakeProcess.exitCode;
  return result;
}

const args = ['--proof', 'proof.json', '--candidates', 'candidates.json'];
const validProof = {
  valid: true,
  proofId: 'proof-1',
  publicLawNumber: 'P.L. synthetic',
  proofType: 'statutory_line_item',
};
const validFiles = {
  'proof.json': validProof,
  'candidates.json': [{ valid: true }, { valid: true }],
};

describe('public-law facade inert invocation boundary (not proof certification)', () => {
  test.each(
    [
      ['--commit'],
      [...args, '--commit'],
      [...args, '--commit', '--approved-sha256', 'a'.repeat(64)],
      [...args, '--inspect', '--commit'],
    ].map((argv) => ({ argv })),
  )('commit intent permanently refuses before any artifact read: $argv', ({ argv }) => {
    const result = inspectProbe(argv, validFiles, {
      PE_LEGACY_BUDGET_WRITES: 'allow',
      PE_SNAPSHOT_READ_MODE: 'legacy',
    });
    expect(result.exitCode).toBe(1);
    expect(result.reads).toEqual([]);
    expect(result.parsed).toEqual([]);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('\n')).toContain('canonical enacted commit is disabled');
  });

  test('missing input refuses before reads', () => {
    const result = inspectProbe([]);
    expect(result.exitCode).toBe(1);
    expect(result.reads).toEqual([]);
    expect(result.stdout).toEqual([]);
  });

  test('inspection parses the proof and every candidate then truthfully reports no writes', () => {
    const result = inspectProbe(args, validFiles);
    expect(result.exitCode).toBeUndefined();
    expect(result.reads).toEqual(['proof.json', 'candidates.json']);
    expect(result.parsed).toEqual(['proof', 'candidate', 'candidate']);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toHaveLength(1);
    const rendered = result.stdout[0];
    if (rendered == null) throw new Error('inert inspection report missing');
    const report = JSON.parse(rendered);
    expect(report).toMatchObject({
      mode: 'INSPECT_ONLY',
      canonicalWrites: false,
      candidateCount: 2,
    });
    expect(report).not.toHaveProperty('certified');
  });

  test('proof validation refusal prevents candidate reads and success output', () => {
    const result = inspectProbe(args, { ...validFiles, 'proof.json': { valid: false } });
    expect(result.exitCode).toBe(1);
    expect(result.reads).toEqual(['proof.json']);
    expect(result.parsed).toEqual(['proof']);
    expect(result.stdout).toEqual([]);
  });

  test('non-array candidates refuse before candidate parsing', () => {
    const result = inspectProbe(args, { ...validFiles, 'candidates.json': {} });
    expect(result.exitCode).toBe(1);
    expect(result.parsed).toEqual(['proof']);
    expect(result.stdout).toEqual([]);
  });

  test('candidate validation refusal prevents success output', () => {
    const result = inspectProbe(args, { ...validFiles, 'candidates.json': [{ valid: false }] });
    expect(result.exitCode).toBe(1);
    expect(result.parsed).toEqual(['proof', 'candidate']);
    expect(result.stdout).toEqual([]);
  });
});
