'use strict';
// Public CA setup for the private Meri origin. Run before the application Node
// process: NODE_EXTRA_CA_CERTS is read only at process startup.
const { X509Certificate, createHash } = require('node:crypto');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

function materializeMeriControlCa(env = process.env) {
  const keys = ['MERI_CONTROL_ORIGIN', 'MERI_CONTROL_CA_BASE64', 'MERI_CONTROL_CA_SHA256'];
  if (keys.every((key) => env[key] === undefined)) return null;
  const refuse = () => { throw new Error('MERI_CONTROL_CA_CONFIGURATION_REFUSED'); };
  if (env.MERI_CONTROL_ORIGIN !== 'https://control.meri-preview.internal' ||
      !/^[a-f0-9]{64}$/.test(env.MERI_CONTROL_CA_SHA256 ?? '') ||
      typeof env.MERI_CONTROL_CA_BASE64 !== 'string' || !env.MERI_CONTROL_CA_BASE64 ||
      env.MERI_CONTROL_CA_BASE64.length > 16384 || !env.TMPDIR || env.NODE_EXTRA_CA_CERTS) refuse();
  const bytes = Buffer.from(env.MERI_CONTROL_CA_BASE64, 'base64');
  if (bytes.toString('base64') !== env.MERI_CONTROL_CA_BASE64) refuse();
  const pem = bytes.toString('utf8');
  if (!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/.test(pem)) refuse();
  let certificate;
  try { certificate = new X509Certificate(pem); } catch { refuse(); }
  if (!certificate.ca || !certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey) ||
      Date.now() < Date.parse(certificate.validFrom) || Date.now() >= Date.parse(certificate.validTo) ||
      createHash('sha256').update(certificate.raw).digest('hex') !== env.MERI_CONTROL_CA_SHA256) refuse();
  // A unique directory and exclusive creation avoid following a pre-existing
  // file/symlink in shared scratch. No certificate or configuration is logged.
  const file = join(mkdtempSync(join(env.TMPDIR, 'capiro-meri-ca-')), 'control-ca.pem');
  writeFileSync(file, bytes, { flag: 'wx', mode: 0o400 });
  return file;
}

module.exports = { materializeMeriControlCa };
if (require.main === module) {
  try { const file = materializeMeriControlCa(); if (file) process.stdout.write(file); }
  catch { process.stderr.write('MERI_CONTROL_CA_CONFIGURATION_REFUSED\n'); process.exitCode = 78; }
}
