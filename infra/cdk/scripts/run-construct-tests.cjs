#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Runs the node:test-style CDK construct specs under Node's own test runner.
 *
 * Invoked as `pnpm --filter @capiro/infra-cdk test:constructs`.
 *
 * WHY `--require ts-node/register/transpile-only`
 * -----------------------------------------------
 * The specs are TypeScript with `module: commonjs` + `moduleResolution: node`
 * (infra/cdk/tsconfig.json), so they use extensionless relative imports such
 * as `from '../lib/constructs/example-construct'`.
 *
 *   * Plain `node --test test/foo.spec.ts` on Node >= 23 strips the types and
 *     then loads the file as an ES module (import syntax is detected), and ESM
 *     resolution REFUSES extensionless specifiers. Verified on Node 24.19.0:
 *     `ERR_MODULE_NOT_FOUND ... /lib/constructs/example-construct`.
 *   * Registering ts-node's CommonJS require hook makes the spec load as CJS
 *     with Node's forgiving CJS resolver, which is what the tsconfig targets.
 *     Verified on Node 24.19.0: 9/9 pass, exit 0.
 *
 * `transpile-only` skips ts-node's type checking on purpose — types are
 * already gated by the package's own `typecheck` script (`tsc --noEmit`, whose
 * `include` covers bin/, lib/ AND test/), so type-checking again here would
 * only duplicate that work. Measured: ~20s transpile-only vs ~41s full check
 * for one spec file.
 *
 * No Node version flag is required. `--no-experimental-strip-types` is NOT
 * passed: it does not exist on Node < 22.6, and the ts-node require hook
 * already wins on the versions where it does exist (verified: identical 9/9
 * pass with and without it on Node 24.19.0).
 *
 * AWS SAFETY: these specs only call `Template.fromStack`, which synthesizes
 * CloudFormation locally. Nothing here contacts AWS or needs credentials.
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const USAGE =
  'Usage: node scripts/run-construct-tests.cjs --run [spec-substring ...] | --list [spec-substring ...]';

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    console.log(USAGE);
    return 0;
  }
  if (
    argv.length === 0 ||
    (argv.includes('--run') && argv.includes('--list')) ||
    argv.some((arg) => arg.startsWith('--') && arg !== '--list' && arg !== '--run')
  ) {
    console.error(USAGE);
    return 2;
  }

  const { PACKAGE_ROOT, classifySpecs } = require('./cdk-spec-runners.cjs');
  const listOnly = argv.includes('--list');
  /** Optional substring filters for focused construct tests. */
  const filters = argv.filter((a) => !a.startsWith('--'));

  const { nodeTest, jest } = classifySpecs();
  let selected = nodeTest;
  if (filters.length > 0) {
    selected = nodeTest.filter((file) => filters.some((f) => file.includes(f)));
  }

  if (selected.length === 0) {
    console.error(
      filters.length > 0
        ? `run-construct-tests: no node:test-style spec in infra/cdk/test matches ${JSON.stringify(filters)}.`
        : 'run-construct-tests: no node:test-style specs found in infra/cdk/test.',
    );
    // Exit non-zero: an empty run must never be mistaken for a green run.
    process.exit(1);
  }

  const rel = (f) => path.relative(PACKAGE_ROOT, f).split(path.sep).join('/');
  console.log(
    `run-construct-tests: ${selected.length} node:test spec(s) via \`node --test\`; ` +
      `${jest.length} jest-style spec(s) are run separately by \`test:jest\`.`,
  );
  for (const file of selected) console.log(`  - ${rel(file)}`);

  if (listOnly) return 0;

  const result = spawnSync(
    process.execPath,
    ['--require', 'ts-node/register/transpile-only', '--test', ...selected],
    { cwd: PACKAGE_ROOT, stdio: 'inherit', env: process.env },
  );
  if (result.error) {
    console.error('run-construct-tests: failed to spawn node --test:', result.error.message);
    return 1;
  }
  if (result.signal) {
    console.error(`run-construct-tests: node --test terminated by signal ${result.signal}`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

process.exit(main());
