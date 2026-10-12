const path = require('node:path');
const packet = path.resolve(__dirname, '..');
const repository = path.resolve(packet, '../..');
const unused = path.join(__dirname, 'unused-import-boundary.cjs');
const external = '../(?:hearing-discovery/hearing-geography|memory/memory-wall.helpers|meri/memory-recall-source.helpers|prisma/prisma.service|engagement/engagement-access.helpers|embeddings/embedder|funding-opportunities/client-award-scope|common/us-states|district-nexus/district-nexus.identity|common/district-code.util|clients/representation-resolver.service|directory/directory.service)';
const local = './(?:canonical-alert.adapter|trajectory-classifier.model|time-bounds|fec-disclaimer|fec-cycles|fec-pac-coverage|term-expansion|bill-keyword-match.helpers|bill-keyword-deadline|comment-deadline.util|client-prepopulation.service|office-recommender.service|insight-generator.service|entity-resolution.service|report-card.service|report-card-docx)';
const escaped = value => value.replace(/^\.\./, '\\.\\.').replace(/^\.\//, '\\./');
module.exports = {
  rootDir: repository,
  testEnvironment: 'node',
  cacheDirectory: path.join('/tmp/capiro-shared-newsletter-dist-fe50-20261012', 'fixture-jest-cache'),
  testMatch: ['<rootDir>/apps/api/src/intelligence/intelligence.mapping-governance.spec.ts',
    '<rootDir>/apps/api/src/meri/meri-stream-launcher.fail-closed.spec.ts'],
  maxWorkers: 1,
  transform: { '^.+\\.ts$': ['/workspace/capirov2/apps/api/node_modules/ts-jest', {
    tsconfig: { module: 'commonjs', target: 'ES2022', esModuleInterop: true,
      experimentalDecorators: true, emitDecoratorMetadata: true, isolatedModules: true }, diagnostics: false,
  }] },
  moduleNameMapper: {
    '^@prisma/client$': unused,
    '^@nestjs/config$': unused,
    '^@capiro/shared$': '/tmp/capiro-shared-newsletter-dist-fe50-20261012/packages/shared/dist/index.js',
    [`^${escaped(external)}\\.js$`]: unused,
    [`^${escaped(local)}\\.js$`]: unused,
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
