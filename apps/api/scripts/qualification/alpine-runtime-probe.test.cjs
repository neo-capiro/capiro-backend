const assert = require('node:assert/strict');
const test = require('node:test');
const { assertDumbInitVersion } = require('./alpine-runtime-probe.cjs');

function probe(script, options) {
  return assertDumbInitVersion(process.execPath, ['-e', script], options);
}

test('accepts the pinned version from stderr, as observed in the failed Alpine build', () => {
  probe('process.stderr.write("dumb-init v1.2.5\\n")');
});
test('accepts the same pinned version from stdout', () => {
  probe('process.stdout.write("dumb-init v1.2.5\\n")');
});
test('rejects a different version on either stream', () => {
  for (const stream of ['stdout', 'stderr']) {
    assert.throws(() => probe(`process.${stream}.write("dumb-init v1.2.4\\n")`), /did not match/);
  }
});
test('rejects nonzero exit even when the expected version is printed', () => {
  assert.throws(() => probe('process.stderr.write("dumb-init v1.2.5\\n");process.exit(7)'), /must exit successfully/);
});
test('rejects empty output', () => {
  assert.throws(() => probe(''), /did not match/);
});
test('kills and rejects a command exceeding the deadline', () => {
  assert.throws(() => probe('setInterval(()=>{},1000)', { timeout: 100 }), error => error.code === 'ETIMEDOUT');
});
test('rejects output exceeding the bounded buffer', () => {
  assert.throws(() => probe('process.stdout.write("x".repeat(2*1024*1024))'), error => error.code === 'ENOBUFS');
});
test('rejects an unavailable executable', () => {
  assert.throws(() => assertDumbInitVersion(require('node:path').join(__dirname, 'nonexistent-qualification-executable')), error => error.code === 'ENOENT');
});
