#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readMeriOperatorInput } from './meri-operator-json-input.mjs';
const require = createRequire(import.meta.url);

/** Fixed operator read, independent of whichever conversation owns captureEvidence.
 * The actual canonical owner reconstructs current source state. This grants no
 * capture/budget authority and never invokes seed, approval or projection. */
export async function readSyntheticMemoryCorpus(factory, input) {
  const { readCase01MemoryCorpusInTx } =
    await import('../../../evals/meri/live-v1/fixture-provisioning/case01-memory-owner.mjs');
  const proof = await factory.runWithTenant(input.ctx, () =>
    factory.deps.prisma.withTenantUser(input.ctx.tenantId, input.ctx.userId, (tx) =>
      readCase01MemoryCorpusInTx(factory.deps, tx, input.ctx, input.clientId),
    ),
  );
  return { ...proof, status: 'MEMORY_CORPUS_READ', liveAcceptance: 'NOT_RUN' };
}

export async function reconcileSyntheticMemoryCorpus(factory, input, mode) {
  const { reconcileCase01MemoryCorpusInTx } =
    await import('../../../evals/meri/live-v1/fixture-provisioning/case01-memory-owner.mjs');
  return factory.runWithTenant(input.ctx, () => factory.deps.prisma.withTenantUser(
    input.ctx.tenantId, input.ctx.userId,
    (tx) => reconcileCase01MemoryCorpusInTx(factory.deps, tx, input.ctx, input.clientId,
      mode === 'preview' ? { mode } : { mode, expectedPlanSha256: input.expectedPlanSha256 }),
  ));
}

const confirmations = {
  install: 'INSTALL_ONE_OWNED_SYNTHETIC_READ_BUDGET',
  'read-corpus': 'READ_CURRENT_OWNED_MEMORY_CORPUS',
  'preview-corpus-metadata': 'PREVIEW_EXACT_OWNED_MEMORY_METADATA',
  'execute-corpus-metadata': 'RECONCILE_EXACT_OWNED_MEMORY_METADATA',
};

export async function readSyntheticReadOperatorInput(args) {
  const [command, flag, inputPath, outFlag, outPath] = args;
  if (
    !Object.hasOwn(confirmations, command) ||
    args.length !== 5 ||
    !['--input', '--input-env'].includes(flag) ||
    outFlag !== '--out' ||
    !isAbsolute(outPath)
  )
    throw new Error('meri_synthetic_read_budget_arguments');
  const input = await readMeriOperatorInput(flag, inputPath, 'MERI_SYNTHETIC_READ_BUDGET_INPUT');
  if (
    input.target !== 'capiro-dev' ||
    input.fixtureNamespace !== 'meri-foundation-20260928' ||
    input.confirmation !== confirmations[command] ||
    input.ctx?.role !== 'standard_user' ||
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== input.fixtureNamespace ||
    !process.env.DATABASE_URL
  )
    throw new Error('meri_synthetic_read_budget_scope');
  if (
    command !== 'install' &&
    (Object.keys(input).sort().join('|') !== (command === 'execute-corpus-metadata'
      ? 'clientId|confirmation|ctx|expectedPlanSha256|fixtureNamespace|target'
      : 'clientId|confirmation|ctx|fixtureNamespace|target') ||
      (command === 'execute-corpus-metadata' && !/^[a-f0-9]{64}$/.test(input.expectedPlanSha256)) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(
        input.clientId ?? '',
      ))
  )
    throw new Error('meri_synthetic_read_budget_corpus_scope');
  return { command, input, outPath };
}

export async function main(args = process.argv.slice(2)) {
  let prisma, output, factory, executionAttempted = false;
  try {
    const { command, input, outPath } = await readSyntheticReadOperatorInput(args);
    output = await open(outPath, 'wx');
    if (command !== 'install') {
      const { createCase01SetupDependencies } =
        await import('./meri-case01-setup-dependencies.mjs');
      factory = await createCase01SetupDependencies();
      if (command === 'execute-corpus-metadata') {
        await output.writeFile(JSON.stringify({ status: 'EXECUTION_ATTEMPTED', expectedPlanSha256: input.expectedPlanSha256,
          noAutomaticRetry: true, captureAuthority: false }) + '\n');
        await output.sync();
        executionAttempted = true;
      }
      const receipt = command === 'read-corpus' ? await readSyntheticMemoryCorpus(factory, input)
        : await reconcileSyntheticMemoryCorpus(factory, input, command === 'preview-corpus-metadata' ? 'preview' : 'execute');
      await output.writeFile(JSON.stringify(receipt) + '\n');
      await output.sync();
      process.stdout.write(
        'MERI_SYNTHETIC_MEMORY_CORPUS_RECEIPT ' + JSON.stringify(receipt) + '\n',
      );
      return;
    }
    const { PrismaService } = require('../dist/prisma/prisma.service.js');
    const {
      installSyntheticReadBudget,
    } = require('../dist/meri/meri-synthetic-read-budget-owner.js');
    prisma = new PrismaService();
    await prisma.$connect();
    const result = await installSyntheticReadBudget({
      prisma,
      ctx: input.ctx,
      qualification: input.qualification,
      rateEvidence: input.rateEvidence,
    });
    const receipt = {
      ...result,
      status: 'SYNTHETIC_READ_BUDGET_INSTALLED',
      liveAcceptance: 'NOT_RUN',
    };
    await output.writeFile(JSON.stringify(receipt) + '\n');
    await output.sync();
    process.stdout.write('MERI_SYNTHETIC_READ_BUDGET_RECEIPT ' + JSON.stringify(receipt) + '\n');
  } catch (error) {
    const code = /^meri_synthetic_read_budget_[a-z_]+$/.test(error?.message ?? '')
      ? error.message
      : 'meri_synthetic_read_budget_install_failed';
    if (output) {
      await output.writeFile(
        JSON.stringify({ status: executionAttempted ? 'EXECUTION_OUTCOME_UNCONFIRMED' : 'FAILED', code,
          noAutomaticRetry: true, liveAcceptance: 'NOT_RUN' }) + '\n',
      );
      await output.sync();
    }
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  } finally {
    if (factory) await factory.close();
    if (prisma) await prisma.$disconnect();
    if (output) await output.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
