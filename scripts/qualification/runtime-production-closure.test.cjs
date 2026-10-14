const { test } = require('node:test');
const assert = require('node:assert/strict');
const { closure, resolveEdge } = require('./runtime-production-closure.cjs');
function fixture() {
  return { importers: {
    'apps/api': { dependencies: { workspace: { version: 'link:../../packages/workspace' }, ordinary: { version: '1.0.0(peer@2)' } }, devDependencies: { tooling: { version: '9.0.0' } } },
    'packages/workspace': { dependencies: { alias: { version: 'actual@2.0.0' } } },
  }, snapshots: {
    'ordinary@1.0.0(peer@2)': { optionalDependencies: { platform: '3.0.0' } },
    'platform@3.0.0': { dependencies: { ordinary: '1.0.0(peer@2)' } },
    'actual@2.0.0': {}, 'tooling@9.0.0': {},
  } };
}
test('production BFS preserves workspace, alias, peer-qualified and optional edges, excludes dev roots', () => {
  const result = closure(fixture(), ['apps/api'], ['dependencies', 'optionalDependencies']);
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual([...result.nodes.keys()].sort(), ['actual@2.0.0', 'importer:apps/api', 'importer:packages/workspace', 'ordinary@1.0.0(peer@2)', 'platform@3.0.0'].sort());
  assert.equal(result.edges.length, 5);
  assert.equal(result.nodes.get('actual@2.0.0')[0].kind, 'dependencies');
  assert.equal(result.nodes.get('actual@2.0.0')[1].dependencyName, 'alias');
  assert.equal(result.nodes.get('platform@3.0.0')[1].kind, 'optionalDependencies');
});
test('unresolved optional edges are retained rather than silently omitted', () => {
  const lock = fixture(); delete lock.snapshots['platform@3.0.0'];
  const result = closure(lock, ['apps/api'], ['dependencies', 'optionalDependencies']);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].dependencyName, 'platform');
  assert.equal(result.unresolved[0].kind, 'optionalDependencies');
  assert.equal(result.unresolved[0].to, null);
});
test('missing workspace importer is unresolved and snapshot links cannot invent importers', () => {
  const lock = fixture(); delete lock.importers['packages/workspace'];
  assert.equal(resolveEdge(lock, 'importer:apps/api', 'workspace', { version: 'link:../../packages/workspace' }), null);
  assert.throws(() => resolveEdge(lock, 'ordinary@1', 'workspace', 'link:../../packages/workspace'));
});
