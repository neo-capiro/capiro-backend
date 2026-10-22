import assert from 'node:assert/strict';
import test from 'node:test';
import { OWNER_LABEL, ownedPostgresContainer } from './owned-postgres-container.mjs';

const id = 'a'.repeat(64);
const imageId = `sha256:${'b'.repeat(64)}`;
const name = 'core108-fixtures-11111111-1111-4111-8111-111111111111';
const ownershipToken = '22222222-2222-4222-8222-222222222222';
const success = (stdout = '') => ({ status: 0, stdout, stderr: '', signal: null });

function fixture(options = {}) {
  const calls = [];
  let container = options.preexisting ?? null;
  const owned = () => ({
    Id: id, Name: `/${name}`, Image: imageId,
    Config: { Labels: { [OWNER_LABEL]: ownershipToken } },
    HostConfig: { NetworkMode: 'none', Binds: null, Mounts: [], PortBindings: {} },
  });
  const docker = (args) => {
    calls.push(args);
    if (args[0] === 'container') {
      if (options.inspectError) return { status: 2, stdout: '', stderr: 'daemon unavailable' };
      if (!container) return { status: 1, stdout: '', stderr: `Error: No such container: ${args[2]}` };
      assert.ok([name, container.Id].includes(args[2]));
      return success(JSON.stringify([container]));
    }
    if (args[0] === 'create') {
      assert.ok(args.includes(`${OWNER_LABEL}=${ownershipToken}`));
      container = options.created ?? owned();
      if (options.createError) throw options.createError;
      return success(options.createReply ?? `${id}\n`);
    }
    if (args[0] === 'start') {
      assert.equal(args[1], id);
      if (options.startError) throw options.startError;
      return success(`${id}\n`);
    }
    if (args[0] === 'rm') {
      assert.deepEqual(args, ['rm', '-f', '-v', id]);
      container = null;
      return success(`${id}\n`);
    }
    throw new Error(`Unexpected mocked process: ${JSON.stringify(args)}`);
  };
  return {
    lifecycle: ownedPostgresContainer({ docker, imageId, name, ownershipToken }), calls, owned,
    replace: (next) => { container = next; },
  };
}

test('ownership and ID are verified before start; cleanup removes only that ID', () => {
  const f = fixture();
  assert.equal(f.lifecycle.start(), id);
  assert.deepEqual(f.calls.map((args) => args[0]), ['container', 'create', 'container', 'start']);
  assert.deepEqual(f.lifecycle.cleanup(), { attempted: true, removed: true });
  assert.deepEqual(f.calls.at(-1), ['rm', '-f', '-v', id]);
});

for (const [label, error] of [
  ['failure', new Error('docker start exited 125')],
  ['timeout', Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' })],
]) {
  test(`startup ${label} retains ownership and cleanup removes the created resources`, () => {
    const f = fixture({ startError: error });
    assert.throws(() => f.lifecycle.start(), (actual) => actual === error);
    assert.equal(f.lifecycle.id, id);
    assert.deepEqual(f.lifecycle.cleanup(), { attempted: true, removed: true });
    assert.deepEqual(f.calls.at(-1), ['rm', '-f', '-v', id]);
  });
}

test('even a preexisting container with the same ownership label is never started or removed', () => {
  const base = fixture();
  const f = fixture({ preexisting: base.owned() });
  assert.throws(() => f.lifecycle.start(), /Refusing an existing container/);
  assert.deepEqual(f.lifecycle.cleanup(), { attempted: false, removed: false });
  assert.deepEqual(f.calls, [['container', 'inspect', name]]);
});

for (const options of [
  { createError: Object.assign(new Error('create timed out after creation'), { code: 'ETIMEDOUT' }) },
  { createReply: '' },
]) {
  test(`ambiguous create ${options.createError ? 'timeout' : 'reply'} recovers only the owned ID`, () => {
    const f = fixture(options);
    assert.throws(() => f.lifecycle.start());
    assert.equal(f.lifecycle.id, undefined);
    assert.deepEqual(f.lifecycle.cleanup(), { attempted: true, removed: true });
    assert.equal(f.lifecycle.id, id);
    assert.equal(f.calls.some((args) => args[0] === 'start'), false);
    assert.deepEqual(f.calls.at(-2), ['container', 'inspect', name]);
    assert.deepEqual(f.calls.at(-1), ['rm', '-f', '-v', id]);
  });
}

test('an ambiguous create cannot remove a foreign container that won the name race', () => {
  const foreign = fixture().owned();
  foreign.Config.Labels[OWNER_LABEL] = 'foreign-owner';
  const f = fixture({ created: foreign, createError: new Error('name conflict') });
  assert.throws(() => f.lifecycle.start(), /name conflict/);
  assert.throws(() => f.lifecycle.cleanup(), /Refusing foreign container ownership/);
  assert.equal(f.calls.some((args) => ['start', 'rm'].includes(args[0])), false);
});

for (const field of ['name', 'image', 'token']) {
  test(`cleanup rechecks ${field} instead of trusting a previously returned ID`, () => {
    const f = fixture();
    f.lifecycle.start();
    const changed = f.owned();
    if (field === 'name') changed.Name = '/foreign';
    if (field === 'image') changed.Image = `sha256:${'c'.repeat(64)}`;
    if (field === 'token') changed.Config.Labels[OWNER_LABEL] = 'foreign-owner';
    f.replace(changed);
    assert.throws(() => f.lifecycle.cleanup(), /Refusing foreign container/);
    assert.equal(f.calls.some((args) => args[0] === 'rm'), false);
  });
}

test('an inspect transport failure is not interpreted as absence', () => {
  const f = fixture({ inspectError: true });
  assert.throws(() => f.lifecycle.start(), /daemon unavailable/);
  assert.deepEqual(f.lifecycle.cleanup(), { attempted: false, removed: false });
  assert.equal(f.calls.length, 1);
});
