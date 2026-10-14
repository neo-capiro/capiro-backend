const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
module.exports = {
  rootDir: root, roots: [path.join(root, 'apps/api/src/clients')], testEnvironment: 'node',
  testMatch: ['**/client-targets.service.spec.ts', '**/client-targets.objective-destination*.spec.ts', '**/objective-destination.shared.spec.ts'],
  cache: false, cacheDirectory: path.join(root, '.qualification-cache/directory-jest'), maxWorkers: 1,
  transform: { '^.+\\.ts$': path.join(__dirname, 'typescript-transformer.cjs') },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1', '^sanitize-html$': path.join(__dirname, 'native-sanitize.cjs') },
};
