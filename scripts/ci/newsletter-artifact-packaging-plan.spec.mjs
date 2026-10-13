import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonicalNewsletterManifest } from '../lib/newsletter-static-release-contract.mjs';
import { inspectFrontendStandaloneManifest, readFrontendStandaloneArtifact, NEWSLETTER_ACCEPTED_SOURCE_PROFILE } from '../lib/frontend-standalone-artifact-contract.mjs';
import { NEWSLETTER_FRONTEND_ARTIFACT_PROFILE as PROFILE, parseNewsletterBuildInvocation,
  createNewsletterArtifactPackagingPlan, assembleNewsletterReleaseArtifact } from '../lib/newsletter-artifact-packaging-plan.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assets = canonicalNewsletterManifest(), byUrl = new Map(assets.map(entry => [entry.publicPath, entry]));
const identity = (bytes, url) => bytes.equals(Buffer.from(url)) ? byUrl.get(url) : null;
const source = { repository: PROFILE.repository, commit: 'c'.repeat(40) };
const sourceProfile = structuredClone(NEWSLETTER_ACCEPTED_SOURCE_PROFILE);
sourceProfile.activeCommit = source.commit;
sourceProfile.acceptedSources = [{ commit: source.commit, tree: 'd'.repeat(40),
  qualificationReceipt: { repository: source.repository, commit: 'e'.repeat(40),
    path: 'docs/synthetic-source-acceptance/RECEIPT.json', sha256: 'f'.repeat(64) } }];
const sourceAdmissionFixture = { kind: 'newsletter-source-admission-fixture',
  label: 'synthetic accepted source profile', profile: sourceProfile };
const model = { newsletterIdentity: identity, fixtureLabel: 'synthetic already-built input', sourceAdmissionFixture };
const pins = options => ({ sourceRepository: options.sourceRepository, sourceCommit: options.sourceCommit,
  manifestSha256: options.manifestSha256, runtimeTarget: { os: 'linux', arch: 'amd64', libc: 'musl', nodeMajor: 24 } });
