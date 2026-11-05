'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requiredPortfolioSdkMember } = require('./runtime-closure-contract.cjs');
const { inspectArtifact } = require('./alpine-runtime-probe.cjs');
const frozen = require('../../../../docs/runtime-production-closure-20261014/RUNTIME-CLOSURE-CONTRACT.json');
const manifestBytes = Buffer.from(fs.readFileSync(path.join(__dirname, 'fixtures/claude-agent-sdk-0.3.318-manifest.json'), 'utf8').replace(/\r\n/g, '\n'));

function fixture(t, withGlibc) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-sdk-required-'));
  t.diagnostic(`Retained inert static fixture: ${temp}`);
  const owner = (name, folder, manifestSHA256, libc) => {
    const node = frozen.nodes.find(row => row.name === name && row.version === '0.3.318');
    const root = path.join(temp, folder); fs.mkdirSync(root);
    const platform = { os: ['linux'], cpu: ['arm64'], libc: [libc] };
    return { root, metadata: { name, version: '0.3.318', ...(libc ? platform : {}) },
      manifestSHA256, snapshot: node.key, integrity: node.resolution.integrity,
      ...(libc ? { platformAdmission: { platform, state: libc === 'musl' ? 'TARGET_COMPATIBLE' : 'INACTIVE_INCOMPATIBLE_OPTIONAL', executionAllowed: libc === 'musl' } } : {}) };
  };
  const sdk = owner('@anthropic-ai/claude-agent-sdk', 'sdk', 'f2799dd9c43f751e052bd4d410af96274fdc36f514a2d6666fe148c266a0e990');
  const musl = owner('@anthropic-ai/claude-agent-sdk-linux-arm64-musl', 'musl', '32ecd14d02faddb449e14be5b4d485a637d5353c0363c9019db7bd7d1d257e66', 'musl');
  fs.writeFileSync(path.join(sdk.root, 'manifest.json'), manifestBytes);
  const owners = [sdk, musl];
  if (withGlibc) {
    const glibc = owner('@anthropic-ai/claude-agent-sdk-linux-arm64', 'glibc', 'a341210933888b7305d518dd52ca1fe9b060a88f66d493559b5217c539a7e5c2', 'glibc');
    owners.push(glibc);
    fs.writeFileSync(path.join(glibc.root, 'claude'), 'inert sibling; never needed for required musl admission');
  }
  const edges = owners.slice(1).map(row => ({ from: sdk.snapshot, to: row.snapshot, dependencyName: row.metadata.name,
    kind: 'optionalDependencies', physicalOwner: row.root }));
  return { file: path.join(musl.root, 'claude'), closure: { owners, generated: [], edges, target: { os: 'linux', cpu: 'arm64', libc: 'musl' } } };
}

test('required musl scripts and arbitrary bytes are refused even when discovery skips them and glibc is absent', t => {
  const f = fixture(t, false);
  for (const bytes of ['#!/bin/sh\nprintf "2.1.318"\n', 'arbitrary non-native contents']) {
    fs.writeFileSync(f.file, bytes);
    assert.equal(inspectArtifact(f.file), null, 'reproduces the generic discovery bypass');
    assert.throws(() => requiredPortfolioSdkMember(f.closure), /Portfolio SDK native byte length/);
  }
});

test('a retained glibc sibling cannot hide an undiscovered invalid required musl member', t => {
  const f = fixture(t, true);
  fs.writeFileSync(f.file, '#!/bin/sh\nprintf "2.1.318"\n');
  assert.equal(inspectArtifact(f.file), null);
  assert.throws(() => requiredPortfolioSdkMember(f.closure), /Portfolio SDK native byte length/);
});

test('required musl admission refuses missing members and wrong ELF bytes with no glibc owner', t => {
  const f = fixture(t, false);
  assert.throws(() => requiredPortfolioSdkMember(f.closure), { code: 'ENOENT' });
  const bytes = Buffer.alloc(128);
  bytes.set(Buffer.from('7f454c46', 'hex')); bytes[4] = 2; bytes[5] = 1;
  bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(183, 18); bytes.writeBigUInt64LE(64n, 40);
  bytes.writeUInt16LE(64, 58); bytes.writeUInt16LE(1, 60);
  fs.writeFileSync(f.file, bytes); // Inert header, never invoked.
  assert.throws(() => requiredPortfolioSdkMember(f.closure), /Portfolio SDK native byte length/);
});
