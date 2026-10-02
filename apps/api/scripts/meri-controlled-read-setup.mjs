#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { readMeriOperatorInput } from './meri-operator-json-input.mjs';
import {
  inspectControlledReadSetup,
  executeControlledReadSetup,
} from '../../../evals/meri/live-v1/fixture-provisioning/controlled-read-owner.mjs';
const require = createRequire(import.meta.url);
const [command, flag, path, outFlag, outPath] = process.argv.slice(2);
let prisma, out;
try {
  if (
    !['plan', 'execute'].includes(command) ||
    process.argv.length !== 7 ||
    outFlag !== '--out' ||
    !isAbsolute(outPath ?? '')
  )
    throw new Error('CONTROLLED_READ_OWNER_ARGUMENTS_INVALID');
  const input = await readMeriOperatorInput(flag, path, 'MERI_CONTROLLED_READ_SETUP_INPUT');
  if (
    input.target !== 'capiro-dev' ||
    input.fixtureNamespace !== 'meri-foundation-20260928' ||
    !process.env.DATABASE_URL
  )
    throw new Error('CONTROLLED_READ_OWNER_TARGET_INVALID');
  out = await open(outPath, 'wx');
  const { PrismaService } = require('../dist/prisma/prisma.service.js');
  prisma = new PrismaService();
  await prisma.$connect();
  const { target, fixtureNamespace, ...request } = input;
  const receipt =
    command === 'plan'
      ? await inspectControlledReadSetup({ prisma }, request)
      : await executeControlledReadSetup({ prisma }, request);
  await out.writeFile(JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  await out.sync();
  process.stdout.write('MERI_CONTROLLED_READ_SETUP_RECEIPT ' + JSON.stringify(receipt) + '\n');
} catch (error) {
  const code = /^CONTROLLED_READ_OWNER_[A-Z_]+$/u.test(error?.message ?? '')
    ? error.message
    : 'CONTROLLED_READ_OWNER_SETUP_FAILED';
  if (out) {
    await out.writeFile(
      JSON.stringify({ status: 'RECONCILIATION_REQUIRED', code, liveAcceptance: 'NOT_RUN' }) + '\n',
    );
    await out.sync();
  }
  process.stderr.write(code + '\n');
  process.exitCode = 1;
} finally {
  if (prisma) await prisma.$disconnect();
  if (out) await out.close();
}
