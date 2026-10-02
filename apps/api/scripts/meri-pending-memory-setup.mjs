#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { readMeriOperatorInput } from './meri-operator-json-input.mjs';
import {
  inspectPendingMemorySetup,
  executePendingMemorySetup,
  readPendingMemorySetup,
} from '../../../evals/meri/live-v1/fixture-provisioning/memory-pending-execution.mjs';

const [command, inputFlag, inputPath, outFlag, outputPath] = process.argv.slice(2);
let factory, output;
try {
  if (
    !['plan', 'execute', 'read'].includes(command) ||
    process.argv.length !== 7 ||
    outFlag !== '--out' ||
    !isAbsolute(outputPath) ||
    !process.env.DATABASE_URL
  )
    throw new Error('PENDING_MEMORY_ARGUMENTS_INVALID');
  const input = await readMeriOperatorInput(
    inputFlag,
    inputPath,
    'MERI_PENDING_MEMORY_SETUP_INPUT',
  );
  if (
    !input.recipe ||
    Object.keys(input).some((key) => !['recipe', 'expectedPlanSha256'].includes(key))
  )
    throw new Error('PENDING_MEMORY_ARGUMENTS_INVALID');
  output = await open(outputPath, 'wx');
  const journal = async (entry) => {
    await output.writeFile(JSON.stringify(entry) + '\n');
    await output.sync();
    process.stdout.write('MERI_PENDING_MEMORY_SETUP_RECEIPT ' + JSON.stringify(entry) + '\n');
  };
  const { createCase01SetupDependencies } = await import('./meri-case01-setup-dependencies.mjs');
  factory = await createCase01SetupDependencies();
  await factory.runWithTenant(
    { ...input.recipe.ctx, clerkUserId: input.recipe.clerkUserId },
    async () => {
      if (command === 'execute')
        await executePendingMemorySetup(factory.deps, input.recipe, {
          expectedPlanSha256: input.expectedPlanSha256,
          journal,
        });
      else
        await journal(
          await (command === 'plan' ? inspectPendingMemorySetup : readPendingMemorySetup)(
            factory.deps,
            input.recipe,
          ),
        );
    },
  );
} catch (error) {
  const code = /^PENDING_MEMORY_[A-Z_]+$/u.test(error?.message ?? '')
    ? error.message
    : 'PENDING_MEMORY_SETUP_FAILED';
  process.stderr.write(code + '\n');
  process.exitCode = 1;
} finally {
  try {
    if (factory) await factory.close();
    if (output) await output.close();
  } catch {
    process.stderr.write('PENDING_MEMORY_CLOSE_FAILED\n');
    process.exitCode = 1;
  }
}
