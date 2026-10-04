#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { readMeriOperatorInput } from './meri-operator-json-input.mjs';
const require = createRequire(import.meta.url);
const [mode, inputFlag, inputPath, outFlag, outPath] = process.argv.slice(2);
let prisma, output;
try {
  if (
    !['plan', 'bind'].includes(mode) ||
    process.argv.length !== 7 ||
    outFlag !== '--out' ||
    !isAbsolute(outPath ?? '') ||
    !process.env.DATABASE_URL
  )
    throw new Error('CASE14_ARGUMENTS');
  const input = await readMeriOperatorInput(inputFlag, inputPath, 'MERI_CASE14_RECALL_SETUP_INPUT');
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'ctx',
          'caseId',
          'clientId',
          'captureRunId',
          'expectedPlanSha256',
          'confirmation',
        ].includes(key),
    ) ||
    input.caseId !== '14' ||
    input.ctx?.role !== 'user_admin'
  )
    throw new Error('CASE14_SCOPE');
  output = await open(outPath, 'wx');
  const { PrismaService } = require('../dist/prisma/prisma.service.js');
  const { MemoryAuthorizationService } = require('../dist/memory/memory-authorization.service.js');
  const {
    runWithMemoryGovernanceTenant,
  } = require('../dist/memory/memory-governance-tenant-scope.js');
  const {
    inspectCase14RecallBindingInTx,
    installCase14RecallBindingInTx,
  } = require('../dist/memory/case14-fixture-evidence.js');
  prisma = new PrismaService();
  await prisma.$connect();
  const authorization = new MemoryAuthorizationService(prisma);
  const receipt = await runWithMemoryGovernanceTenant(input.ctx.tenantId, () =>
    prisma.withTenantUser(input.ctx.tenantId, input.ctx.userId, (tx) =>
      (mode === 'plan' ? inspectCase14RecallBindingInTx : installCase14RecallBindingInTx)(
        tx,
        input.ctx,
        authorization,
        input,
      ),
    ),
  );
  const text = JSON.stringify(receipt) + '\n';
  await output.writeFile(text);
  await output.sync();
  process.stdout.write('MERI_CASE14_RECALL_SETUP_RECEIPT ' + text);
} catch {
  process.stderr.write('CASE14_RECALL_SETUP_FAILED\n');
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect();
  await output?.close();
}
