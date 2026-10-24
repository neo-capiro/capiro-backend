const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { assertGeneratedPrismaClient } = require('./alpine-runtime-probe.cjs');

const cli = require.resolve('prisma/build/index.js');
const source = `// Source comment and deliberately unaligned fields.
generator client {
provider = "prisma-client-js"
}
datasource db {
provider = "postgresql"
url = env("DATABASE_URL")
}
model Parent {
id String @id
label String @default("keep // spaces")
children Child[]
}
model Child {
id String @id
parentId String
parent Parent @relation(fields: [parentId], references: [id])
}
`;
let generated;
test.before(() => {
  assert.equal(require('prisma/package.json').version, '5.22.0');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-format-fixture-'));
  try {
    const file = path.join(dir, 'schema.prisma'); fs.writeFileSync(file, source);
    execFileSync(process.execPath, [cli, 'format', '--schema', file], { timeout: 30000, stdio: 'pipe' });
    generated = fs.readFileSync(file, 'utf8');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
function fixture(companion = generated) {
  return { schema: source, generatedSchema: companion, cli,
    client: { _engineConfig: { clientVersion: '5.22.0', activeProvider: 'postgresql', inlineSchema: companion } } };
}

test('actual Prisma formatting admits source spacing and changed whole-line comments', () => {
  const companion = generated.replace('// Source comment and deliberately unaligned fields.', '// Different generated divider') + '\n\n';
  assert.doesNotThrow(() => assertGeneratedPrismaClient(fixture(companion)));
});
test('a stale generated model missing a field fails', () => {
  const companion = generated.replace(/^\s*label\s+String[^\n]*\n/m, '');
  assert.notEqual(companion, generated);
  assert.throws(() => assertGeneratedPrismaClient(fixture(companion)), /models differ/);
});
test('a missing opposite relation is refused, never silently repaired by formatting the companion', () => {
  const companion = generated.replace(/^\s*children\s+Child\[\][^\n]*\n/m, '');
  assert.notEqual(companion, generated);
  assert.throws(() => assertGeneratedPrismaClient(fixture(companion)), /models differ/);
});
test('string values containing comment markers and whitespace remain exact', () => {
  const companion = generated.replace('keep // spaces', 'keep// spaces');
  assert.notEqual(companion, generated);
  assert.throws(() => assertGeneratedPrismaClient(fixture(companion)), /models differ/);
});
test('a field rename retaining its database mapping is still a different client', () => {
  const companion = generated.replace(/^(\s*)label(\s+String[^\n]*)/m, '$1other$2 @map("label")');
  assert.notEqual(companion, generated);
  assert.throws(() => assertGeneratedPrismaClient(fixture(companion)), /models differ/);
});
test('a matching companion cannot hide a different loaded client inline schema', () => {
  const input = fixture(); input.client._engineConfig.inlineSchema += '// stale loaded client';
  assert.throws(() => assertGeneratedPrismaClient(input), /loaded Prisma client differs/);
});
test('wrong client version/provider and oversized schemas fail before normalization', () => {
  for (const [key, value] of [['clientVersion', '5.21.0'], ['activeProvider', 'sqlite']]) {
    const input = fixture(); input.client._engineConfig[key] = value;
    assert.throws(() => assertGeneratedPrismaClient(input), /generated Prisma/);
  }
  assert.throws(() => assertGeneratedPrismaClient({ ...fixture(), schema: 'x'.repeat(8 * 1024 * 1024 + 1) }), /bounded Prisma/);
});
test('the real installed PrismaClient binds its actual companion without a database connection', () => {
  const owner = fs.realpathSync(require.resolve('@prisma/client/package.json'));
  const companion = path.join(path.dirname(path.dirname(path.dirname(owner))), '.prisma/client/schema.prisma');
  const schema = fs.readFileSync(companion, 'utf8');
  const { PrismaClient } = require('@prisma/client');
  assert.doesNotThrow(() => assertGeneratedPrismaClient({ schema, generatedSchema: schema, cli, client: new PrismaClient() }));
});
