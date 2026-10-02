#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { readMeriOperatorInput } from './meri-operator-json-input.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const [command, inputFlag, inputPath, outputFlag, outputPath] = args;
const namespace = 'meri-foundation-20260928';
const reject = (reason) => {
  throw new Error(`meri_capture_provider_budget_setup_${reason}`);
};

function rejectSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (
      /(?:password|secret|credential|authorization|cookie|databaseUrl|apiKey|session)/iu.test(key)
    )
      reject('sensitive_input');
    rejectSecrets(nested);
  }
}

let prisma;
let output;
try {
  if (
    !['plan', 'install'].includes(command) ||
    args.length !== 5 ||
    !['--input', '--input-env'].includes(inputFlag) ||
    outputFlag !== '--out' ||
    !isAbsolute(outputPath)
  )
    reject('arguments_invalid');
  const input = await readMeriOperatorInput(
    inputFlag,
    inputPath,
    'MERI_CAPTURE_PROVIDER_BUDGET_INPUT',
  );
  rejectSecrets(input);
  if (
    input.target !== 'capiro-dev' ||
    input.fixtureNamespace !== namespace ||
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== namespace ||
    !process.env.DATABASE_URL ||
    input.ctx?.role !== 'standard_user'
  )
    reject('scope_invalid');
  // Claim the receipt path before any database work; never overwrite an older
  // operation's evidence after committing a qualification.
  output = await open(outputPath, 'wx');

  // Canonical read dependencies only. No AppModule, HTTP server, scheduler,
  // projection worker, provider client, secret lookup, or flag changes.
  const { PrismaService } = require('../dist/prisma/prisma.service.js');
  const { TenantContextStore } = require('../dist/tenant/tenant-context.store.js');
  const {
    runWithMemoryGovernanceTenant,
  } = require('../dist/memory/memory-governance-tenant-scope.js');
  const { MemoryStoreService } = require('../dist/memory/memory-store.service.js');
  const { MemoryAuthorizationService } = require('../dist/memory/memory-authorization.service.js');
  const {
    MemoryTransitionAuditService,
  } = require('../dist/memory/memory-transition-audit.service.js');
  const { MemoryCleanupOutboxService } = require('../dist/memory/memory-cleanup-outbox.service.js');
  const {
    GovernedMemoryCandidateService,
  } = require('../dist/memory/governed-memory-candidate.service.js');
  const {
    ImmutableMemoryVersionService,
  } = require('../dist/memory/immutable-memory-version.service.js');
  const { ConfigService } = require('@nestjs/config');
  const {
    inspectCaptureProviderBudgetInstallation,
    installCaptureProviderBudgetQualification,
  } = require('../dist/meri/meri-capture-provider-budget-install.js');
  prisma = new PrismaService();
  const tenantContext = new TenantContextStore();
  const memoryAuthorization = new MemoryAuthorizationService(prisma);
  const audit = new MemoryTransitionAuditService();
  const cleanup = new MemoryCleanupOutboxService(prisma);
  const forbidden = new Proxy(
    {},
    {
      get() {
        return () => reject('provider_effect_forbidden');
      },
    },
  );
  const dependencies = {
    prisma,
    tenantContext,
    memoryAuthorization,
    memoryStore: new MemoryStoreService(prisma, tenantContext, memoryAuthorization, audit, cleanup),
    memoryCandidates: new GovernedMemoryCandidateService(
      prisma,
      forbidden,
      new ConfigService(),
      audit,
      cleanup,
      memoryAuthorization,
    ),
    memoryVersions: new ImmutableMemoryVersionService(
      prisma,
      tenantContext,
      memoryAuthorization,
      audit,
      cleanup,
    ),
  };
  await prisma.$connect();
  // The canonical owner revalidates this ordinary actor, tenant and client in
  // its transaction. Bind the same tenant for the explicit governance cohort;
  // do not require or enable the background-only `all` scope.
  const receipt = await runWithMemoryGovernanceTenant(input.ctx.tenantId, () =>
    command === 'plan'
      ? inspectCaptureProviderBudgetInstallation(dependencies, input)
      : installCaptureProviderBudgetQualification(dependencies, input),
  );
  await output.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await output.sync();
  process.stdout.write(`MERI_CAPTURE_PROVIDER_BUDGET_RECEIPT ${JSON.stringify(receipt)}\n`);
  process.stdout.write(
    `${JSON.stringify({ status: receipt.status, liveAcceptance: 'NOT_RUN' })}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  // Do not emit arbitrary Prisma diagnostics, settings, connection URLs, or input.
  const code = /^(?:meri_capture_provider_budget_|CASE01_)[a-zA-Z0-9_]+$/u.test(message)
    ? message
    : 'meri_capture_provider_budget_setup_failed';
  process.stderr.write(`${code}\n`);
  if (output)
    await output.writeFile(
      `${JSON.stringify({ status: 'FAILED', code, liveAcceptance: 'NOT_RUN' })}\n`,
      'utf8',
    );
  process.exitCode = 1;
} finally {
  if (prisma) await prisma.$disconnect();
  if (output) await output.close();
}
