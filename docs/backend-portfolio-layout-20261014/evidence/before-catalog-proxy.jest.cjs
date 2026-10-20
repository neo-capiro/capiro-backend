const path = require('node:path');
const current = require('./focused.jest.cjs');
module.exports = { ...current, moduleNameMapper: {
  '^\\./portfolio-layout\\.helpers\\.js$': path.join(__dirname, 'before-catalog-proxy.ts'),
  '^@nestjs/common$': require.resolve('@nestjs/common', { paths: [path.join(current.rootDir, 'apps/api')] }),
  ...current.moduleNameMapper,
} };
