'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, X509Certificate } = require('node:crypto');
const { mkdtempSync, readFileSync, readdirSync, rmSync, realpathSync, lstatSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const https = require('node:https');
const { materializeMeriControlCa } = require('./meri-control-ca.cjs');
const root = resolve(__dirname, '../../../..');
const ca = readFileSync(join(root, 'infra/cdk/lib/preview/meri-control-ca.pem'));
const pin = 'e177a1bc059a0fd7c54740f6db6619c992af01d1fda804d6c2058f0bd53995d4';
const environment = (dir) => ({ TMPDIR: dir, MERI_CONTROL_ORIGIN: 'https://control.meri-preview.internal',
  MERI_CONTROL_CA_BASE64: ca.toString('base64'), MERI_CONTROL_CA_SHA256: pin });
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'meri-ca-test-'));
  t.after(() => {
    assert.equal(lstatSync(dir).isSymbolicLink(), false);
    assert.ok(realpathSync(dir).startsWith(realpathSync(tmpdir()) + sep));
    rmSync(dir, { recursive: true });
  });
  return dir;
}

test('absent private configuration preserves existing startup without writing', (t) => {
  const dir = scratch(t);
  assert.equal(materializeMeriControlCa({ TMPDIR: dir, NODE_EXTRA_CA_CERTS: 'existing.pem' }), null);
  assert.deepEqual(readdirSync(dir), []);
});
test('the verified public CA is materialized with its DER pin, including CRLF PEM', (t) => {
  const dir = scratch(t), env = environment(dir);
  assert.equal(createHash('sha256').update(new X509Certificate(ca).raw).digest('hex'), pin);
  const first = materializeMeriControlCa(env);
  assert.deepEqual(readFileSync(first), ca);
  const crlf = ca.toString('utf8').replace(/\r?\n/g, '\r\n');
  const second = materializeMeriControlCa({ ...env, MERI_CONTROL_CA_BASE64: Buffer.from(crlf).toString('base64') });
  assert.notEqual(first, second);
  assert.equal(new X509Certificate(readFileSync(second)).fingerprint256, new X509Certificate(ca).fingerprint256);
});
test('partial, conflicting, malformed or unpinned trust refuses before any write', (t) => {
  const dir = scratch(t), env = environment(dir);
  const missing = Object.keys(env).filter((key) => key !== 'TMPDIR').map((key) => ({ ...env, [key]: undefined }));
  for (const input of [...missing, ...[
    { MERI_CONTROL_ORIGIN: 'https://app.capiro.ai' },
    { MERI_CONTROL_ORIGIN: 'https://control.meri-preview.internal/' },
    { MERI_CONTROL_CA_SHA256: '0'.repeat(64) },
    { MERI_CONTROL_CA_BASE64: env.MERI_CONTROL_CA_BASE64 + '\n' },
    { MERI_CONTROL_CA_BASE64: Buffer.from('not a certificate').toString('base64') },
    { MERI_CONTROL_CA_BASE64: Buffer.concat([ca, ca]).toString('base64') },
    { NODE_EXTRA_CA_CERTS: 'existing.pem' }, { TMPDIR: '' },
  ].map((patch) => ({ ...env, ...patch }))]) assert.throws(() => materializeMeriControlCa(input), /CONFIGURATION_REFUSED/);
  assert.deepEqual(readdirSync(dir), []);
});
test('CLI refuses partial configuration without printing supplied data', (t) => {
  const dir = scratch(t);
  assert.throws(() => execFileSync(process.execPath, [join(__dirname, 'meri-control-ca.cjs')], {
    env: { ...process.env, TMPDIR: dir, MERI_CONTROL_ORIGIN: 'private-test-marker' }, stdio: 'pipe',
  }), (error) => error.status === 78 && error.stdout.length === 0 &&
    error.stderr.toString() === 'MERI_CONTROL_CA_CONFIGURATION_REFUSED\n');
});
test('both service entrypoints export trust before application dispatch and both Strategy images carry the helper', () => {
  for (const service of ['api', 'api-strategy']) {
    const entrypoint = readFileSync(join(root, 'apps', service, 'scripts/entrypoint.sh'), 'utf8');
    const setup = entrypoint.indexOf('NODE_EXTRA_CA_CERTS=$(node /app/apps/api/scripts/lib/meri-control-ca.cjs)');
    assert.ok(setup > 0 && setup < entrypoint.indexOf('case "${1:-serve}" in'));
    assert.ok(entrypoint.slice(setup).includes('export NODE_EXTRA_CA_CERTS'));
    execFileSync('sh', ['-n', join(root, 'apps', service, 'scripts/entrypoint.sh')], { stdio: 'pipe' });
  }
  for (const name of ['Dockerfile', 'Dockerfile.alpine'])
    assert.ok(readFileSync(join(root, 'apps/api-strategy', name), 'utf8')
      .includes('apps/api/scripts/lib/meri-control-ca.cjs /app/apps/api/scripts/lib/meri-control-ca.cjs'));
});
test('a fresh Node process trusts only the validated CA and still verifies the server hostname', async (t) => {
  const dir = scratch(t), cert = join(dir, 'ca.pem'), key = join(dir, 'key.pem');
  // Disposable, synthetic test PKI only. No application/provider connection.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'pipe' });
  const bytes = readFileSync(cert), certificate = new X509Certificate(bytes);
  const file = materializeMeriControlCa({ ...environment(dir), MERI_CONTROL_CA_BASE64: bytes.toString('base64'),
    MERI_CONTROL_CA_SHA256: createHash('sha256').update(certificate.raw).digest('hex') });
  const server = https.createServer({ key: readFileSync(key), cert: bytes }, (_req, res) => res.end('trusted'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const port = server.address().port;
    const fetchChild = (host, trusted) => new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.NODE_EXTRA_CA_CERTS;
      if (trusted) env.NODE_EXTRA_CA_CERTS = file;
      const child = spawn(process.execPath, ['-e', `fetch('https://${host}:${port}').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exitCode=1)`],
        { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('error', reject); child.on('exit', (code) => resolve({ code, stdout }));
    });
    assert.deepEqual(await fetchChild('localhost', true), { code: 0, stdout: 'trusted' });
    assert.equal((await fetchChild('localhost', false)).code, 1);
    assert.equal((await fetchChild('127.0.0.1', true)).code, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
