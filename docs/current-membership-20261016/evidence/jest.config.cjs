const path = require('node:path');
const { sourceRoot, apiNodeModules, workspaceNodeModules, dependencyRequire, jestConfigRequire, primaryTests, supportingTests } = require('./paths.cjs');

const clerkNodeCrypto = path.join(path.dirname(dependencyRequire.resolve('@clerk/backend/package.json')), 'dist', 'runtime', 'node', 'crypto.js');

// Deliberately standalone: do not inherit API worker-database/setup hooks.
// Tests and source-relative file/VM reads remain in the actual source checkout.
module.exports = {
  rootDir: sourceRoot,
  testEnvironment: jestConfigRequire.resolve('jest-environment-node'),
  testMatch: [...primaryTests, ...supportingTests].map(file => file.replaceAll('\\', '/')),
  setupFiles: [],
  setupFilesAfterEnv: [],
  transform: {
    '^.+\\.ts$': [dependencyRequire.resolve('ts-jest'), {
      isolatedModules: true,
      diagnostics: true,
      tsconfig: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'Node',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        esModuleInterop: true,
        strict: true,
        skipLibCheck: true,
      },
    }],
  },
  transformIgnorePatterns: ['/node_modules/'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^#crypto$': clerkNodeCrypto,
    '^@capiro/shared$': path.join(sourceRoot, 'packages', 'shared', 'src', 'index.ts'),
  },
  moduleDirectories: ['node_modules', apiNodeModules, workspaceNodeModules],
  modulePaths: [apiNodeModules, workspaceNodeModules],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  cache: false,
  cacheDirectory: path.join(__dirname, 'cache'),
  maxWorkers: 1,
};
