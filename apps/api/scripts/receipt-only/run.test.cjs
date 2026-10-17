'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MIGRATION, verifyBundle } = require('./verify-bundle.cjs');
const { stageBundle, makePrismaUrl, compareLedger, requireRuntime } = require('./run.cjs');

const repo = path.resolve(__dirname, '../../../..');
function blob(relative) {
  return execFileSync('git', [
    '-c', `safe.directory=${repo.replaceAll('\\', '/')}`,
    '-C', repo, 'show', `HEAD:${relative}`,
  ], { maxBuffer: 2 * 1024 * 1024 });
}
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

test('qualified image schema reverses to exact three-file canonical Prisma isolate', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'capiro-receipt-test-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const image = path.join(scratch, 'image');
  const imageMigration = path.join(image, 'migrations', MIGRATION);
  fs.mkdirSync(imageMigration, { recursive: true });
  const canonicalSchema = blob('apps/api/prisma/schema.prisma');
  assert.equal(canonicalSchema.length, 989415);
  assert.equal(sha256(canonicalSchema), 'b532f09179cdba78145816650512424188180b06a89c956150d9955c5009913b');
  const transformed = canonicalSchema.toString('utf8').replace(
    '"linux-arm64-openssl-3.0.x"', '"linux-musl-openssl-3.0.x"');
  assert.equal(sha256(Buffer.from(transformed)), 'c909a6ce3610f35b9179473af3bf6f418a6e47b4c5ba761bac157aa41b9b0498');
  fs.writeFileSync(path.join(image, 'schema.prisma'), transformed);
  fs.writeFileSync(path.join(image, 'migrations', 'migration_lock.toml'), blob('apps/api/prisma/migrations/migration_lock.toml'));
  fs.writeFileSync(path.join(imageMigration, 'migration.sql'), blob(`apps/api/prisma/migrations/${MIGRATION}/migration.sql`));
  const staged = path.join(scratch, 'staged');
  fs.mkdirSync(staged);
  const root = stageBundle(staged, image);
  const result = verifyBundle(root);
  assert.equal(result.migrationSha256, '31a1dac55108a3f1300e4e6533e4f7f7be738438a89715179ee695f38928b211');
  fs.writeFileSync(path.join(root, 'migrations', 'unexpected.sql'), 'SELECT 1');
  assert.throws(() => verifyBundle(root), /unexpected file/);
  fs.rmSync(path.join(root, 'migrations', 'unexpected.sql'));
  fs.appendFileSync(path.join(root, 'migrations', MIGRATION, 'migration.sql'), '\n');
  assert.throws(() => verifyBundle(root), /byte length changed/);
});

test('Prisma URL binds public, strict TLS and absolute single-CA path', () => {
  const value = makePrismaUrl('a:@/b', '/dev/shm/fixed/rds.pem');
  const url = new URL(value);
  assert.equal(url.hostname, 'capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv.cluster-csryw28ai752.us-east-1.rds.amazonaws.com');
  assert.equal(url.pathname, '/capiro');
  assert.equal(url.password, 'a%3A%40%2Fb');
  assert.equal(url.searchParams.get('schema'), 'public');
  assert.equal(url.searchParams.get('sslmode'), 'require');
  assert.equal(url.searchParams.get('sslaccept'), 'strict');
  assert.equal(url.searchParams.get('sslcert'), '/dev/shm/fixed/rds.pem');
});

test('task guard rejects URL and PostgreSQL environment overrides before connection', () => {
  assert.throws(() => requireRuntime({ NODE_OPTIONS:'', DATABASE_URL:'postgresql://other' }, ['node']), /database URL override/);
  assert.throws(() => requireRuntime({ NODE_OPTIONS:'', PGOPTIONS:'-c search_path=other' }, ['node']), /PostgreSQL environment override/);
  assert.throws(() => requireRuntime({ NODE_OPTIONS:'--require ./other.cjs' }, ['node']), /Node preload/);
});

test('ledger comparison preserves all old IDs and admits exactly the canonical receipt', () => {
  const old = { id:'old-id', migration_name:'old', checksum:'old-hash', finished_at:'yes', rolled_back_at:null };
  const receipt = { id:'new-id', migration_name:MIGRATION,
    checksum:'31a1dac55108a3f1300e4e6533e4f7f7be738438a89715179ee695f38928b211',
    finished_at:'yes', rolled_back_at:null };
  const pre = { ledger:[old] };
  const post = { ledger:[old,receipt] };
  compareLedger(pre, post, receipt.checksum);
  assert.throws(() => compareLedger(pre, { ledger:[{ ...old, checksum:'changed' },receipt] }, receipt.checksum));
  assert.throws(() => compareLedger(pre, { ledger:[old,receipt,{ ...receipt, id:'second' }] }, receipt.checksum));
  assert.throws(() => compareLedger(pre, { ledger:[old,{ ...receipt, finished_at:null }] }, receipt.checksum));
});
