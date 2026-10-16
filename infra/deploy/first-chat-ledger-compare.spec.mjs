import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const deployDir = dirname(fileURLToPath(import.meta.url));
const migrations = join(deployDir, '..', '..', 'apps', 'api', 'prisma', 'migrations');
const comparator = join(deployDir, 'first-chat-ledger-compare.mjs');
const receipt = '20281016020000_clio_conversation_bootstrap_receipts';
const sourceSha = '13d12a7d7bdbe0be021cb218dd4cf7690cc4420b';

const allRows = readdirSync(migrations, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => ({
    migration_name: entry.name,
    checksum: createHash('sha256')
      .update(readFileSync(join(migrations, entry.name, 'migration.sql'))).digest('hex'),
    finished: true,
    rolled_back: false,
    has_error: false,
  }));
assert.equal(allRows.length, 475);

function envelope(ledger = allRows.filter(row => row.migration_name !== receipt)) {
  return {
    schemaVersion: 1,
    sourceSha,
    attestation: {
      tls_verified: true,
      database_ok: true,
      role_ok: true,
      session_role_ok: true,
      read_only_ok: true,
      writer_ok: true,
      ledger_select_ok: true,
    },
    prerequisites: {
      tenants_present: true,
      conversations_present: true,
      tenant_fn_present: true,
      bypass_fn_present: true,
      app_role_present: true,
    },
    ledger,
  };
}

test('attested ledger comparison accepts only pinned migration states and blocks changed attestations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capiro-ledger-compare-'));
  const path = join(dir, 'ledger.json');
  function compare(input, mode, expected) {
    writeFileSync(path, JSON.stringify(input));
    const args = [comparator, migrations, path, ...(mode === 'post' ? ['--post'] : [])];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expected === 'PASS' ? 0 : 1, result.stderr);
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    if (output) assert.equal(output.result, expected);
    else assert.match(result.stderr, /^BLOCK:/);
  }
  try {
    compare(envelope(), 'pre', 'PASS');
    compare(envelope(allRows), 'post', 'PASS');
    const badChecksum = envelope();
    badChecksum.ledger[0] = { ...badChecksum.ledger[0], checksum: '0'.repeat(64) };
    compare(badChecksum, 'pre', 'BLOCK');
    const badTLS = envelope();
    badTLS.attestation.tls_verified = false;
    compare(badTLS, 'pre', 'BLOCK');
    const wrongDatabase = envelope();
    wrongDatabase.attestation.database_ok = false;
    compare(wrongDatabase, 'pre', 'BLOCK');
    const badReadOnly = envelope();
    badReadOnly.attestation.read_only_ok = false;
    compare(badReadOnly, 'pre', 'BLOCK');
    const badGrant = envelope();
    badGrant.attestation.ledger_select_ok = false;
    compare(badGrant, 'pre', 'BLOCK');
    const missingPrerequisite = envelope();
    missingPrerequisite.prerequisites.conversations_present = false;
    compare(missingPrerequisite, 'pre', 'BLOCK');
    const missingRoleFlag = envelope();
    delete missingRoleFlag.attestation.role_ok;
    compare(missingRoleFlag, 'pre', 'BLOCK');
    compare(envelope().ledger, 'pre', 'BLOCK');
    compare({ ...envelope(), sourceSha: '0'.repeat(40) }, 'pre', 'BLOCK');
  } finally {
    unlinkSync(path);
    rmdirSync(dir);
  }
});
