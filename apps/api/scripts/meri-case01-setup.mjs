#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { readMeriOperatorInput } from './meri-operator-json-input.mjs';
import {
  inspectCase01ExecutionSetup,
  executeCase01ExecutionSetup,
} from '../../../evals/meri/live-v1/fixture-provisioning/case01-execution-setup.mjs';

const [command, inputFlag, inputPath, outFlag, outputPath] = process.argv.slice(2);
let factory, output;
const fail = () => {
  throw new Error('CASE01_SETUP_ARGUMENTS_INVALID');
};
try {
  if (
    !['plan', 'execute'].includes(command) ||
    process.argv.length !== 7 ||
    outFlag !== '--out' ||
    !isAbsolute(outputPath)
  )
    fail();
  const input = await readMeriOperatorInput(inputFlag, inputPath, 'MERI_CASE01_SETUP_INPUT');
  if (!process.env.DATABASE_URL) fail();
  output = await open(outputPath, 'wx');
  const journal = async (entry) => {
    await output.writeFile(`${JSON.stringify(entry)}\n`);
    await output.sync();
    process.stdout.write(`MERI_CASE01_SETUP_RECEIPT ${JSON.stringify(entry)}\n`);
  };
  const { createCase01SetupDependencies } = await import('./meri-case01-setup-dependencies.mjs');
  factory = await createCase01SetupDependencies();
  if (command === 'plan')
    await journal(await inspectCase01ExecutionSetup(factory.deps, input.recipe));
  else {
    // The factory verifies the current synthetic actor before binding both real
    // tenant ALS scopes; the wrapper repeats locked preflight before its claim.
    const operatorContext = { ...input.recipe.ctx, clerkUserId: input.recipe.clerkUserId };
    await factory.runWithTenant(operatorContext, () =>
      executeCase01ExecutionSetup(factory.deps, input.recipe, {
        expectedPlanSha256: input.expectedPlanSha256,
        createConversation: (ctx, args) =>
          factory.createConversation({ ...ctx, clerkUserId: input.recipe.clerkUserId }, args),
        journal,
      }),
    );
  }
  process.stdout.write(
    JSON.stringify({
      status: command === 'plan' ? 'PLAN_WRITTEN' : 'SETUP_COMPLETE',
      liveAcceptance: 'NOT_RUN',
      synthesisSubmissionCount: 0,
    }) + '\n',
  );
} catch (error) {
  const code = /^CASE01_[A-Z_]+$/u.test(error?.message ?? '')
    ? error.message
    : 'CASE01_SETUP_FAILED';
  if (output) {
    await output.writeFile(
      JSON.stringify({ status: 'RECONCILIATION_REQUIRED', code, liveAcceptance: 'NOT_RUN' }) + '\n',
    );
    await output.sync();
  }
  process.stderr.write(code + '\n');
  process.exitCode = 1;
} finally {
  try {
    if (factory) await factory.close();
    if (output) await output.close();
  } catch {
    process.stderr.write('CASE01_SETUP_CLOSE_FAILED\n');
    process.exitCode = 1;
  }
}
