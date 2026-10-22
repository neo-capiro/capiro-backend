'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  disposableConfiguration, composeSchema, dropOwnedSchema, childEnvironment,
} = require('./a1-disposable-postgres.cjs');

const validUrl = 'postgresql://a1_owner:fake-test-password@127.0.0.1:54329/a1_disposable_0123456789abcdef';
const enabled = { A1_NATIVE_PG_URL: validUrl, A1_NATIVE_PG_ALLOW_DISPOSABLE: '1' };
const core = `generator client {
 provider = "prisma-client-js"
 previewFeatures = ["postgresqlExtensions"]
}
datasource db {
 provider = "postgresql"
 url = env("DATABASE_URL")
 extensions = [pgvector(map: "vector")]
}
model User {
 id String @id @db.Uuid
 @@map("users")
}`;
const workspace = `generator client {
 provider = "prisma-client-js"
 output = "../generated/prisma-client"
}
datasource db {
 provider = "postgresql"
 url = env("WORKSPACE_DATABASE_URL")
}
model WsDraft {
 id String @id @db.Uuid
 @@map("ws_draft")
}`;

test('never falls back to ordinary or workspace database URLs', () => {
  assert.equal(disposableConfiguration({ DATABASE_URL: validUrl, WORKSPACE_DATABASE_URL: validUrl }), null);
});

test('requires the explicit disposable opt-in', () => {
  assert.throws(() => disposableConfiguration({ A1_NATIVE_PG_URL: validUrl }), /ALLOW_DISPOSABLE=1/);
  assert.throws(() => disposableConfiguration({ ...enabled, A1_NATIVE_PG_ALLOW_DISPOSABLE: 'true' }), /ALLOW_DISPOSABLE=1/);
});

test('accepts only explicit loopback disposable database identity', () => {
  const receipt = disposableConfiguration(enabled);
  assert.equal(receipt.database, 'a1_disposable_0123456789abcdef');
  assert.equal(receipt.url, validUrl);
  assert.equal(disposableConfiguration({ ...enabled, A1_NATIVE_PG_URL: validUrl.replace('127.0.0.1', '[::1]') }).database, receipt.database);
});

for (const [name, url] of [
  ['remote host', validUrl.replace('127.0.0.1', 'db.example.test')],
  ['non-disposable database', validUrl.replace('a1_disposable_0123456789abcdef', 'capiro')],
  ['public schema query', `${validUrl}?schema=public`],
  ['socket override', `${validUrl}?host=%2Ftmp`],
  ['options override', `${validUrl}?options=-csearch_path%3Dpublic`],
  ['service override', `${validUrl}?service=production`],
  ['fragment', `${validUrl}#public`],
  ['implicit port', validUrl.replace(':54329', '')],
  ['privileged port', validUrl.replace(':54329', ':443')],
  ['wrong protocol', validUrl.replace('postgresql:', 'https:')],
  ['path injection', validUrl.replace('a1_disposable_0123456789abcdef', 'a1_disposable_x%2Fpublic')],
]) {
  test(`refuses ${name} before opening a connection`, () => {
    assert.throws(() => disposableConfiguration({ ...enabled, A1_NATIVE_PG_URL: url }), /loopback port/);
  });
}

test('configuration diagnostics never include credential material', () => {
  try {
    disposableConfiguration({ ...enabled, A1_NATIVE_PG_URL: validUrl.replace('127.0.0.1', 'db.example.test') });
    assert.fail('expected refusal');
  } catch (error) {
    assert.doesNotMatch(String(error), /fake-test-password|a1_owner|db\.example\.test/);
  }
});

test('Prisma child has only the owned URL and no inherited endpoint, cloud or loader options', () => {
  const saved = {};
  const poison = {
    DATABASE_URL: 'postgresql://live.invalid/core', DIRECT_URL: 'postgresql://live.invalid/core',
    SHADOW_DATABASE_URL: 'postgresql://live.invalid/core', PGHOST: 'live.invalid',
    PGOPTIONS: '-c search_path=public', AWS_SECRET_ACCESS_KEY: 'not-a-real-secret',
    NODE_OPTIONS: '--require unwanted-loader.cjs', PRISMA_CONFIG: '/tmp/unwanted-config',
  };
  for (const [key, value] of Object.entries(poison)) { saved[key] = process.env[key]; process.env[key] = value; }
  try {
    const child = childEnvironment(`${validUrl}?schema=a1_native_0123456789abcdef01234567`);
    assert.equal(child.DATABASE_URL, `${validUrl}?schema=a1_native_0123456789abcdef01234567`);
    for (const key of Object.keys(poison).filter((key) => key !== 'DATABASE_URL')) assert.equal(child[key], undefined);
  } finally {
    for (const key of Object.keys(poison)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('combines canonical schemas without a second connection or generator', () => {
  const result = composeSchema(core, workspace, 'model Receipt {\n id String @id\n}');
  assert.equal((result.match(/^datasource /gm) || []).length, 1);
  assert.equal((result.match(/^generator /gm) || []).length, 1);
  assert.match(result, /model User/);
  assert.match(result, /model WsDraft/);
  assert.match(result, /model Receipt/);
  assert.doesNotMatch(result, /WORKSPACE_DATABASE_URL|generated\/prisma-client/);
});

test('refuses direct or shadow endpoints even with the expected primary URL', () => {
  for (const setting of ['directUrl', 'shadowDatabaseUrl']) {
    assert.throws(() => composeSchema(core.replace('extensions =', `${setting} = env("OTHER_URL")\n extensions =`)), /direct\/shadow/);
  }
});

test('refuses duplicate declarations instead of merging unrelated models', () => {
  assert.throws(() => composeSchema(core, workspace.replace('WsDraft', 'User')), /Duplicate fixture declaration: User/);
});

test('fixture additions cannot supply a connection or generator', () => {
  assert.throws(() => composeSchema(core, undefined, workspace), /models\/enums only/);
});

const schema = 'a1_native_0123456789abcdef01234567';
const token = 'a1-native-owner:0123456789abcdef0123456789abcdef0123456789abcdef';

test('cleanup leaves an absent schema alone', async () => {
  const calls = [];
  await dropOwnedSchema({ query: async (...args) => { calls.push(args); return { rows: [] }; } }, schema, token);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0][0], /DROP/);
});

test('cleanup refuses a preexisting or replaced schema without the exact ownership marker', async () => {
  const calls = [];
  await assert.rejects(() => dropOwnedSchema({ query: async (...args) => { calls.push(args); return { rows: [{ owner: 'foreign' }] }; } }, schema, token), /Refusing to drop/);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0][0], /DROP/);
});

test('cleanup targets only the exact random owned schema', async () => {
  const calls = [];
  await dropOwnedSchema({ query: async (...args) => { calls.push(args); return { rows: [{ owner: token }] }; } }, schema, token);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][1], [schema]);
  assert.equal(calls[1][0], `DROP SCHEMA "${schema}" CASCADE`);
});

test('cleanup rejects malformed receipts before any database call', async () => {
  let calls = 0;
  const client = { query: async () => { calls += 1; return { rows: [] }; } };
  await assert.rejects(() => dropOwnedSchema(client, 'public', token), /ownership receipt/);
  await assert.rejects(() => dropOwnedSchema(client, schema, 'foreign'), /ownership receipt/);
  assert.equal(calls, 0);
});
