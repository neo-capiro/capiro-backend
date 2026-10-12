const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const ts = require(require.resolve('typescript', { paths: [path.resolve(__dirname, '../../../apps/api')] }));
const root = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'SOURCE-MANIFEST.json'), 'utf8'));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const blob = data => crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
const all = [...manifest.fixtures, ...manifest.readers];
const inputs = new Map(all.map(row => [row.path, fs.readFileSync(path.join(root, row.path))]));
const controls = [];
function check(name, callback) { callback(); controls.push({ name, passed: true }); }
function verify(values) {
  for (const row of manifest.fixtures) {
    const data = values.get(row.path);
    assert.ok(data, `missing ${row.path}`);
    assert.equal(data.length, row.bytes, `fixture size ${row.path}`);
    assert.equal(sha(data), row.sha256, `fixture identity ${row.path}`);
    assert.equal(blob(data), row.blob, `fixture blob ${row.path}`);
  }
  for (const row of manifest.readers) {
    const data = values.get(row.path);
    assert.ok(data, `missing ${row.path}`);
    let value = data.toString('utf8');
    for (const { before, after } of row.replacements) {
      assert.equal(value.split(after).length - 1, 1, `reader operand ${row.path}`);
      value = value.replace(after, before);
    }
    assert.equal(sha(Buffer.from(value)), row.originalSha256, `original case/assertion identity ${row.path}`);
    assert.equal(blob(Buffer.from(value)), row.originalBlob, `original reader blob ${row.path}`);
  }
}
check('candidate changes exactly the seven fixtures and three readers', () => {
  const actual = cp.execFileSync('git', ['diff', '--name-only', manifest.base, '44eda40f7951e73722566862649939e51a8f151a'], { cwd: root, encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(actual, all.map(row => row.path).sort());
});
check('exact frozen fixtures and original inverse reader bodies pass', () => verify(inputs));
check('backend identity verifies with no Web input in the checked map', () => {
  assert.equal([...inputs.keys()].some(value => value.startsWith('apps/web/')), false);
  verify(inputs);
});
for (const row of manifest.fixtures) {
  check(`fixture byte mutation refused: ${row.path}`, () => {
    const values = new Map(inputs); const changed = Buffer.from(values.get(row.path)); changed[changed.length - 2] ^= 1;
    values.set(row.path, changed); assert.throws(() => verify(values));
  });
  check(`missing fixture refused: ${row.path}`, () => { const values = new Map(inputs); values.delete(row.path); assert.throws(() => verify(values), /missing/); });
  check(`fixture exact current Web and published proposal: ${row.path}`, () => {
    const original = cp.execFileSync('git', ['show', `${manifest.base}:${row.source}`], { cwd: root });
    const proposed = cp.execFileSync('git', ['show', `${manifest.proposal}:${row.path}`], { cwd: root });
    assert.deepEqual(original, inputs.get(row.path)); assert.deepEqual(proposed, original);
  });
}
for (const row of manifest.readers) {
  check(`original AST statement count and bodies retained: ${row.path}`, () => {
    const original = cp.execFileSync('git', ['show', `${manifest.base}:${row.path}`], { cwd: root, encoding: 'utf8' });
    let candidate = inputs.get(row.path).toString('utf8');
    for (const { before, after } of row.replacements) candidate = candidate.replace(after, before);
    assert.equal(candidate, original);
    const first = ts.createSourceFile(row.path, original, ts.ScriptTarget.Latest, true);
    const second = ts.createSourceFile(row.path, candidate, ts.ScriptTarget.Latest, true);
    assert.equal(first.statements.length, second.statements.length);
    assert.deepEqual(first.parseDiagnostics, []); assert.deepEqual(second.parseDiagnostics, []);
  });
  for (const [kind, mutate] of [
    ['assertion', value => value.replace('expect(', 'expect.skip(')],
    ['case', value => value.replace(/\b(?:it|test)\(/, 'test.skip(')],
    ['original Web operand restored', value => value.replace(row.replacements[0].after, row.replacements[0].before)],
    ['duplicate reader operand', value => value + '\n' + row.replacements[0].after],
  ]) check(`${kind} drift refused: ${row.path}`, () => {
    const values = new Map(inputs); const old = values.get(row.path).toString('utf8'); const changed = mutate(old);
    assert.notEqual(changed, old); values.set(row.path, Buffer.from(changed)); assert.throws(() => verify(values));
  });
}
process.stdout.write(JSON.stringify({ checks: controls.length, controls, candidate: '44eda40f7951e73722566862649939e51a8f151a', base: manifest.base, mutationInputs: 'in-memory maps only', nativeRuntimeQualification: false, fixtureServedUiQualification: false }, null, 2) + '\n');
