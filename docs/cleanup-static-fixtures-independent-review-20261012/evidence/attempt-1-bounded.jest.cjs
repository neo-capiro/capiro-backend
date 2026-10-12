const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const unused = path.join(__dirname, 'unused-import-boundary.cjs');
const external = '../(?:hearing-discovery/hearing-geography|memory/memory-wall.helpers|meri/memory-recall-source.helpers|prisma/prisma.service|engagement/engagement-access.helpers|embeddings/embedder|funding-opportunities/client-award-scope|common/us-states|district-nexus/district-nexus.identity|common/district-code.util|clients/representation-resolver.service|directory/directory.service)';
const local = './(?:canonical-alert.adapter|trajectory-classifier.model|time-bounds|fec-disclaimer|fec-cycles|fec-pac-coverage|term-expansion|bill-keyword-match.helpers|bill-keyword-deadline|comment-deadline.util|client-prepopulation.service|office-recommender.service|insight-generator.service|entity-resolution.service|report-card.service|report-card-docx)';
const escaped = value => value.replace(/^\.\./, '\\.\\.').replace(/^\.\//, '\\./');
module.exports = {
  rootDir: root,
  roots: [path.join(root, 'apps/api')],
  testEnvironment: '/workspace/capirov2/apps/api/node_modules/jest-environment-node',
  cacheDirectory: '/tmp/capirov2-static-fixture-independent-transform-cache-20261012',
  testMatch: ['<rootDir>/apps/api/src/intelligence/intelligence.mapping-governance.spec.ts', '<rootDir>/apps/api/src/meri/meri-stream-launcher.fail-closed.spec.ts', '<rootDir>/apps/api/src/outreach-v3/state/outreach-content-skeleton-boundaries.spec.ts'],
  maxWorkers: 1,
  transform: { '^.+\\.ts$': ['/workspace/capirov2/apps/api/node_modules/ts-jest', {
    tsconfig: { module: 'commonjs', target: 'ES2022', esModuleInterop: true, resolveJsonModule: true,
      experimentalDecorators: true, emitDecoratorMetadata: true, isolatedModules: true }, diagnostics: false,
  }] },
  moduleNameMapper: {
    '^@prisma/client$': unused,
    '^@nestjs/config$': unused,
    '^@capiro/shared$': '/tmp/capiro-shared-independent-consumer-20261012/node_modules/@capiro/shared/dist/index.js',
    [`^${escaped(external)}\\.js$`]: unused,
    [`^${escaped(local)}\\.js$`]: unused,
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
