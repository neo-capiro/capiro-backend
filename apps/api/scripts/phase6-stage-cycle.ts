/**
 * Phase 6 Workstream N — operator entrypoint.
 *
 * `extract_stage_document` delegates to the governed Phase 3 extraction/router
 * command so Phase 6 never creates a second parser implementation. All other
 * commands consume a strict Phase 6 cycle input and remain inspect/replay only.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  buildPhase6OperatorPlanV1,
  PHASE6_OPERATOR_COMMAND_VALUES,
  type Phase6OperatorCommandV1,
} from '../src/defense-budget/phase6/phase6-cycle-runner-v1.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function extractionArgs(): string[] {
  const input = process.argv.slice(2);
  const output: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const token = input[index]!;
    if (token === '--command') {
      index += 1;
      continue;
    }
    if (token === '--input') {
      throw new Error(
        'extract_stage_document uses Phase 3 extraction flags, not --input; provide --manifest/--document/--source/--work-dir/--out',
      );
    }
    output.push(token);
  }
  return output;
}

function runStageExtraction(): void {
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(
    executable,
    ['exec', 'tsx', 'scripts/extract-defense-budget-cycle.ts', ...extractionArgs()],
    { cwd: process.cwd(), stdio: 'inherit' },
  );
  if (result.error != null) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

function main(): void {
  if (process.argv.includes('--commit') || process.argv.includes('--promote')) {
    throw new Error('Phase 6 stage-cycle commands do not support canonical commit or promotion');
  }
  const command = arg('command') as Phase6OperatorCommandV1 | undefined;
  if (command == null || !PHASE6_OPERATOR_COMMAND_VALUES.includes(command)) {
    throw new Error(`--command must be one of ${PHASE6_OPERATOR_COMMAND_VALUES.join(', ')}`);
  }

  if (command === 'extract_stage_document') {
    runStageExtraction();
    return;
  }

  const inputPath = arg('input');
  if (inputPath == null) throw new Error('--input <cycle-input.json> is required');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as unknown;
  console.log(JSON.stringify(buildPhase6OperatorPlanV1(command, input), null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
