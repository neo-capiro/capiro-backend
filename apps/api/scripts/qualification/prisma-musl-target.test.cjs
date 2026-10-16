const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.join(__dirname, 'prisma-musl-target.cjs');
test('only the packaging target changes in the full application schema', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musl-schema-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const file = path.join(dir, 'schema.prisma'); fs.writeFileSync(file, original);
  const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const revised = fs.readFileSync(file, 'utf8');
  assert.equal(revised.replace('"linux-musl-arm64-openssl-3.0.x"', '"linux-arm64-openssl-3.0.x"'), original);
});
test('AMD64 image-local generator selects Prisma musl/OpenSSL3 without changing models', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musl-amd64-schema-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const file = path.join(dir, 'schema.prisma'); fs.writeFileSync(file, original);
  const result = spawnSync(process.execPath, [script, file], {
    encoding: 'utf8', env: { ...process.env, CAPIRO_QUALIFICATION_ARCH: 'x64' },
  });
  assert.equal(result.status, 0, result.stderr);
  const revised = fs.readFileSync(file, 'utf8');
  assert.equal(revised.replace('"linux-musl-openssl-3.0.x"', '"linux-arm64-openssl-3.0.x"'), original);
});
for (const targets of ['["native"]', '["linux-arm64-openssl-3.0.x", "linux-arm64-openssl-3.0.x"]']) {
  test(`unexpected generator target fails without modifying schema: ${targets}`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musl-schema-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'schema.prisma'), original = `generator client { binaryTargets = ${targets} }\nmodel Inert { id Int @id }\n`;
    fs.writeFileSync(file, original);
    const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
}
