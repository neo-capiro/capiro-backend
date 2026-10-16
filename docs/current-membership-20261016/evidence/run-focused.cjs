const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const paths = require('./paths.cjs');
const { buildInvocation, preflightInvocation } = require('./jest-invocation.cjs');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
const suite = option('--suite', 'primary');
const prefix = option('--output-prefix', 'focused-attempt1');
if (!['primary', 'membership', 'all'].includes(suite) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix)) throw new Error('Invalid bounded suite/output prefix');
if (!process.execArgv.includes('--max-old-space-size=512')) throw new Error('Launch this single runner with --max-old-space-size=512');
const receiptPath = path.join(__dirname, `${prefix}.receipt.json`);
const outputPath = path.join(__dirname, `${prefix}.result.json`);
const preflightPath = path.join(__dirname, `${prefix}.preflight.json`);
if ([receiptPath, outputPath, preflightPath].some(file => fs.existsSync(file))) throw new Error('Choose a new output prefix to preserve previous attempt evidence');
const testPaths = suite === 'membership' ? [paths.primaryTests[0]] : [...paths.primaryTests, ...(suite === 'all' ? paths.supportingTests : [])];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function checkpoints() {
  const sourceFiles = fs.readdirSync(paths.authRoot).filter(name => name.endsWith('.ts')).map(name => path.join(paths.authRoot, name));
  sourceFiles.push(path.join(paths.sourceRoot, 'apps/api/src/memory/memory-wall.helpers.ts'), path.join(paths.sourceRoot, 'apps/api/src/context/context-security-scope.service.ts'), path.join(paths.sourceRoot, 'apps/api/src/tenant/tenant-context.middleware.ts'), path.join(paths.sourceRoot, 'packages/shared/src/index.ts'), path.join(paths.sourceRoot, 'packages/shared/src/client-memory-wall.ts'));
  return sourceFiles.sort().map(file => ({ file, sha256: hash(file) }));
}
const receipt = { startedAtUtc: new Date().toISOString(), suite, testPaths, sourceRoot: paths.sourceRoot, configPath: path.join(__dirname, 'jest.config.cjs'), nodeVersion: process.version, nodeHeapArgument: '--max-old-space-size=512', serial: true, sourceCopies: [], sourceEdits: false, databaseSetupHooks: false, state: 'Preparing' };
const save = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');

async function main() {
  try {
    for (const file of testPaths) if (!fs.existsSync(file)) throw new Error(`Required actual-source test is absent: ${file}`);
    receipt.sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: paths.sourceRoot, encoding: 'utf8', windowsHide: true }).trim();
    receipt.sourceBefore = checkpoints();
    receipt.configSha256 = hash(receipt.configPath);
    receipt.state = 'Checking effective Jest config'; save();
    process.env.NODE_PATH = [paths.apiNodeModules, paths.workspaceNodeModules].join(path.delimiter);
    Module._initPaths();
    const invocation = buildInvocation(testPaths, outputPath);
    const preflight = await preflightInvocation(invocation, preflightPath);
    receipt.effectiveConfigPreflight = { evidencePath: preflightPath, passed: preflight.passed, projectPaths: invocation.projectPaths, configSha256: preflight.configSha256 };
    if (receipt.configSha256 !== preflight.configSha256 || receipt.configSha256 !== hash(receipt.configPath)) throw new Error('Runtime config changed before test launch');
    receipt.state = 'Running focused Jest'; save();
    const { runCLI } = paths.dependencyRequire('jest');
    const { results } = await runCLI(invocation.argv, invocation.projectPaths);
    receipt.sourceAfter = checkpoints();
    receipt.sourcesUnchangedDuringRun = JSON.stringify(receipt.sourceBefore) === JSON.stringify(receipt.sourceAfter);
    receipt.configUnchangedDuringRun = receipt.configSha256 === hash(receipt.configPath);
    receipt.result = { success: results.success, suitesPassed: results.numPassedTestSuites, suitesFailed: results.numFailedTestSuites, testsPassed: results.numPassedTests, testsFailed: results.numFailedTests, testsPending: results.numPendingTests, runtimeErrorSuites: results.numRuntimeErrorTestSuites };
    receipt.state = results.success && receipt.sourcesUnchangedDuringRun && receipt.configUnchangedDuringRun ? 'Passed' : 'Failed';
    process.exitCode = receipt.state === 'Passed' ? 0 : 1;
  } catch (error) {
    receipt.state = 'Failed'; receipt.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1;
    console.error(error);
  } finally { receipt.finishedAtUtc = new Date().toISOString(); save(); }
}
main();
