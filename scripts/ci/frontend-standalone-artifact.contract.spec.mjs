import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalNewsletterManifest } from '../lib/newsletter-static-release-contract.mjs';
import { FRONTEND_ARTIFACT_TYPE, FRONTEND_SERVER_ENTRYPOINT, validateFrontendStandaloneArtifact,
  readFrontendStandaloneArtifact, parseFrontendStandaloneInvocation } from '../lib/frontend-standalone-artifact-contract.mjs';

// No Web/source artifact/native process/environment reads. All bytes below are
// inert fixtures; explicit temporary filesystem ports test physical traversal.
// An injected Newsletter identity port explicitly bars byte admission.
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const newsletter = canonicalNewsletterManifest();
const newsletterByUrl = new Map(newsletter.map((entry) => [entry.publicPath, entry]));
const newsletterIdentity = (bytes, path) => bytes.equals(Buffer.from(path)) ? newsletterByUrl.get(path) : null;
const source = { repository: 'fixtures/frontend-standalone', commit: 'a'.repeat(40) };
const runtimeTarget = { os: 'linux', arch: 'amd64', libc: 'glibc', nodeMajor: 24 };
function fixture() {
  const files = new Map([
    [FRONTEND_SERVER_ENTRYPOINT, Buffer.from('// inert server fixture; never execute')],
    ['apps/web/.next/BUILD_ID', Buffer.from('fixture-build')],
    ['apps/web/.next/required-server-files.json', Buffer.from(JSON.stringify({ version: 1,
      config: { output: 'standalone', distDir: '.next' }, relativeAppDir: 'apps/web',
      files: ['.next/BUILD_ID', '.next/routes-manifest.json', '.next/server/app/index.js'] }))],
    ['apps/web/.next/routes-manifest.json', Buffer.from('{"version":3}')],
    ['apps/web/.next/static/chunks/main.js', Buffer.from('// inert static fixture')],
    ['apps/web/.next/server/app/index.js', Buffer.from('// inert route fixture')],
    ['apps/web/.next/server/app/index.js.nft.json', Buffer.from(JSON.stringify({ version: 1,
      files: ['../../../../../node_modules/next-alias/server.js'] }))],
    ['node_modules/next/server.js', Buffer.from('// inert dependency fixture')],
    ...newsletter.map((entry) => ['apps/web/public' + entry.publicPath, Buffer.from(entry.publicPath)]),
  ]);
  return pack(files, new Map([['node_modules/.bin/next', '../next/server.js'], ['node_modules/next-alias', './next']]));
}
const directoryTracePath = 'apps/web/.next/server/app/meri/fixture/run-activity/page.js.nft.json';
const directoryTraceLink = 'apps/web/.next/node_modules/shiki-43d062b67f27bbdc';
function directoryTraceFixture(reference = '../../../../../node_modules/shiki-43d062b67f27bbdc') {
  const data = fixture();
  data.files.set(directoryTracePath, Buffer.from(JSON.stringify({ version: 1, files: [reference] })));
  data.files.set('node_modules/shiki/dist/bundle-full.mjs', Buffer.from('// inert shiki bundle fixture'));
  data.files.set('node_modules/shiki/dist/index.mjs', Buffer.from('// inert shiki index fixture'));
  data.symlinks.set(directoryTraceLink, '../../../../node_modules/shiki');
  return pack(data.files, data.symlinks);
}
function parentTraversalFixture() {
  const data = fixture();
  data.files.set('safe/decoy.txt', Buffer.from('inert lexical decoy'));
  data.files.set('decoy.txt', Buffer.from('inert internal decoy'));
  data.symlinks.set('safe/back', '..');
  data.symlinks.set('nested/alias', '../safe/back');
  data.symlinks.set('bridge', 'nested/alias');
  data.symlinks.set('safe/leading', '../decoy.txt');
  return pack(data.files, data.symlinks);
}
function pack(files, symlinks = new Map(), changes = {}) {
  const manifest = { schemaVersion: 1, artifactType: FRONTEND_ARTIFACT_TYPE, source: { ...source },
    runtimeTarget: { ...runtimeTarget }, serverEntrypoint: FRONTEND_SERVER_ENTRYPOINT,
    entries: [...files].map(([path, bytes]) => ({ path, type: 'file', bytes: bytes.length, sha256: sha(bytes) }))
      .concat([...symlinks].map(([path, target]) => ({ path, type: 'symlink', target }))), ...changes };
  return fromManifest(manifest, files, symlinks);
}
function fromManifest(manifest, files, symlinks = new Map()) {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return { manifest, manifestBytes, files, symlinks, newsletterIdentity, pins: {
    manifestSha256: sha(manifestBytes), sourceRepository: source.repository, sourceCommit: source.commit,
    runtimeTarget: { ...runtimeTarget } } };
}
const validate = (data) => validateFrontendStandaloneArtifact(data);
function portsFor(data, changes = {}) {
  const artifactDir = '/provided/release-artifacts/capiro-frontend', rootfs = artifactDir + '/rootfs';
  const nodes = new Map([['/', 'directory'], ['/provided', 'directory'], ['/provided/release-artifacts', 'directory'],
    [artifactDir, 'directory'], [rootfs, 'directory'], [artifactDir + '/manifest.json', data.manifestBytes]]);
  for (const [path, bytes] of data.files) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) nodes.set(rootfs + '/' + parts.slice(0, i).join('/'), 'directory');
    nodes.set(rootfs + '/' + path, bytes);
  }
  for (const [path, target] of data.symlinks) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) nodes.set(rootfs + '/' + parts.slice(0, i).join('/'), 'directory');
    nodes.set(rootfs + '/' + path, { link: target });
  }
  for (const [path, value] of Object.entries(changes)) {
    if (value === null) nodes.delete(path); else nodes.set(path, value);
  }
  const calls = [];
  const get = (operation, path) => {
    calls.push([operation, path]);
    if (!nodes.has(path)) throw new Error('injected missing metadata/read');
    return nodes.get(path);
  };
  const ports = {
    lstat(path) { const value = get('lstat', path); return {
      isFile: () => Buffer.isBuffer(value), isDirectory: () => value === 'directory',
      isSymbolicLink: () => value !== null && typeof value === 'object' && !Buffer.isBuffer(value) && Object.hasOwn(value, 'link'),
    }; },
    readdir(path) {
      assert.equal(get('readdir', path), 'directory');
      return [...new Set([...nodes.keys()].filter((key) => key.startsWith(path + '/'))
        .map((key) => key.slice(path.length + 1).split('/')[0]))];
    },
    readFile(path) { const value = get('readFile', path); assert.ok(Buffer.isBuffer(value)); return value; },
    readlink(path) { return get('readlink', path).link; },
    realpath(path) { get('realpath', path); return path; },
  };
  return { artifactDir, rootfs, ports, calls };
}
const read = (data, input) => readFrontendStandaloneArtifact({ artifactDir: input.artifactDir,
  ports: input.ports, pins: data.pins, newsletterIdentity });
