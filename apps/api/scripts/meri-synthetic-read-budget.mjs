#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { readMeriOperatorInput } from './meri-operator-json-input.mjs';
const require = createRequire(import.meta.url);
let prisma, output;
try {
  const args = process.argv.slice(2),
    [command, flag, inputPath, outFlag, outPath] = args;
  if (
    command !== 'install' ||
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
    input.confirmation !== 'INSTALL_ONE_OWNED_SYNTHETIC_READ_BUDGET' ||
    input.ctx?.role !== 'standard_user' ||
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== input.fixtureNamespace ||
    !process.env.DATABASE_URL
  )
    throw new Error('meri_synthetic_read_budget_scope');
  output = await open(outPath, 'wx');
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
      JSON.stringify({ status: 'FAILED', code, liveAcceptance: 'NOT_RUN' }) + '\n',
    );
    await output.sync();
  }
  process.stderr.write(code + '\n');
  process.exitCode = 1;
} finally {
  if (prisma) await prisma.$disconnect();
  if (output) await output.close();
}
