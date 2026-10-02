#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  controlledReadSetupInput,
  controlledReadExecuteInput,
  controlledReadBudgetPlanInput,
  controlledReadBudgetInstallInput,
  controlledReadLiveConfig,
} from './controlled-read-operator-input.mjs';

const read = (path) => {
  if (!isAbsolute(path ?? '')) throw new Error('CONTROLLED_READ_INPUT_ABSOLUTE_PATH_REQUIRED');
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
};
// Receipts must be extracted from the actual verified one-off execution. The
// source owner emits one receipt. This only checks local evidence consistency;
// current authenticated live admission remains authoritative.
const receipt = (path) => {
  const run = read(path);
  if (run.status !== 'VERIFIED' || run.containerExitCode !== 0 || run.ownerReceipts?.length !== 1)
    throw new Error('CONTROLLED_READ_INPUT_EXECUTION_NOT_VERIFIED');
  return run.ownerReceipts[0].receipt ?? run.ownerReceipts[0];
};
try {
  const [stage, flag, packetPath, outFlag, outPath] = process.argv.slice(2);
  if (
    process.argv.length !== 7 ||
    flag !== '--packet' ||
    outFlag !== '--out' ||
    !isAbsolute(outPath ?? '')
  )
    throw new Error('CONTROLLED_READ_INPUT_ARGUMENTS');
  const packet = read(packetPath);
  let value;
  if (stage === 'setup-plan') value = controlledReadSetupInput(read(packet.manifestPath), packet);
  else {
    const input = read(packet.inputPath);
    if (stage === 'setup-execute')
      value = controlledReadExecuteInput(input, receipt(packet.setupPlanPath));
    else {
      const setup = receipt(packet.setupReceiptPath);
      if (stage === 'budget-plan') value = controlledReadBudgetPlanInput(input, setup);
      else if (stage === 'budget-install')
        value = controlledReadBudgetInstallInput(
          input,
          setup,
          receipt(packet.budgetPlanPath),
          read(packet.reviewedRatesPath),
        );
      else if (stage === 'live-scope') {
        value = controlledReadLiveConfig(
          input,
          setup,
          read(packet.budgetInstallInputPath),
          receipt(packet.budgetInstallReceiptPath),
          read(packet.deploymentPath),
        );
        value.aggregateCheckpoint = read(packet.aggregateCheckpointPath);
      } else throw new Error('CONTROLLED_READ_INPUT_STAGE');
    }
  }
  writeFileSync(outPath, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'INPUT_MATERIALIZED', stage, liveAcceptance: 'NOT_RUN' }));
} catch (error) {
  const code = /^CONTROLLED_READ_INPUT_[A-Z_]+$/u.test(error?.message ?? '')
    ? error.message
    : 'CONTROLLED_READ_INPUT_REJECTED';
  console.error(code);
  process.exitCode = 1;
}
