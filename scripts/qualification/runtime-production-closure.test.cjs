const { test } = require('node:test');
const assert = require('node:assert/strict');
const { closure, resolveEdge, canonicalInputBytes, serializeAudit } = require('./runtime-production-closure.cjs');
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
test('canonical source bytes tolerate checkout CRLF only, preserving exact archive hashes', () => {
  const canonical = Buffer.from('{"x":1}\n');
  assert.equal(canonicalInputBytes(Buffer.from('{"x":1}\r\n'), canonical), canonical);
  assert.equal(canonicalInputBytes(canonical, canonical), canonical);
  assert.throws(() => canonicalInputBytes(Buffer.from('{"x":2}\r\n'), canonical));
  assert.throws(() => canonicalInputBytes(Buffer.from('{ "x":1}\r\n'), canonical));
});
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
test('mixed LF and CRLF checkout preserves the exact canonical bytes', () => {
  const canonical = Buffer.from('first\nsecond\nthird\n');
  assert.equal(canonicalInputBytes(Buffer.from('first\r\nsecond\nthird\r\n'), canonical), canonical);
});
test('lone carriage returns are semantic bytes, never normalized away', () => {
  assert.throws(() => canonicalInputBytes(Buffer.from('name:\rfixture\n'), Buffer.from('name:fixture\n')), /source drift/);
});
test('different invalid UTF8 bytes cannot compare equal through replacement decoding', () => {
  assert.equal(Buffer.from([0xff]).toString('utf8'), Buffer.from([0xfe]).toString('utf8'));
  assert.throws(() => canonicalInputBytes(Buffer.from([0xff]), Buffer.from([0xfe])), /source drift/);
});
test('byte custody requires byte buffers rather than implicit string normalization', () => {
  assert.throws(() => canonicalInputBytes('same\n', Buffer.from('same\n')));
});
test('pure export uses exact LF with a single terminating newline and no BOM', () => {
  const text = serializeAudit({ message: 'fixture\r\nvalue' });
  assert.equal(text, '{\n  "message": "fixture\\r\\nvalue"\n}\n');
  assert(!text.includes('\r')); assert.equal(Buffer.from(text)[0], 123);
});
test('stable contract export excludes audit head and time without mutating input', () => {
  const contract = { schemaVersion: 1, nodes: [{ key: 'fixture@1(peer@2)' }] };
  const first = { sourceHead: 'first', time: 1, runtimeClosureContract: contract };
  const second = { sourceHead: 'second', time: 2, runtimeClosureContract: contract };
  assert.equal(serializeAudit(first, true), serializeAudit(second, true));
  assert.equal(first.sourceHead, 'first'); assert.equal(first.runtimeClosureContract, contract);
});
