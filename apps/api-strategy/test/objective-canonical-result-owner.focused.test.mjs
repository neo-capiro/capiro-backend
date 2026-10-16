import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const appSource = await readFile(new URL('../src/planner/objective-canonical-application.ts', import.meta.url), 'utf8');
const appUrl = data(stripTypeScriptTypes(appSource));
const nestUrl = data('export const Injectable = () => value => value;');
const ownerSource = await readFile(new URL('../src/meri/objective-canonical-result-owner.ts', import.meta.url), 'utf8');
const ownerUrl = data(stripTypeScriptTypes(ownerSource.replace('@Injectable()', '')
  .replace("'@nestjs/common'", JSON.stringify(nestUrl))
  .replace("'../planner/objective-canonical-application.js'", JSON.stringify(appUrl))));
const { ObjectiveCanonicalResultOwner } = await import(ownerUrl);

const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const source = Object.freeze({ generationJobId: id(1), sourceAdmissionSha256: 'a'.repeat(64),
  binding: Object.freeze({ tenantId: id(2), actorId: 'user_original', conversationId: id(3),
    runId: id(4), attemptId: id(5), workerId: id(6), writerFence: 1 }) });
const result = () => ({ schemaVersion: 1, generationJobId: source.generationJobId,
  sourceAdmissionSha256: source.sourceAdmissionSha256, binding: { ...source.binding },
  checkedAtMs: 10, expiresAtMs: 20 });
const unavailable = error => error?.code === 'AUTHORITY_UNAVAILABLE';

test('uncomposed or unavailable retained bridge fails closed', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(new ObjectiveCanonicalResultOwner().read(source, { signal }), unavailable);
  let called = false;
  const owner = new ObjectiveCanonicalResultOwner({ available: () => false,
    read: async () => { called = true; return result(); } });
  await assert.rejects(owner.read(source, { signal }), unavailable);
  assert.equal(called, false);
});

test('passes only a pinned copy of the persisted source and original signal to the bridge', async () => {
  const signal = new AbortController().signal;
  const owner = new ObjectiveCanonicalResultOwner({ available: () => true,
    read: async (actual, options) => {
      assert.deepEqual(actual, source);
      assert.notStrictEqual(actual, source);
      assert.equal(Object.isFrozen(actual), true);
      assert.equal(Object.isFrozen(actual.binding), true);
      assert.strictEqual(options.signal, signal);
      return result();
    } });
  assert.deepEqual(await owner.read(source, { signal }), result());
});

test('rejects a different job, admission or run binding before Core sees a result', async () => {
  const signal = new AbortController().signal;
  for (const changed of [
    { generationJobId: id(9) },
    { sourceAdmissionSha256: 'b'.repeat(64) },
    { binding: { ...source.binding, runId: id(9) } },
  ]) {
    const owner = new ObjectiveCanonicalResultOwner({ available: () => true,
      read: async () => ({ ...result(), ...changed }) });
    await assert.rejects(owner.read(source, { signal }), unavailable);
  }
});

test('aborted operations and bridge errors cannot return an authority result', async () => {
  const before = new AbortController(); before.abort();
  let called = false;
  const owner = new ObjectiveCanonicalResultOwner({ available: () => true,
    read: async () => { called = true; return result(); } });
  await assert.rejects(owner.read(source, { signal: before.signal }), unavailable);
  assert.equal(called, false);
  const during = new AbortController();
  const interrupted = new ObjectiveCanonicalResultOwner({ available: () => true,
    read: async () => { during.abort(); return result(); } });
  await assert.rejects(interrupted.read(source, { signal: during.signal }), unavailable);
  const broken = new ObjectiveCanonicalResultOwner({ available: () => true,
    read: async () => { throw new Error('private source details'); } });
  await assert.rejects(broken.read(source, { signal: new AbortController().signal }), unavailable);
});