function argv(options, mode = '--plan') {
  return [mode, ...Object.entries({ '--standalone-dir': options.standaloneDir, '--public-dir': options.publicDir,
    '--static-dir': options.staticDir, '--manifest': options.manifestPath, '--manifest-sha256': options.manifestSha256,
    '--source-repository': options.sourceRepository, '--source-commit': options.sourceCommit,
    '--target-platform': options.targetPlatform, '--target-libc': options.targetLibc,
    '--target-node-major': options.targetNodeMajor, '--backend-source-commit': options.backendSourceCommit,
    '--output-dir': options.outputDir }).flat()];
}
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'newsletter-assembly-'));
  const standalone = root + '/standalone', pub = root + '/public', statics = root + '/static';
  await Promise.all([standalone, pub, statics].map(folder => fs.mkdir(folder)));
  const files = new Map([
    ['apps/web/server.js', Buffer.from('// inert compiled fixture; never execute')],
    ['apps/web/.next/BUILD_ID', Buffer.from('synthetic')],
    ['apps/web/.next/required-server-files.json', Buffer.from(JSON.stringify({ config: { output: 'standalone' },
      relativeAppDir: 'apps/web', files: ['.next/BUILD_ID', '.next/server/route.js'] }))],
    ['apps/web/.next/server/route.js', Buffer.from('// inert declared route')],
    ['apps/web/.next/server/route.js.nft.json', Buffer.from(JSON.stringify({ files: ['../../../../node_modules/alias/runtime.js'] }))],
    ['node_modules/runtime/runtime.js', Buffer.from('// inert dependency; never import')],
    ['apps/web/.next/static/chunk.js', Buffer.from('// inert static file')],
    ...assets.map(entry => ['apps/web/public' + entry.publicPath, Buffer.from(entry.publicPath)]),
  ]);
  const links = new Map([['node_modules/alias', './runtime']]);
  for (const [name, bytes] of files) {
    const destination = name.startsWith('apps/web/public/') ? pub + '/' + name.slice('apps/web/public/'.length)
      : name.startsWith('apps/web/.next/static/') ? statics + '/' + name.slice('apps/web/.next/static/'.length)
      : standalone + '/' + name;
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes);
  }
  for (const [name, target] of links) await fs.symlink(target, standalone + '/' + name);
  const manifest = { schemaVersion: 1, artifactType: 'capiro-frontend-next-standalone', source,
    runtimeTarget: { os: 'linux', arch: 'amd64', libc: 'musl', nodeMajor: 24 }, serverEntrypoint: 'apps/web/server.js',
    entries: [...files].map(([name, bytes]) => ({ path: name, type: 'file', bytes: bytes.length, sha256: sha(bytes) }))
      .concat([...links].map(([name, target]) => ({ path: name, type: 'symlink', target }))) };
  const manifestPath = root + '/producer-manifest.json', bytes = Buffer.from(JSON.stringify(manifest));
  await fs.writeFile(manifestPath, bytes);
  const options = { standaloneDir: standalone, publicDir: pub, staticDir: statics, manifestPath, manifestSha256: sha(bytes),
    sourceRepository: source.repository, sourceCommit: source.commit, targetPlatform: 'linux/amd64',
    targetLibc: 'musl', targetNodeMajor: '24', backendSourceCommit: 'a'.repeat(40), outputDir: root + '/published' };
  try { await run({ root, files, links, options, manifest, manifestBytes: bytes }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function absent(value) { await assert.rejects(fs.lstat(value), { code: 'ENOENT' }); }
function ioWith(changes) { return { ...fs, ...changes }; }
const readPorts = { lstat: fs.lstat, readdir: fs.readdir, realpath: fs.realpath, readlink: fs.readlink, readFile: fs.readFile };

test('physical synthetic assembly publishes complete bytes, links and durable receipt then independently revalidates', async () => {
  await fixture(async ({ files, links, options, manifestBytes, root }) => {
    const receipt = await assembleNewsletterReleaseArtifact(options, model);
    assert.equal(receipt.status, 'PASS'); assert.equal(receipt.syntheticModel, true);
    assert.equal(receipt.sourceAdmission.syntheticSourceApprovalModel, true);
    assert.equal(receipt.sourceAdmission.sourceApprovalProofVerified, false);
    assert.equal(receipt.sourceAdmission.sourceAcceptedByReviewedPolicy, false);
    assert.equal(receipt.artifact.actualArtifactBytesVerified, false); assert.equal(receipt.shippingAuthorized, false);
    assert.equal(receipt.atomicDirectoryPublishPerformed, true); assert.equal(receipt.durableFilesAndDirectorySyncPerformed, true);
    assert.deepEqual(receipt.runtimeTarget, { os: 'linux', arch: 'amd64', libc: 'musl', nodeMajor: 24 });
    assert.equal(receipt.counts.regularFiles, files.size); assert.equal(receipt.counts.symlinks, links.size);
    assert.equal(receipt.backendSourceIndependentlyVerified, false);
    assert.equal(receipt.builtinFilesystemEffectsPerformed, true);
    assert.equal(receipt.filesystemEffectsIndependentlyAttested, false);
    const saved = JSON.parse(await fs.readFile(options.outputDir + '/build-receipt.json', 'utf8')); assert.deepEqual(saved, receipt);
    assert.deepEqual(await fs.readFile(options.outputDir + '/manifest.json'), manifestBytes);
    for (const [name, bytes] of files) assert.deepEqual(await fs.readFile(options.outputDir + '/rootfs/' + name), bytes);
    for (const [name, target] of links) assert.equal(await fs.readlink(options.outputDir + '/rootfs/' + name), target);
    const independentlyRead = await readFrontendStandaloneArtifact({ artifactDir: options.outputDir,
      pins: pins(options), newsletterIdentity: identity, ports: readPorts });
    assert.equal(independentlyRead.artifactEntriesSha256, receipt.artifact.artifactEntriesSha256);
    assert.equal(independentlyRead.actualArtifactBytesVerified, false);
    await assert.rejects(readFrontendStandaloneArtifact({ artifactDir: options.outputDir, pins: pins(options), ports: readPorts }));
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.newsletter-assembly-') || name.endsWith('.lock')), false);
  });
});

test('canonical inspector has no ports and rejects invalid declaration/pin grammar before input scans', async () => {
  await fixture(async ({ options, manifest }) => {
    assert.equal(inspectFrontendStandaloneManifest({ manifestBytes: Buffer.from(JSON.stringify(manifest)), pins: pins(options) }).entries.length, manifest.entries.length);
    for (const mutate of [value => { value.schemaVersion = 2; }, value => { value.source.commit = 'b'.repeat(40); },
      value => { value.entries[0].path = '../escape'; }, value => { value.entries[0].extra = true; },
      value => { value.entries.push(value.entries[0]); }]) {
      const changed = structuredClone(manifest); mutate(changed); const bytes = Buffer.from(JSON.stringify(changed));
      await fs.writeFile(options.manifestPath, bytes); let scans = 0;
      await assert.rejects(assembleNewsletterReleaseArtifact({ ...options, manifestSha256: sha(bytes) }, { ...model,
        io: ioWith({ readdir: async () => { scans++; throw new Error('scan must not run'); } }) }));
      assert.equal(scans, 0); await absent(options.outputDir);
    }
  });
});

for (const [name, change] of [
  ['unapproved source', { sourceCommit: 'b'.repeat(40) }], ['wrong repository', { sourceRepository: 'other/repo' }],
  ['old Node', { targetNodeMajor: '22' }], ['wrong libc', { targetLibc: 'glibc' }], ['unknown platform', { targetPlatform: 'linux/x64' }],
  ['coerced pin', { backendSourceCommit: { toString() { throw new Error('coercion'); } } }],
  ['manifest newline', { manifestSha256: 'a'.repeat(64) + '\n' }], ['credential output', { outputDir: '/tmp/.aws/release' }],
]) test(`assembly refuses ${name} before filesystem calls`, async () => {
  await fixture(async ({ options }) => {
    let calls = 0; await assert.rejects(assembleNewsletterReleaseArtifact({ ...options, ...change }, { ...model,
      io: ioWith({ lstat: async () => { calls++; throw new Error('unexpected file call'); } }) }));
    assert.equal(calls, 0);
  });
});

test('parser and plan require explicit run mode and every literal option, with no I/O admission', async () => {
  await fixture(async ({ options }) => {
    const parsed = parseNewsletterBuildInvocation(argv(options)); assert.equal(parsed.mode, 'plan');
    assert.equal(createNewsletterArtifactPackagingPlan(parsed.options).assemblyPerformed, false);
    assert.equal(parseNewsletterBuildInvocation(['--help']).mode, 'help');
    for (const bad of [[], ['--run'], argv(options).slice(1), [...argv(options), '--run'],
      [...argv(options), '--unknown', 'x'], argv(options).slice(0, -2),
      argv(options).map(value => value === '--static-dir' ? '--public-dir' : value)]) assert.throws(() => parseNewsletterBuildInvocation(bad));
    await absent(options.outputDir);
  });
});

test('argv pins and manifest checksum drift cannot create a lock or output', async () => {
  await fixture(async ({ options, root }) => {
    await assert.rejects(assembleNewsletterReleaseArtifact({ ...options, manifestSha256: '0'.repeat(64) }, model));
    await absent(options.outputDir); assert.equal((await fs.readdir(root)).some(name => name.endsWith('.lock')), false);
  });
});

test('unlisted payloads, modified compiled bytes and changed internal link refuse before output writes', async () => {
  for (const mode of ['extra', 'bytes', 'link']) await fixture(async ({ options }) => {
    if (mode === 'extra') await fs.writeFile(options.standaloneDir + '/unexpected.js', 'never execute');
    if (mode === 'bytes') await fs.writeFile(options.standaloneDir + '/apps/web/server.js', 'tampered');
    if (mode === 'link') { await fs.unlink(options.standaloneDir + '/node_modules/alias'); await fs.symlink('/tmp', options.standaloneDir + '/node_modules/alias'); }
    await assert.rejects(assembleNewsletterReleaseArtifact(options, model)); await absent(options.outputDir);
  });
});

test('declared resource overrun refuses before any raw input enumeration', async () => {
  await fixture(async ({ options, manifest }) => {
    const next = structuredClone(manifest); next.entries[0].bytes = PROFILE.maxFileBytes + 1;
    const bytes = Buffer.from(JSON.stringify(next)); await fs.writeFile(options.manifestPath, bytes); let scans = 0;
    await assert.rejects(assembleNewsletterReleaseArtifact({ ...options, manifestSha256: sha(bytes) }, { ...model,
      io: ioWith({ readdir: async () => { scans++; throw new Error('unexpected scan'); } }) }), /resource budget/);
    assert.equal(scans, 0);
  });
});

test('existing output, replay and input/output overlap preserve current bytes', async () => {
  await fixture(async ({ options }) => {
    await assembleNewsletterReleaseArtifact(options, model);
    const before = await fs.readFile(options.outputDir + '/build-receipt.json');
    await assert.rejects(assembleNewsletterReleaseArtifact(options, model), /already exists/);
    assert.deepEqual(await fs.readFile(options.outputDir + '/build-receipt.json'), before);
    let calls = 0; await assert.rejects(assembleNewsletterReleaseArtifact({ ...options, outputDir: options.publicDir + '/nested' }, { ...model,
      io: ioWith({ lstat: async () => { calls++; throw new Error('overlap'); } }) }), /overlaps/); assert.equal(calls, 0);
  });
});

test('cooperative same-output concurrency allows one immutable publication and cleans its lock', async () => {
  await fixture(async ({ options }) => {
    let release, entered; const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const first = assembleNewsletterReleaseArtifact(options, { ...model, io: ioWith({ mkdtemp: async value => {
      entered(); await gate; return fs.mkdtemp(value);
    } }) });
    await waiting; await assert.rejects(assembleNewsletterReleaseArtifact(options, model), { code: 'EEXIST' });
    release(); const receipt = await first; assert.equal(receipt.status, 'PASS'); await absent(options.outputDir + '.newsletter-assembly.lock');
  });
});

test('failed staged rename rolls back only owned scratch and leaves inputs untouched', async () => {
  await fixture(async ({ options, root, manifestBytes }) => {
    await assert.rejects(assembleNewsletterReleaseArtifact(options, { ...model, io: ioWith({ rename: async () => {
      throw new Error('injected rename failure');
    } }) }), /injected rename/);
    await absent(options.outputDir); await absent(options.outputDir + '.newsletter-assembly.lock');
    assert.deepEqual(await fs.readFile(options.manifestPath), manifestBytes);
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.newsletter-assembly-')), false);
  });
});

test('unlabelled injected identity cannot pretend to be production assembly', async () => {
  await fixture(async ({ options }) => {
    await assert.rejects(assembleNewsletterReleaseArtifact(options, { newsletterIdentity: identity, sourceAdmissionFixture }), /labelled synthetic/);
    await absent(options.outputDir);
  });
});

test('actual canonical shell help/noargs/unknown/plan remain explicit and remove ambient Node loaders', async () => {
  await fixture(async ({ options }) => {
    const shell = ROOT + '/scripts/build-newsletter-release.sh';
    const run = args => spawnSync('/bin/sh', [shell, ...args], { encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require /nonexistent-newsletter-loader.cjs',
        OPENAI_API_KEY: 'synthetic-not-a-credential', HTTPS_PROXY: 'https://example.invalid' } });
    assert.equal(run(['--help']).status, 0); assert.equal(run([]).status, 2);
    assert.equal(run(['--node-bin', process.execPath, '--unknown']).status, 2);
    const planned = run(['--node-bin', process.execPath, ...argv(options)]);
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(JSON.parse(planned.stdout).assemblyPerformed, false); await absent(options.outputDir);
  });
});


test('physical assembly preserves0755 helper execute bits without authenticating modes or granting runtime admission', async () => {
  await fixture(async ({ options }) => {
    const name = 'node_modules/runtime/runtime.js';
    await fs.chmod(options.standaloneDir + '/' + name, 0o755);
    const before = await fs.readFile(options.standaloneDir + '/' + name);
    const receipt = await assembleNewsletterReleaseArtifact(options, model);
    assert.equal((await fs.stat(options.outputDir + '/rootfs/' + name)).mode & 0o777, 0o755);
    assert.deepEqual(await fs.readFile(options.outputDir + '/rootfs/' + name), before);
    assert.equal(receipt.counts.fileModes.find(entry => entry.path === name).mode, '755');
    assert.equal(receipt.permissionHandling.privilegedBitsPreserved, false);
    assert.equal(receipt.permissionHandling.manifestAuthenticatesPermissions, false);
    assert.equal(receipt.permissionHandling.runtimePermissionsCompatibilityVerified, false);
    assert.equal(receipt.syntheticModel, true); assert.equal(receipt.shippingAuthorized, false);
  });
});

for (const phase of ['prepublication', 'postrename']) test(`${phase} directory fsync failure never returns a success receipt and rolls back owned output`, async () => {
  await fixture(async ({ options, root, manifestBytes }) => {
    let failed = false;
    await assert.rejects(assembleNewsletterReleaseArtifact(options, { ...model, io: ioWith({ open: async (value, ...args) => {
      const handle = await fs.open(value, ...args);
      const selected = phase === 'prepublication' ? value.includes('/.newsletter-assembly-') && value.endsWith('/rootfs')
        : value === root;
      if (!selected) return handle;
      return { sync: async () => { failed = true; throw new Error(`injected ${phase} fsync failure`); }, close: () => handle.close() };
    } }) }), new RegExp(`injected ${phase} fsync`));
    assert.equal(failed, true); await absent(options.outputDir); await absent(options.outputDir + '.newsletter-assembly.lock');
    assert.deepEqual(await fs.readFile(options.manifestPath), manifestBytes);
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.newsletter-assembly-')), false);
  });
});


for (const [name, key, value] of [
  ['credentials.json manifest', 'manifestPath', '/tmp/credentials.json'],
  ['envrc manifest', 'manifestPath', '/tmp/.envrc'],
  ['npmrc manifest', 'manifestPath', '/tmp/.npmrc'],
  ['service account manifest', 'manifestPath', '/tmp/service-account.json'],
  ['private key manifest', 'manifestPath', '/tmp/private.key'],
  ['uppercase AWS output', 'outputDir', '/tmp/.AWS/output'],
  ['env variant output', 'outputDir', '/tmp/.env.local/output'],
]) test(`canonical path owner refuses ${name} before filesystem callbacks`, async () => {
  await fixture(async ({ options }) => {
    let calls = 0;
    await assert.rejects(assembleNewsletterReleaseArtifact({ ...options, [key]: value }, { ...model,
      io: ioWith({ lstat: async () => { calls++; throw new Error('private input must not be touched'); } }) }));
    assert.equal(calls, 0);
  });
});

test('unlabelled filesystem injection refuses before callbacks and extra labels cannot alter production mode', async () => {
  await fixture(async ({ options }) => {
    let calls = 0; await assert.rejects(assembleNewsletterReleaseArtifact(options,
      { sourceAdmissionFixture, io: ioWith({ lstat: async () => { calls++; throw new Error('synthetic callback'); } }) }), /labelled synthetic/);
    assert.equal(calls, 0);
    await assert.rejects(assembleNewsletterReleaseArtifact(options, { fixtureLabel: 'not a port', sourceAdmissionFixture }), /labelled synthetic/);
  });
});

test('explicit filesystem model cannot attest atomic or durable native filesystem effects', async () => {
  await fixture(async ({ options }) => {
    const receipt = await assembleNewsletterReleaseArtifact(options, { ...model, io: ioWith({}) });
    assert.equal(receipt.status, 'PASS'); assert.equal(receipt.syntheticModel, true);
    assert.equal(receipt.builtinFilesystem, false);
    assert.equal(receipt.builtinFilesystemEffectsPerformed, false);
    assert.equal(receipt.filesystemEffectsIndependentlyAttested, false);
    assert.equal(receipt.atomicDirectoryPublishPerformed, false);
    assert.equal(receipt.durableFilesAndDirectorySyncPerformed, false);
    assert.equal(receipt.artifact.actualArtifactBytesVerified, false);
    assert.equal(receipt.shippingAuthorized, false);
  });
});

test('stat/read growth consumes at most manifest budget+1 bytes and never calls whole-file readFile', async () => {
  await fixture(async ({ options }) => {
    let consumed = 0, wholeReads = 0;
    await assert.rejects(assembleNewsletterReleaseArtifact(options, { ...model, io: ioWith({ open: async (value, ...args) => {
      const handle = await fs.open(value, ...args);
      if (value !== options.manifestPath) return handle;
      return { readFile: async () => { wholeReads++; throw new Error('unbounded read'); },
        read: async (buffer, offset, length) => { consumed += length; buffer.fill(120, offset, offset + length); return { bytesRead: length }; },
        close: () => handle.close() };
    } }) }), /bounded snapshot read/);
    assert.equal(wholeReads, 0); assert.equal(consumed, PROFILE.maxManifestBytes + 1); await absent(options.outputDir);
  });
});
