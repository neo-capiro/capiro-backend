#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { readMeriOperatorInput } from './meri-operator-json-input.mjs';
import {
  inspectCase12Setup,
  resolveCase12SetupRecipe,
} from '../../../evals/meri/live-v1/fixture-provisioning/case12-memory-setup.mjs';

const [command, inputFlag, inputPath, outFlag, outputPath] = process.argv.slice(2);
let factory, output;
try {
  if (
    command !== 'plan' ||
    process.argv.length !== 7 ||
    outFlag !== '--out' ||
    !isAbsolute(outputPath ?? '') ||
    !process.env.DATABASE_URL
  )
    throw new Error('CASE12_SETUP_PLAN_ARGUMENTS');
  const input = await readMeriOperatorInput(inputFlag, inputPath, 'MERI_CASE12_SETUP_PLAN_INPUT');
  if (Object.keys(input).join('|') !== 'recipe') throw new Error('CASE12_SETUP_PLAN_INPUT');
  const { input: recipe } = await resolveCase12SetupRecipe(input.recipe);
  output = await open(outputPath, 'wx');
  const { createCase01SetupDependencies } = await import('./meri-case01-setup-dependencies.mjs');
  // Reuse the actual bounded canonical memory graph. Only its scoped read work
  // is invoked; this CLI has no execute, admission, create or conversation mode.
  factory = await createCase01SetupDependencies();
  const context = { ...recipe.ctx, clerkUserId: recipe.clerkUserId };
  const receipt = await factory.runWithTenant(context, () =>
    inspectCase12Setup(factory.deps, recipe),
  );
  if (
    receipt.status !== 'PLAN_ONLY' ||
    receipt.captureAuthority !== false ||
    receipt.fixtureReady !== false ||
    receipt.liveAcceptance !== 'NOT_RUN'
  )
    throw new Error('CASE12_SETUP_PLAN_RESULT');
  const bytes = JSON.stringify(receipt) + '\n';
  await output.writeFile(bytes);
  await output.sync();
  process.stdout.write('MERI_CASE12_SETUP_PLAN_RECEIPT ' + bytes);
} catch {
  process.stderr.write('CASE12_SETUP_PLAN_FAILED\n');
  process.exitCode = 1;
} finally {
  try {
    if (factory) await factory.close();
    if (output) await output.close();
  } catch {
    process.stderr.write('CASE12_SETUP_PLAN_CLOSE_FAILED\n');
    process.exitCode = 1;
  }
}