const rootfsReads = (input) => input.calls.filter(([operation, path]) => operation === 'readFile' && path.startsWith(input.rootfs + '/'));
async function physicalPortsFor(data) {
  const fs = await import('node:fs/promises'), { constants } = await import('node:fs');
  const parent = '/tmp/backend-cleanup-serving-consumers-20261013';
  await fs.mkdir(parent, { recursive: true });
  const artifactDir = await fs.mkdtemp(parent + '/standalone-parent-segment-spec-'), rootfs = artifactDir + '/rootfs';
  try {
    for (const [path, bytes] of data.files) {
      await fs.mkdir(rootfs + '/' + path.slice(0, path.lastIndexOf('/') + 1), { recursive: true });
      await fs.writeFile(rootfs + '/' + path, bytes);
    }
    for (const [path, target] of data.symlinks) {
      await fs.mkdir(rootfs + '/' + path.slice(0, path.lastIndexOf('/') + 1), { recursive: true });
      await fs.symlink(target, rootfs + '/' + path);
    }
    await fs.writeFile(artifactDir + '/manifest.json', data.manifestBytes);
    await fs.writeFile(artifactDir + '/decoy.txt', Buffer.from('inert outside-rootfs decoy'));
    const calls = [];
    const ports = { lstat: fs.lstat, readdir: fs.readdir, realpath: fs.realpath, readlink: fs.readlink,
      readFile: (path) => { calls.push(['readFile', path]); return fs.readFile(path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW }); } };
    return { artifactDir, rootfs, ports, calls, fs, cleanup: () => fs.rm(artifactDir, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(artifactDir, { recursive: true, force: true }); throw error; }
}

test('explicit exhaustive supplied model preserves layout, symlinks, trace closure and source-only boundaries', async () => {
  const receipt = await validate(fixture());
  assert.equal(receipt.serverEntrypoint, FRONTEND_SERVER_ENTRYPOINT);
  assert.equal(receipt.regularFiles, 187); assert.equal(receipt.symlinks, 2);
  assert.equal(receipt.exhaustiveArtifactIndexVerified, true); assert.equal(receipt.safeInternalSymlinksVerified, true);
  assert.equal(receipt.requiredServerFileClosureVerified, true); assert.equal(receipt.traceManifestsVerified, 1);
  assert.equal(receipt.traceFileReferencesVerified, 1); assert.equal(receipt.newsletter.staticPaths, 179);
  assert.deepEqual(receipt.runtimeTarget, runtimeTarget); assert.equal(receipt.runtimeTargetEqualityVerified, true);
  assert.equal(receipt.actualArtifactBytesVerified, false); assert.equal(receipt.nativeRuntimeCompatibilityVerified, false);
  for (const key of ['buildUsedSourceVerified', 'runtimeDependencyClosureVerified', 'localServingVerified', 'deployedServingVerified', 'uiAcceptanceVerified'])
    assert.equal(receipt[key], false);
});
test('physical hashing cannot be replaced by synthetic byte claims without a false admission flag', async () => {
  const data = fixture(); delete data.newsletterIdentity;
  await assert.rejects(validate(data), /artifact byte identity/);
});
for (const [name, change, message] of [
  ['missing entrypoint', (data) => data.files.delete(FRONTEND_SERVER_ENTRYPOINT), /required regular/],
  ['missing BUILD_ID', (data) => data.files.delete('apps/web/.next/BUILD_ID'), /required regular/],
  ['missing required manifest', (data) => data.files.delete('apps/web/.next/required-server-files.json'), /required regular/],
  ['missing static tree', (data) => data.files.delete('apps/web/.next/static/chunks/main.js'), /static/],
  ['missing Newsletter identity', (data) => data.files.delete('apps/web/public/newsletter/capitol.png'), /Newsletter/],
]) test(name, async () => {
  const data = fixture(); change(data); await assert.rejects(validate(pack(data.files, data.symlinks)), message);
});
test('manifest pin, source pin and raw file identity drift each refuse', async () => {
  const data = fixture();
  await assert.rejects(validate({ ...data, pins: { ...data.pins, manifestSha256: '0'.repeat(64) } }), /manifest byte/);
  await assert.rejects(validate({ ...data, pins: { ...data.pins, sourceCommit: 'b'.repeat(40) } }), /source-pin/);
  data.files.set(FRONTEND_SERVER_ENTRYPOINT, Buffer.from('altered'));
  await assert.rejects(validate(data), /byte identity/);
});
test('runtime target declarations require exact explicit equality and cannot establish native compatibility', async () => {
  const data = fixture();
  await assert.rejects(validate({ ...data, pins: { ...data.pins, runtimeTarget: undefined } }), /runtime target/);
  for (const change of [{ arch: 'arm64' }, { libc: 'musl' }])
    await assert.rejects(validate({ ...data, pins: { ...data.pins, runtimeTarget: { ...runtimeTarget, ...change } } }), /target equality/);
  for (const change of [{ os: 'darwin' }, { arch: 'x64' }, { libc: 'unknown' }, { nodeMajor: 22 }])
    await assert.rejects(validate({ ...data, pins: { ...data.pins, runtimeTarget: { ...runtimeTarget, ...change } } }), /runtime target/);
  const musl = fromManifest({ ...data.manifest, runtimeTarget: { ...runtimeTarget, libc: 'musl' } }, data.files, data.symlinks);
  musl.pins.runtimeTarget.libc = 'musl';
  assert.equal((await validate(musl)).nativeRuntimeCompatibilityVerified, false);
});
test('duplicate paths, duplicate JSON keys and ambiguous manifest fields refuse', async () => {
  const data = fixture();
  await assert.rejects(validate(fromManifest({ ...data.manifest, entries: [...data.manifest.entries, data.manifest.entries[0]] }, data.files, data.symlinks)), /duplicate artifact/);
  const manifestBytes = Buffer.from(JSON.stringify(data.manifest).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
  await assert.rejects(validate({ ...data, manifestBytes, pins: { ...data.pins, manifestSha256: sha(manifestBytes) } }), /duplicate/);
  await assert.rejects(validate(fromManifest({ ...data.manifest, guessedBuildProof: true }, data.files, data.symlinks)), /layout/);
});
test('unlisted files, links and symlink drift cannot pass exhaustive index', async () => {
  const data = fixture(); data.files.set('unlisted.js', Buffer.from('unlisted'));
  await assert.rejects(validate(data), /unlisted/);
  const link = fixture(); link.symlinks.set('node_modules/extra', './next');
  await assert.rejects(validate(link), /unlisted/);
  const drift = fixture(); drift.symlinks.set('node_modules/.bin/next', '../other');
  await assert.rejects(validate(drift), /symlink identity/);
});
for (const path of ['../escape', '/absolute', 'C:/windows', 'apps/web/..\\..\\.env', 'apps/web/\u0000bad',
  'apps/web/.env', 'apps/web/.env.local', 'apps/web/.env-backup', 'apps/web/.envrc', 'node_modules/.npmrc',
  '.aws/credentials', '.ssh/id_rsa', 'apps/web/private.key', 'apps/web/service-account.json'])
  test(`unsafe/credential manifest path refuses before rootfs reads: ${JSON.stringify(path)}`, async () => {
    const data = fixture(); data.files.set(path, Buffer.from('inert refusal payload'));
    const packed = pack(data.files, data.symlinks), input = portsFor(packed);
    await assert.rejects(read(packed, input), /unsafe/); assert.deepEqual(rootfsReads(input), []);
  });
for (const [name, target] of [['absolute', '/etc/passwd'], ['escaping', '../../outside'], ['Windows', '..\\secret'], ['credential', '../.env']])
  test(`symlink ${name} target refuses before rootfs reads`, async () => {
    const data = fixture(); data.symlinks.set('escape', target);
    const packed = pack(data.files, data.symlinks), input = portsFor(packed);
    await assert.rejects(read(packed, input)); assert.deepEqual(rootfsReads(input), []);
  });
test('dangling, cyclic and file-as-directory indexes refuse', async () => {
  const dangling = fixture(); dangling.symlinks.set('missing', './absent');
  await assert.rejects(validate(pack(dangling.files, dangling.symlinks)), /missing declared/);
  const cyclic = fixture(); cyclic.symlinks.set('a', 'b'); cyclic.symlinks.set('b', 'a');
  await assert.rejects(validate(pack(cyclic.files, cyclic.symlinks)), /cyclic/);
  const descendant = fixture(); descendant.files.set('node_modules/.bin/next/child', Buffer.from('inert'));
  await assert.rejects(validate(pack(descendant.files, descendant.symlinks)), /ancestor/);
});
test('symlink targets cannot cancel named components, including nested and dot-separated aliases', async () => {
  for (const target of ['safe/back/../decoy.txt', 'bridge/../decoy.txt', 'safe/back/./../decoy.txt',
    'safe/back//../decoy.txt', 'safe/back/..', 'safe/../decoy.txt', 'safe/decoy.txt/../decoy.txt']) {
    const data = parentTraversalFixture(); data.symlinks.set('escape', target);
    const packed = pack(data.files, data.symlinks), input = portsFor(packed);
    await assert.rejects(validate(packed), /parent segment after named/);
    await assert.rejects(read(packed, input), /parent segment after named/);
    assert.deepEqual(rootfsReads(input), []);
  }
});
test('physical POSIX symlink-plus-parent escapes refuse before rootfs content reads', async () => {
  for (const target of ['safe/back/../decoy.txt', 'bridge/../decoy.txt', 'safe/back/./../decoy.txt']) {
    const data = parentTraversalFixture(); data.symlinks.set('escape', target);
    const packed = pack(data.files, data.symlinks), input = await physicalPortsFor(packed);
    try {
      assert.equal(await input.fs.realpath(input.rootfs + '/escape'), input.artifactDir + '/decoy.txt');
      await assert.rejects(read(packed, input), /parent segment after named/);
      assert.deepEqual(rootfsReads(input), []);
    } finally { await input.cleanup(); }
  }
});
test('leading-parent links and nested aliases qualify in inert and physical models', async () => {
  const data = parentTraversalFixture(); data.symlinks.set('file-alias', 'bridge/decoy.txt');
  data.files.set('apps/web/.next/required-server-files.json', Buffer.from(JSON.stringify({
    config: { output: 'standalone' }, files: ['.next/BUILD_ID', '../../safe/leading'] })));
  data.files.set('apps/web/.next/server/app/index.js.nft.json', Buffer.from(JSON.stringify({
    files: ['../../../../../bridge/decoy.txt'] })));
  const packed = pack(data.files, data.symlinks), inert = await validate(packed), input = await physicalPortsFor(packed);
  try {
    assert.equal(await input.fs.realpath(input.rootfs + '/file-alias'), input.rootfs + '/decoy.txt');
    assert.equal(await input.fs.realpath(input.rootfs + '/safe/leading'), input.rootfs + '/decoy.txt');
    const physical = await read(packed, input);
    assert.deepEqual(physical, inert);
    assert.equal(physical.safeInternalSymlinksVerified, true);
    assert.equal(physical.requiredServerFileClosureVerified, true);
    assert.equal(physical.traceFileReferencesVerified, 1);
    assert.equal(rootfsReads(input).length, packed.files.size);
    assert.equal(physical.actualArtifactBytesVerified, false);
    assert.ok(input.calls.every(([, path]) => path === input.artifactDir + '/manifest.json' ||
      path.startsWith(input.rootfs + '/')));
  } finally { await input.cleanup(); }
});
test('required-server-file and NFT references cannot cancel intermediate aliases', async () => {
  for (const alias of ['safe/back/..', 'bridge/..', 'safe/back/./..']) {
    for (const kind of ['required', 'trace']) {
      const data = parentTraversalFixture();
      const path = kind === 'required' ? 'apps/web/.next/required-server-files.json' : 'apps/web/.next/server/app/index.js.nft.json';
      const reference = (kind === 'required' ? '../../' : '../../../../../') + alias + '/decoy.txt';
      data.files.set(path, Buffer.from(JSON.stringify(kind === 'required' ?
        { config: { output: 'standalone' }, files: ['.next/BUILD_ID', reference] } : { files: [reference] })));
      const packed = pack(data.files, data.symlinks), input = portsFor(packed);
      await assert.rejects(validate(packed), /parent segment after named/);
      await assert.rejects(read(packed, input), /parent segment after named/);
      assert.ok(rootfsReads(input).every(([, absolute]) => packed.files.has(absolute.slice(input.rootfs.length + 1))));
    }
  }
});
test('physical required-server-file and NFT parent references refuse without outside-rootfs reads', async () => {
  for (const kind of ['required', 'trace']) {
    const data = parentTraversalFixture();
    const path = kind === 'required' ? 'apps/web/.next/required-server-files.json' : 'apps/web/.next/server/app/index.js.nft.json';
    const reference = (kind === 'required' ? '../../' : '../../../../../') + 'bridge/../decoy.txt';
    data.files.set(path, Buffer.from(JSON.stringify(kind === 'required' ?
      { config: { output: 'standalone' }, files: ['.next/BUILD_ID', reference] } : { files: [reference] })));
    const packed = pack(data.files, data.symlinks), input = await physicalPortsFor(packed);
    try {
      const containingDirectory = kind === 'required' ? input.rootfs + '/apps/web' :
        input.rootfs + '/' + path.slice(0, path.lastIndexOf('/'));
      assert.equal(await input.fs.realpath(containingDirectory + '/' + reference), input.artifactDir + '/decoy.txt');
      await assert.rejects(read(packed, input), /parent segment after named/);
      assert.ok(input.calls.every(([, absolute]) => absolute === input.artifactDir + '/manifest.json' ||
        (absolute.startsWith(input.rootfs + '/') && packed.files.has(absolute.slice(input.rootfs.length + 1)))));
    } finally { await input.cleanup(); }
  }
});
test('required-server-files and all included trace references are checked conservatively', async () => {
  for (const [path, value, message] of [
    ['apps/web/.next/required-server-files.json', { config: { output: 'standalone' }, files: ['.next/missing.json'] }, /missing declared/],
    ['apps/web/.next/required-server-files.json', { config: { output: 'export' }, files: ['.next/BUILD_ID'] }, /layout/],
    ['apps/web/.next/required-server-files.json', { config: { output: 'standalone' }, files: ['../../../../outside'] }, /escaping/],
    ['apps/web/.next/server/app/index.js.nft.json', { files: ['../../../../../.env'] }, /unsafe/],
    ['apps/web/.next/server/app/index.js.nft.json', { files: ['../../../../../../outside'] }, /escaping/],
    ['apps/web/.next/server/app/index.js.nft.json', { files: ['../../../../../node_modules/missing.js'] }, /missing declared/],
  ]) {
    const data = fixture(); data.files.set(path, Buffer.from(JSON.stringify(value)));
    await assert.rejects(validate(pack(data.files, data.symlinks)), message);
  }
});
test('Next directory trace references admit nonempty indexed contents through an internal symlink', async () => {
  const data = directoryTraceFixture(), input = portsFor(data), receipt = await read(data, input);
  assert.equal(receipt.regularFiles, data.files.size); assert.equal(receipt.symlinks, data.symlinks.size);
  assert.equal(receipt.exhaustiveArtifactIndexVerified, true); assert.equal(receipt.safeInternalSymlinksVerified, true);
  assert.equal(receipt.requiredServerFileClosureVerified, true);
  assert.equal(receipt.traceManifestsVerified, 2); assert.equal(receipt.traceFileReferencesVerified, 2);
  assert.equal(rootfsReads(input).length, data.files.size);
  assert.ok(input.calls.every(([, path]) => !path.startsWith(input.rootfs + '/' + directoryTraceLink + '/')));
  for (const key of ['actualArtifactBytesVerified', 'nativeRuntimeCompatibilityVerified', 'buildUsedSourceVerified',
    'runtimeDependencyClosureVerified', 'localServingVerified', 'deployedServingVerified', 'uiAcceptanceVerified'])
    assert.equal(receipt[key], false);
  const direct = directoryTraceFixture('../../../../../../../../node_modules/shiki');
  assert.equal((await validate(direct)).traceFileReferencesVerified, 2);
});
test('directory trace contents must remain exhaustive and byte-identical', async () => {
  const missing = directoryTraceFixture(); missing.files.delete('node_modules/shiki/dist/index.mjs');
  await assert.rejects(validate(missing), /missing artifact entries/);
  const drift = directoryTraceFixture(); drift.files.set('node_modules/shiki/dist/index.mjs', Buffer.from('changed'));
  await assert.rejects(validate(drift), /byte identity drift/);
  for (const change of [
    { '/provided/release-artifacts/capiro-frontend/rootfs/node_modules/shiki/dist/index.mjs': null },
    { '/provided/release-artifacts/capiro-frontend/rootfs/node_modules/shiki/dist/unlisted.mjs': Buffer.from('unlisted') },
  ]) {
    const data = directoryTraceFixture(), input = portsFor(data, change);
    await assert.rejects(read(data, input), /exhaustive artifact inventory mismatch/);
    assert.deepEqual(rootfsReads(input), []);
  }
});
test('empty or missing directory trace targets cannot replace indexed contents', async () => {
  const data = directoryTraceFixture();
  data.files.delete('node_modules/shiki/dist/bundle-full.mjs'); data.files.delete('node_modules/shiki/dist/index.mjs');
  const packed = pack(data.files, data.symlinks);
  const input = portsFor(packed, { '/provided/release-artifacts/capiro-frontend/rootfs/node_modules/shiki': 'directory' });
  await assert.rejects(read(packed, input), /missing declared file\/symlink target/);
  assert.deepEqual(rootfsReads(input), []);
  data.symlinks.delete(directoryTraceLink);
  data.files.set(directoryTracePath, Buffer.from(JSON.stringify({ files: ['../../../../../../../../node_modules/shiki'] })));
  await assert.rejects(validate(pack(data.files, data.symlinks)), /missing declared file\/symlink target/);
});
test('directory trace support leaves required-server-files references file-only', async () => {
  for (const file of ['.next/node_modules/shiki-43d062b67f27bbdc', '../../node_modules/shiki']) {
    const data = directoryTraceFixture();
    data.files.set('apps/web/.next/required-server-files.json', Buffer.from(JSON.stringify({
      config: { output: 'standalone' }, files: ['.next/BUILD_ID', file] })));
    await assert.rejects(validate(pack(data.files, data.symlinks)), /missing declared file\/symlink target/);
  }
});
test('directory trace aliases retain escape, credential, cycle and dangling-target refusal', async () => {
  for (const [target, message] of [
    ['../../../../../outside', /escaping/], ['../../../../.aws/credentials', /unsafe/],
    ['./shiki-43d062b67f27bbdc', /cyclic/], ['../../../../node_modules/absent', /missing declared/],
  ]) {
    const data = directoryTraceFixture(); data.symlinks.set(directoryTraceLink, target);
    const packed = pack(data.files, data.symlinks), input = portsFor(packed);
    await assert.rejects(read(packed, input), message); assert.deepEqual(rootfsReads(input), []);
  }
});
test('future declared output files remain required; corrupted Newsletter buffers remain refused', async () => {
  const data = fixture(); data.files.set('apps/web/.next/static/chunks/future.js', Buffer.from('future fixture'));
  const packed = pack(data.files, data.symlinks); assert.equal((await validate(packed)).regularFiles, 188);
  packed.files.delete('apps/web/.next/static/chunks/future.js'); await assert.rejects(validate(packed), /missing artifact/);
  const corrupt = fixture(); corrupt.files.set('apps/web/public/newsletter/capitol.png', Buffer.from('corrupt'));
  await assert.rejects(validate(pack(corrupt.files, corrupt.symlinks)), /artifact byte/);
});
test('injected reader enumerates safe physical entries without following symlinks', async () => {
  const data = fixture(), input = portsFor(data), receipt = await read(data, input);
  assert.equal(receipt.regularFiles, data.files.size);
  assert.equal(rootfsReads(input).length, data.files.size);
  assert.ok(input.calls.every(([, path]) => !path.includes('/next-alias/')));
  assert.equal(receipt.actualArtifactBytesVerified, false);
});
test('unsafe unlisted inventory refuses before any rootfs content read', async () => {
  const data = fixture(), input = portsFor(data, { '/provided/release-artifacts/capiro-frontend/rootfs/.env': Buffer.from('inert') });
  await assert.rejects(read(data, input), /unsafe/); assert.deepEqual(rootfsReads(input), []);
});
test('extra/missing physical entries and nonregular nodes fail before any rootfs read', async () => {
  for (const changes of [
    { '/provided/release-artifacts/capiro-frontend/rootfs/extra.js': Buffer.from('extra') },
    { '/provided/release-artifacts/capiro-frontend/rootfs/apps/web/server.js': null },
    { '/provided/release-artifacts/capiro-frontend/rootfs/apps/web/server.js': 'socket' },
  ]) {
    const data = fixture(), input = portsFor(data, changes);
    await assert.rejects(read(data, input)); assert.deepEqual(rootfsReads(input), []);
  }
});
test('physical ancestor/manifest links and selected realpath escapes refuse', async () => {
  for (const path of ['/provided', '/provided/release-artifacts/capiro-frontend/manifest.json',
    '/provided/release-artifacts/capiro-frontend/rootfs/apps']) {
    const data = fixture(), input = portsFor(data, { [path]: { link: '/outside' } });
    await assert.rejects(read(data, input)); assert.deepEqual(rootfsReads(input), []);
  }
  const data = fixture(), input = portsFor(data);
  const prior = input.ports.realpath;
  input.ports.realpath = (path) => path.endsWith('/apps/web/server.js') ? '/outside/server.js' : prior(path);
  await assert.rejects(read(data, input), /realpath escape/); assert.deepEqual(rootfsReads(input), []);
});
test('read failures propagate; duplicate directory inventories are refused', async () => {
  const data = fixture(), input = portsFor(data), prior = input.ports.readFile;
  input.ports.readFile = (path) => { if (path.endsWith('/server.js')) throw new Error('injected content read failure'); return prior(path); };
  await assert.rejects(read(data, input), /injected content read failure/);
  const duplicate = portsFor(data); duplicate.ports.readdir = () => ['same', 'same'];
  await assert.rejects(read(data, duplicate), /ambiguous/);
});
test('invalid source/target pins and credential artifact roots refuse before filesystem ports', async () => {
  for (const mutate of [
    (pins) => { pins.sourceCommit += '\n'; }, (pins) => { pins.sourceRepository += '\n'; },
    (pins) => { pins.sourceCommit = { toString() { throw new Error('unexpected coercion'); } }; },
    (pins) => { pins.runtimeTarget = undefined; },
  ]) {
    const data = fixture(), input = portsFor(data); mutate(data.pins);
    await assert.rejects(read(data, input)); assert.deepEqual(input.calls, []);
  }
  const data = fixture(), input = portsFor(data);
  await assert.rejects(readFrontendStandaloneArtifact({ artifactDir: '/provided/.aws', pins: data.pins, ports: input.ports }), /unsafe/);
  assert.deepEqual(input.calls, []);
});
test('symlinked trace manifests refuse instead of silently omitting declared closure', async () => {
  const data = fixture(); data.symlinks.set('apps/web/.next/alias.nft.json', './server/app/index.js.nft.json');
  await assert.rejects(validate(pack(data.files, data.symlinks)), /trace manifest must be regular/);
});
test('CLI has no target/source defaults; only seven exact flags form a valid invocation', () => {
  const pins = fixture().pins;
  const args = ['--artifact-dir', '/provided/release-artifacts/capiro-frontend', '--manifest-sha256', pins.manifestSha256,
    '--source-repository', pins.sourceRepository, '--source-commit', pins.sourceCommit,
    '--target-platform', 'linux/amd64', '--target-libc', 'glibc', '--target-node-major', '24'];
  assert.deepEqual(parseFrontendStandaloneInvocation(args).pins, pins);
  for (const changed of [[], args.slice(0, 8), [...args, 'extra'], args.map((arg) => arg === '--target-libc' ? '--UNKNOWN' : arg),
    args.map((arg) => arg === 'linux/amd64' ? 'linux/amd64\n' : arg),
    args.map((arg) => arg === '24' ? '024' : arg), args.map((arg) => arg === 'glibc' ? 'unknown' : arg)])
    assert.throws(() => parseFrontendStandaloneInvocation(changed));
});
