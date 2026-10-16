const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('./paths.cjs');

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const normalize = file => path.resolve(file).replaceAll('\\', '/').toLowerCase();
const samePath = (left, right) => typeof left === 'string' && normalize(left) === normalize(right);
const configPath = path.join(__dirname, 'jest.config.cjs');

function buildInvocation(testPaths, outputPath) {
  return {
    argv: { config: configPath, runInBand: true, runTestsByPath: true, cache: false, json: true, testTimeout: 15000, outputFile: outputPath, _: testPaths, $0: 'bounded-current-authority-runtime' },
    // Jest29 rereads non-cwd project directories with argv.config disabled.
    // Giving the config file itself as the project preserves the binding.
    projectPaths: [configPath],
  };
}

async function preflightInvocation(invocation, evidencePath) {
  if (fs.existsSync(evidencePath)) throw new Error('Preserve prior preflight evidence; choose a new output prefix');
  const { readConfigs } = paths.jestConfigRequire('jest-config');
  const configSha256Before = hash(configPath);
  const { configs, globalConfig } = await readConfigs(invocation.argv, invocation.projectPaths);
  const expected = require(configPath);
  const project = configs[0];
  const transformer = paths.dependencyRequire.resolve('ts-jest');
  const guards = [];
  const add = (name, passed) => guards.push({ name, passed: Boolean(passed) });
  add('exactly one explicit config-file project', invocation.projectPaths.length === 1 && samePath(invocation.projectPaths[0], configPath) && configs.length === 1);
  add('actual source root', project && samePath(project.rootDir, paths.sourceRoot) && samePath(globalConfig.rootDir, paths.sourceRoot));
  add('one worker, serial invocation and exact selected test paths', invocation.argv.runInBand === true && globalConfig.maxWorkers === 1 && globalConfig.runTestsByPath === true && JSON.stringify(globalConfig.nonFlagArgs) === JSON.stringify(invocation.argv._));
  add('no inherited setup hooks', project && project.setupFiles.length === 0 && project.setupFilesAfterEnv.length === 0 && !globalConfig.globalSetup && !globalConfig.globalTeardown);
  add('actual node test environment', project && samePath(project.testEnvironment, paths.jestConfigRequire.resolve('jest-environment-node')));
  add('cache and coverage disabled', project && project.cache === false && globalConfig.collectCoverage === false);
  add('bounded global timeout', globalConfig.testTimeout === 15000);
  const expectedOptions = expected.transform['^.+\\.ts$'][1];
  add('exact isolated ts-jest transform/options', project && project.transform.length === 1 && project.transform[0][0] === '^.+\\.ts$' && samePath(project.transform[0][1], transformer) && JSON.stringify(project.transform[0][2]) === JSON.stringify(expectedOptions));
  const selectedTransforms = invocation.argv._.map(file => {
    const match = project?.transform.find(([pattern]) => new RegExp(pattern).test(file));
    const ignored = project?.transformIgnorePatterns.some(pattern => new RegExp(pattern).test(file));
    return { file, filePresent: fs.existsSync(file), pattern: match?.[0], transformer: match?.[1], ignored: Boolean(ignored), expectedTransformer: Boolean(match && samePath(match[1], transformer)) };
  });
  add('every selected actual-source test uses ts-jest', selectedTransforms.length > 0 && selectedTransforms.every(row => row.filePresent && !row.ignored && row.expectedTransformer));
  add('actual shared source mapping', project && project.moduleNameMapper.some(([pattern, destination]) => pattern === '^@capiro/shared$' && samePath(destination, path.join(paths.sourceRoot, 'packages/shared/src/index.ts'))));
  add('actual Clerk crypto mapping', project && project.moduleNameMapper.some(([pattern, destination]) => pattern === '^#crypto$' && samePath(destination, expected.moduleNameMapper['^#crypto$'])));
  add('runtime dependency directories retained', project && [paths.apiNodeModules, paths.workspaceNodeModules].every(directory => project.moduleDirectories.some(value => samePath(value, directory))));
  add('config unchanged during resolution', hash(configPath) === configSha256Before);
  const implementationPath = paths.jestConfigRequire.resolve('jest-config');
  const evidence = {
    verifiedAtUtc: new Date().toISOString(), testsExecuted: false, api: 'jest-config.readConfigs only; no test discovery/transform execution',
    cwd: process.cwd(), nodeVersion: process.version, heapArguments: process.execArgv,
    configPath, configSha256: configSha256Before, projectPaths: invocation.projectPaths,
    invocationFlags: { runInBand: invocation.argv.runInBand, runTestsByPath: invocation.argv.runTestsByPath, cache: invocation.argv.cache, testTimeout: invocation.argv.testTimeout },
    global: { rootDir: globalConfig.rootDir, maxWorkers: globalConfig.maxWorkers, runInBand: globalConfig.runInBand, runTestsByPath: globalConfig.runTestsByPath, nonFlagArgs: globalConfig.nonFlagArgs, testTimeout: globalConfig.testTimeout, collectCoverage: globalConfig.collectCoverage },
    projects: configs.map(value => ({ rootDir: value.rootDir, cache: value.cache, transform: value.transform, transformIgnorePatterns: value.transformIgnorePatterns, setupFiles: value.setupFiles, setupFilesAfterEnv: value.setupFilesAfterEnv, testEnvironment: value.testEnvironment, moduleNameMapper: value.moduleNameMapper, moduleDirectories: value.moduleDirectories, testMatch: value.testMatch })),
    selectedTransforms, guards, passed: guards.every(guard => guard.passed),
    jestConfigImplementation: { file: implementationPath, sha256: hash(implementationPath) },
  };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  if (!evidence.passed) throw new Error('Effective Jest config preflight failed: ' + guards.filter(guard => !guard.passed).map(guard => guard.name).join('; '));
  return evidence;
}

module.exports = { buildInvocation, preflightInvocation };
