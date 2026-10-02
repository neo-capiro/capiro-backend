import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire, Module } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = fileURLToPath(new URL('../../../../apps/api/', import.meta.url));
const cli = new URL(
  '../../../../apps/api/scripts/meri-capture-provider-budget.mjs',
  import.meta.url,
);
const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));

/** Execute the actual CLI in this rollback transaction, mapping only its fixed
 * compiled source paths and connection lifecycle. Canonical service classes,
 * governance scope, SQL, hydration, actor checks and installer are unchanged. */
export async function runBudgetCliInOwnedTransaction(command, input, prisma) {
  const directory = await mkdtemp(
    join(process.env.MERI_TEST_EVIDENCE_ROOT || process.cwd(), '.meri-budget-cli-test-'),
  );
  const outputPath = join(directory, 'receipt.json');
  const old = {
    argv: process.argv,
    exitCode: process.exitCode,
    load: Module._load,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
    input: process.env.MERI_CAPTURE_PROVIDER_BUDGET_INPUT,
    database: process.env.DATABASE_URL,
  };
  const { runWithMemoryGovernanceTenant, currentMemoryGovernanceTenant } = require(
    resolve(apiRoot, 'src/memory/memory-governance-tenant-scope.ts'),
  );
  let writes = '';
  try {
    Module._load = function (request, parent, ...rest) {
      if (parent?.filename === fileURLToPath(cli) && request.startsWith('../dist/')) {
        if (request === '../dist/prisma/prisma.service.js')
          return {
            PrismaService: class {
              constructor() {
                return { ...prisma, $connect: async () => {}, $disconnect: async () => {} };
              }
            },
          };
        request = resolve(
          apiRoot,
          'src',
          request.slice('../dist/'.length).replace(/\.js$/u, '.ts'),
        );
      }
      return old.load.call(this, request, parent, ...rest);
    };
    process.argv = [
      process.execPath,
      fileURLToPath(cli),
      command,
      '--input-env',
      'MERI_CAPTURE_PROVIDER_BUDGET_INPUT',
      '--out',
      outputPath,
    ];
    process.env.MERI_CAPTURE_PROVIDER_BUDGET_INPUT = JSON.stringify(input);
    // The real database facade is already bound to the owned rollback transaction.
    // This unusable URL cannot connect and is not passed to a real Prisma client.
    process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/never_connect';
    process.exitCode = undefined;
    process.stdout.write = function (text, ...args) {
      writes += String(text);
      return true;
    };
    process.stderr.write = function (text, ...args) {
      return true;
    };
    const inherited = currentMemoryGovernanceTenant();
    await runWithMemoryGovernanceTenant(
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      () => import(`${cli.href}?owned-test=${randomUUID()}`),
    );
    if (currentMemoryGovernanceTenant() !== inherited)
      throw new Error('CLI leaked governance scope');
    return {
      exitCode: process.exitCode || 0,
      receipt: JSON.parse(await readFile(outputPath, 'utf8')),
      writes,
    };
  } finally {
    Module._load = old.load;
    process.argv = old.argv;
    process.exitCode = old.exitCode;
    process.stdout.write = old.stdout;
    process.stderr.write = old.stderr;
    for (const [key, value] of [
      ['MERI_CAPTURE_PROVIDER_BUDGET_INPUT', old.input],
      ['DATABASE_URL', old.database],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
