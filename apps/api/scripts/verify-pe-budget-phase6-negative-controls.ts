#!/usr/bin/env tsx
/**
 * Phase 6 Workstream O — mandatory NC01-NC24 source-mutation runner.
 *
 * Every control mutates real production source, runs the corresponding focused
 * permanent test, requires a non-zero result, restores every touched file
 * byte-for-byte in finally, and ends by running the complete clean corpus.
 * No database, AWS, network, or paid-provider access occurs here.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_ROOT = path.resolve(__dirname, '..');
const SPEC = 'src/defense-budget/phase6/phase6-negative-controls-final.spec.ts';
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

interface Mutation {
  file: string;
  find: string;
  replace: string;
}
interface NegativeControl {
  id: string;
  mutations: Mutation[];
}

const controls: NegativeControl[] = [
  {
    id: 'NC01',
    mutations: [
      {
        file: 'src/defense-budget/stages/congressional-table-v1.ts',
        find: "  const direct = money.find((entry) => ABSOLUTE_MONEY_SEMANTICS.includes(entry.semantic));",
        replace:
          "  const lastCell = [...row.cells].reverse().find((cell) => cell.value != null);\n  const direct: (typeof money)[number] | undefined = lastCell?.value == null ? undefined : { semantic: 'authorized_total', columnIndex: lastCell.columnIndex, unit: table.declaredUnit ?? 'millions', value: lastCell.value };",
      },
    ],
  },
  {
    id: 'NC02',
    mutations: [
      {
        file: 'src/defense-budget/stages/congressional-table-v1.ts',
        find: "    if (distinct.length > 1) return { key, rows, conflict: { values: distinct.sort() } };",
        replace: "    if (distinct.length > 1) return { key, rows, agreedValue: distinct.at(-1)! };",
      },
    ],
  },
  {
    id: 'NC03',
    mutations: [
      {
        file: 'src/defense-budget/stages/stage-row-emitter-v1.ts',
        find: '  const field = STAGE_AUTHORITY_FIELD[profile.authority];',
        replace:
          "  const field: FundingFieldV1 = profile.stage === 'hasc' ? 'request' : STAGE_AUTHORITY_FIELD[profile.authority];",
      },
    ],
  },
  {
    id: 'NC04',
    mutations: [
      {
        file: 'src/defense-budget/phase6/phase6-native-projection-v1.ts',
        find: "  hasc: 'hascMark',",
        replace: "  hasc: 'hacDMark',",
      },
    ],
  },
  {
    id: 'NC05',
    mutations: [
      {
        file: 'src/defense-budget/stages/line-reference-resolver.ts',
        find:
          "      basis: 'title_candidate',\n      confidence: 0,\n      status: 'candidate',",
        replace:
          "      basis: 'title_candidate',\n      confidence: 1,\n      status: 'accepted',",
      },
    ],
  },
  {
    id: 'NC06',
    mutations: [
      {
        file: 'src/defense-budget/stages/line-reference-resolver.ts',
        find:
          "    case 'procurement_line': {\n      if (reference.account == null) return [];\n      const advance = reference.advanceProcurement === true;",
        replace:
          "    case 'procurement_line': {\n      if (reference.account == null) return index.filter((entry) => entry.identity.lineKind === 'PROCUREMENT_BLIN' && entry.identity.code === reference.lineCode);\n      const advance = reference.advanceProcurement === true;",
      },
    ],
  },
  {
    id: 'NC07',
    mutations: [
      {
        file: 'src/defense-budget/contracts/extraction-artifact-v1.semantic.ts',
        find: "    case 'page_only':\n      if (!hasPage) {",
        replace: "    case 'page_only':\n      if (false && !hasPage) {",
      },
    ],
  },
  {
    id: 'NC08',
    mutations: [
      {
        file: 'src/defense-budget/stages/congressional-table-v1.ts',
        find:
          "    const unit = column.declaredUnit ?? table.declaredUnit;\n    if (unit == null) continue;",
        replace: "    const unit = column.declaredUnit ?? table.declaredUnit ?? 'millions';",
      },
    ],
  },
  {
    id: 'NC09',
    mutations: [
      {
        file: 'src/defense-budget/stages/stage-row-emitter-v1.ts',
        find: '    if (ACTION_ROW_KINDS.includes(row.semanticKind)) {',
        replace: '    if (false && ACTION_ROW_KINDS.includes(row.semanticKind)) {',
      },
      {
        file: 'src/defense-budget/stages/congressional-table-v1.ts',
        find: '  if (!POSITION_BEARING_ROW_KINDS.includes(row.semanticKind)) {',
        replace: '  if (false && !POSITION_BEARING_ROW_KINDS.includes(row.semanticKind)) {',
      },
      {
        file: 'src/defense-budget/stages/congressional-table-v1.ts',
        find: "  if (!baseline) return { status: 'blocked', reason: 'no_baseline' };",
        replace:
          "  if (!baseline) return { status: 'direct', value: change.value, unit: change.unit, semantic: 'authorized_total', ...(change.fiscalYear != null ? { fiscalYear: change.fiscalYear } : {}) };",
      },
    ],
  },
  {
    id: 'NC10',
    mutations: [
      {
        file: 'src/defense-budget/stages/stage-row-emitter-v1.ts',
        find: '      if (invalidSemantics.length > 0) {',
        replace: '      if (false && invalidSemantics.length > 0) {',
      },
    ],
  },
  {
    id: 'NC11',
    mutations: [
      {
        file: 'src/defense-budget/verification/rules/comparison/ndaa-conference-chamber.rules.ts',
        find:
          '        rowDetails.houseVsSenateDelta = signedDifference(\n          senate.value.valueMillions,\n          house.value.valueMillions,\n        );',
        replace: "        rowDetails.houseVsSenateDelta = '0';",
      },
    ],
  },
  {
    id: 'NC12',
    mutations: [
      {
        file: 'src/defense-budget/phase6/phase6-native-projection-v1.ts',
        find: "  ndaa_conference: 'ndaaConference',",
        replace: "  ndaa_conference: 'conference',",
      },
    ],
  },
  {
    id: 'NC13',
    mutations: [
      {
        file: 'src/defense-budget/phase6/phase6-native-projection-v1.ts',
        find: "  hac_d: 'hacDMark',",
        replace: "  hac_d: 'sacDMark',",
      },
    ],
  },
  {
    id: 'NC14',
    mutations: [
      {
        file: 'src/defense-budget/phase6/phase6-cycle-certification-v1.ts',
        find:
          "    (comparison) => comparison.required && comparison.outcome === 'NOT_RUN',",
        replace:
          "    (comparison) => comparison.required && comparison.outcome === 'SKIPPED',",
      },
    ],
  },
  {
    id: 'NC15',
    mutations: [
      {
        file: 'src/defense-budget/phase6/phase6-native-projection-v1.ts',
        find:
          "      value.projectionKind === 'stage_position' &&\n      value.fundingField === 'enacted' &&\n      value.enactmentProofId == null",
        replace:
          "      false && value.projectionKind === 'stage_position' &&\n      value.fundingField === 'enacted' &&\n      value.enactmentProofId == null",
      },
    ],
  },
  {
    id: 'NC16',
    mutations: [
      {
        file: 'src/defense-budget/stages/enacted/enactment-proof-v1.ts',
        find: '    if (incorporated && value.incorporationEvidence == null) {',
        replace: '    if (false && incorporated && value.incorporationEvidence == null) {',
      },
    ],
  },
  {
    id: 'NC17',
    mutations: [
      {
        file: 'src/defense-budget/phase6/phase6-native-projection-v1.ts',
        find:
          "      value.projectionKind === 'stage_position' &&\n      value.stage === 'continuing_resolution' &&\n      value.payload.explicitLineAuthority !== true",
        replace:
          "      false && value.projectionKind === 'stage_position' &&\n      value.stage === 'continuing_resolution' &&\n      value.payload.explicitLineAuthority !== true",
      },
    ],
  },
  {
    id: 'NC18',
    mutations: [
      {
        file: 'src/defense-budget/stages/appropriations/actions/defense-budget-stage-action-v1.ts',
        find: "        ['decrease', 'transfer_out', 'rescission'].includes(value.actionType) &&",
        replace: "        ['decrease', 'transfer_out'].includes(value.actionType) &&",
      },
    ],
  },
  {
    id: 'NC19',
    mutations: [
      {
        file: 'src/defense-budget/stages/appropriations/actions/appropriations-action-verifier-v1.ts',
        find: '  for (const [groupId, group] of groups) {',
        replace:
          '  for (const [groupId, group] of new Map<string, DefenseBudgetStageActionV1[]>()) {',
      },
    ],
  },
  {
    id: 'NC20',
    mutations: [
      {
        file: 'src/defense-budget/stages/post-enactment/reprogramming-execution-v1.ts',
        find:
          '  const actions: DefenseBudgetStageActionV1[] = [];\n  const revisedPositions: ReprogrammedPositionV1[] = [];',
        replace:
          "  const actions: DefenseBudgetStageActionV1[] = [];\n  const revisedPositions: ReprogrammedPositionV1[] = [];\n  if (event.status === 'approved' && event.sourceIdentity != null) revisedPositions.push(position(event, event.sourceIdentity, absValue(event.amount), 'direct'));",
      },
    ],
  },
  {
    id: 'NC21',
    mutations: [
      {
        file: 'src/defense-budget/stages/post-enactment/reprogramming-execution-v1.ts',
        find:
          "  if (record.metric !== profile.metric) throw new Error('ambiguous execution metric');",
        replace:
          "  if (false && record.metric !== profile.metric) throw new Error('ambiguous execution metric');",
      },
    ],
  },
  {
    id: 'NC22',
    mutations: [
      {
        file: 'src/defense-budget/stages/appropriations/conference/appropriations-conference-facts-v1.ts',
        find: '    current: z.literal(true),',
        replace: '    current: z.boolean(),',
      },
    ],
  },
  {
    id: 'NC23',
    mutations: [
      {
        file: 'src/defense-budget/phase6/phase6-native-projection-v1.ts',
        find:
          "      value.projectionStatus === 'verified' &&\n      value.projectionKind === 'stage_position' &&\n      value.bindingStatus !== 'accepted'",
        replace:
          "      false && value.projectionStatus === 'verified' &&\n      value.projectionKind === 'stage_position' &&\n      value.bindingStatus !== 'accepted'",
      },
    ],
  },
  {
    id: 'NC24',
    mutations: [
      {
        file: 'src/defense-budget/phase6/phase6-closeout-gates-v1.ts',
        find: '/\\bProgramElementWriterService\\b|program-element-writer/i,',
        replace: '/a^/,',
      },
    ],
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
  if (fs.existsSync(corepack)) return { command: process.execPath, prefix: [corepack], shell: false };
  return { command: 'pnpm', prefix: [], shell: process.platform === 'win32' };
}

const pnpm = resolvePnpm();

function runFocused(id?: string): { status: number | null; output: string } {
  const args = [
    ...pnpm.prefix,
    'exec',
    'jest',
    '--runInBand',
    '--forceExit',
    SPEC,
    ...(id == null ? [] : ['-t', id]),
  ];
  const result = spawnSync(pnpm.command, args, {
    cwd: API_ROOT,
    encoding: 'utf8',
    shell: pnpm.shell,
    timeout: 10 * 60 * 1000,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: { ...process.env },
  });
  if (result.error != null) throw result.error;
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

function mutate(original: Buffer, mutation: Mutation): Buffer {
  const text = original.toString('utf8');
  const occurrences = text.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${mutation.file}: expected exactly one mutation anchor, found ${occurrences}: ${mutation.find}`,
    );
  }
  return Buffer.from(text.replace(mutation.find, mutation.replace), 'utf8');
}

for (const control of controls) {
  const originals = new Map<string, Buffer>();
  try {
    for (const mutation of control.mutations) {
      const absolute = path.join(API_ROOT, mutation.file);
      const original = originals.get(absolute) ?? fs.readFileSync(absolute);
      if (!originals.has(absolute)) originals.set(absolute, original);
      const current = fs.readFileSync(absolute);
      fs.writeFileSync(absolute, mutate(current, mutation));
    }

    const result = runFocused(control.id);
    if (result.status === 0) {
      throw new Error(`${control.id}: injected defect was not detected`);
    }
    console.log(`${control.id}: detected expected production defect`);
  } finally {
    for (const [absolute, original] of originals) {
      fs.writeFileSync(absolute, original);
      if (!fs.readFileSync(absolute).equals(original)) {
        throw new Error(`${control.id}: byte-for-byte restore failed for ${path.relative(API_ROOT, absolute)}`);
      }
    }
  }
}

const final = runFocused();
if (final.status !== 0) {
  process.stderr.write(final.output);
  throw new Error('Phase 6 negative-control suite failed after all source mutations were restored');
}
console.log(`Phase 6 negative controls passed: ${controls.length}/${controls.length}`);
