import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ONBOARD_PUBLIC_ASSETS, parseOnboardSpaArtifactInvocation, readOnboardSpaArtifact,
  validateOnboardSpaArtifact } from '../lib/onboard-spa-artifact-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baseline = 'b5ddf4556b86d0169dd4f77d0b9da971f0c7dc08';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = (path) => fs.readFileSync(join(root, path), 'utf8');
const originalBytes = (path) => execFileSync('git', ['show', `${baseline}:${path}`], { cwd: root });
const original = (path) => originalBytes(path).toString('utf8');
const dockerPath = 'apps/onboard-api/Dockerfile';
const oldDocker = original(dockerPath);
const nextDocker = source(dockerPath + '.spa-artifact');
const validationBlock = `# No default artifact or source pin. Validate before workspace installation.
COPY release-artifacts/onboard-spa /workspace/release-artifacts/onboard-spa
COPY scripts/lib/onboard-spa-artifact-contract.mjs /workspace/scripts/lib/onboard-spa-artifact-contract.mjs
ARG ONBOARD_SPA_MANIFEST_SHA256
ARG ONBOARD_SPA_SOURCE_REPOSITORY
ARG ONBOARD_SPA_SOURCE_COMMIT
RUN node scripts/lib/onboard-spa-artifact-contract.mjs \\
      --artifact-dir /workspace/release-artifacts/onboard-spa \\
      --manifest-sha256 "$ONBOARD_SPA_MANIFEST_SHA256" \\
      --source-repository "$ONBOARD_SPA_SOURCE_REPOSITORY" \\
      --source-commit "$ONBOARD_SPA_SOURCE_COMMIT"

`;

function inverse(docker) {
  return docker.replace(`# Opt-in Onboard API + explicitly supplied static SPA artifact.
# Existing Dockerfile remains the default; this variant is not released.
# Supply release-artifacts/onboard-spa/{manifest.json,site/**} and all three
# ONBOARD_SPA_* build args. The byte contract does not qualify browser flows.`, '# Capiro Onboard API container (API + onboard-web SPA in one image).')
    .replace('Dockerfile.spa-artifact -t', 'Dockerfile -t')
    .replace('compile API + validate the supplied SPA,', 'compile API + build the SPA,')
    .replace(validationBlock, '')
    .replace('COPY apps/onboard-api/package.json apps/onboard-api/package.json\n', 'COPY apps/onboard-api/package.json apps/onboard-api/package.json\nCOPY apps/onboard-web/package.json apps/onboard-web/package.json\n')
    .replace('--filter=@capiro/onboard-api... \\', '--filter=@capiro/onboard-api... --filter=@capiro/onboard-web... \\')
    .replace('apps/onboard-api/nest-cli.json apps/onboard-api/\n', 'apps/onboard-api/nest-cli.json apps/onboard-api/\nCOPY apps/onboard-web apps/onboard-web\n')
    .replace('RUN pnpm --filter @capiro/onboard-api build\n', 'RUN pnpm --filter @capiro/onboard-api build\nRUN pnpm --filter @capiro/onboard-web build\n')
    .replace('/workspace/release-artifacts/onboard-spa/site /app/apps/onboard-web/dist', '/workspace/apps/onboard-web/dist /app/apps/onboard-web/dist');
}

const protectedBytes = new Map(Object.keys(ONBOARD_PUBLIC_ASSETS).map((path) =>
  [path, originalBytes('apps/onboard-web/public/' + path)]));
function fixture(extra = {}) {
  const files = new Map([
    ['index.html', Buffer.from('<!doctype html><html><head><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/assets/main.css"></head><body><div id="root"></div><script type="module" src="/assets/main.js"></script></body></html>')],
    ['assets/main.js', Buffer.from('import "./chunk.js"; export {x} from "./export.js"; const lazy=import("./lazy.js"); const font=new URL("./font.woff2",import.meta.url); const icon="/assets/icon.svg"; const deps=["assets/chunk.js"];')],
    ['assets/chunk.js', Buffer.from('export const c=1;')],
    ['assets/export.js', Buffer.from('export const x=1;')],
    ['assets/lazy.js', Buffer.from('export const lazy=1;')],
    ['assets/main.css', Buffer.from('@import "./nested.css"; body{background:url("./icon.svg");font-family:demo}@font-face{font-family:demo;src:url("./font.woff2")}')],
    ['assets/nested.css', Buffer.from('html{color:navy}')],
    ['assets/icon.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="./pixel.png"/></svg>')],
    ['assets/pixel.png', Buffer.from('fixture-pixel-bytes-not-browser-qualified')],
    ['assets/font.woff2', Buffer.from('fixture-font-bytes-not-browser-qualified')],
    ...protectedBytes,
  ]);
  for (const [path, bytes] of Object.entries(extra)) files.set(path, Buffer.from(bytes));
  return pack(files);
}
function pack(files) {
  const manifest = { schemaVersion: 1, artifactType: 'capiro-onboard-static-spa',
    source: { repository: 'fixtures/onboard-static-artifact', commit: 'a'.repeat(40) },
    files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })) };
  return fromManifest(manifest, files);
}
function fromManifest(manifest, files) {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return { manifest, manifestBytes, files, pins: { manifestSha256: sha(manifestBytes),
    sourceRepository: 'fixtures/onboard-static-artifact', sourceCommit: 'a'.repeat(40) } };
}
const validate = (data) => validateOnboardSpaArtifact(data, data.pins);

function fakePorts(data, changes = {}) {
  const directory = '/provided/artifact';
  const entries = new Map([['/', 'dir'], ['/provided', 'dir'], [directory, 'dir'],
    [directory + '/manifest.json', data.manifestBytes], [directory + '/site', 'dir']]);
  for (const [path, bytes] of data.files) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) entries.set(directory + '/site/' + parts.slice(0, i).join('/'), 'dir');
    entries.set(directory + '/site/' + path, bytes);
  }
  for (const [path, value] of Object.entries(changes)) {
    if (value === null) entries.delete(path); else entries.set(path, value);
  }
  const calls = [];
  const touch = (operation, path) => {
    calls.push([operation, path]);
    assert.ok(!/(?:apps\/web|apps\/onboard-web)/.test(path), 'no legacy frontend filesystem operands');
    if (!entries.has(path)) throw new Error('ENOENT:' + path);
    return entries.get(path);
  };
  return { directory, calls, ports: {
    lstatSync: (path) => { const value = touch('lstat', path); return { isDirectory: () => value === 'dir',
      isSymbolicLink: () => value === 'symlink', isFile: () => Buffer.isBuffer(value) }; },
    readdirSync: (path) => { assert.equal(touch('readdir', path), 'dir');
      const prefix = path === '/' ? '/' : path + '/';
      return [...entries.keys()].filter((name) => name.startsWith(prefix) && !name.slice(prefix.length).includes('/') && name !== path)
        .map((name) => name.slice(prefix.length)); },
    readFileSync: (path) => { const bytes = touch('read', path); assert.ok(Buffer.isBuffer(bytes)); return bytes; },
  } };
}

test('opt-in Docker inverse restores the entire original; default/runtime/API/security/entrypoint bytes remain intact', () => {
  assert.equal(sha(oldDocker), '21a92046e8c14538577d84cc313ace4757830c9a98e1a1813b24173b0a33a738');
  assert.equal(inverse(nextDocker), oldDocker);
  for (const path of [dockerPath, 'apps/onboard-api/src/main.ts', 'apps/onboard-api/src/app.module.ts',
    'apps/onboard-api/scripts/entrypoint.sh', '.github/workflows/onboard-api-image.yml',
    'infra/deploy/onboard-api-serve-taskdef.json', 'infra/deploy/onboard-api-migrate-taskdef.json']) assert.equal(source(path), original(path));
  assert.equal(nextDocker.slice(nextDocker.indexOf('# -------- runtime')).replace('/workspace/release-artifacts/onboard-spa/site /app/apps/onboard-web/dist',
    '/workspace/apps/onboard-web/dist /app/apps/onboard-web/dist'), oldDocker.slice(oldDocker.indexOf('# -------- runtime')));
  assert.notEqual(inverse(nextDocker.replace('NODE_ENV=production', 'NODE_ENV=test')), oldDocker);
});

test('only the supplied site enters the unchanged runtime path; pins are required before frozen workspace installation', () => {
  assert.equal(nextDocker.split(validationBlock).length, 2);
  assert.ok(nextDocker.indexOf(validationBlock) < nextDocker.indexOf('pnpm install --frozen-lockfile'));
  for (const arg of ['MANIFEST_SHA256', 'SOURCE_REPOSITORY', 'SOURCE_COMMIT']) assert.match(nextDocker, new RegExp(`^ARG ONBOARD_SPA_${arg}$`, 'm'));
  assert.doesNotMatch(nextDocker, /^\s*(?:COPY|RUN)[^\n]*(?:@capiro\/onboard-web|COPY apps\/onboard-web|COPY apps\/web)/m);
  assert.match(nextDocker, /^COPY --chown=capiro:capiro --from=build \/workspace\/release-artifacts\/onboard-spa\/site \/app\/apps\/onboard-web\/dist$/m);
  assert.doesNotMatch(nextDocker, /--from=onboard_spa|FROM \$\{ONBOARD/);
});

test('API/auth/shared dependency manifests and frozen lock importers close without legacy frontend packages', () => {
  const paths = ['apps/onboard-api', 'packages/auth', 'packages/shared'];
  const lock = source('pnpm-lock.yaml');
  assert.equal(sha(lock), 'ee1e9d1758ffa0fe45e5b8fb58294083cc57850a1984b035f99fb54747b6ddba');
  const byName = new Map(paths.map((path) => [JSON.parse(source(path + '/package.json')).name, path]));
  for (const path of paths) {
    const pkg = JSON.parse(source(path + '/package.json'));
    assert.equal(source(path + '/package.json'), original(path + '/package.json'));
    assert.match(nextDocker, new RegExp(`^COPY ${path}/package.json ${path}/package.json$`, 'm'));
    const start = lock.indexOf(`\n  ${path}:\n`); assert.ok(start > 0);
    const section = lock.slice(start).split(/\n  [^ \n][^\n]*:\n/).slice(0, 2).join('\n');
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      assert.ok(section.includes(`specifier: ${version}`), `${path}: ${name} frozen specifier`);
      if (version.startsWith('workspace:')) {
        assert.ok(byName.has(name)); assert.ok(!name.includes('web'));
        const dependency = byName.get(name);
        assert.ok(section.includes(`version: link:${path.startsWith('apps/') ? '../../' : '../'}${dependency.startsWith('packages/') && !path.startsWith('apps/') ? dependency.slice(9) : dependency}`));
      }
    }
  }
  assert.equal((nextDocker.match(/pnpm install --frozen-lockfile/g) ?? []).length, 2);
  assert.match(nextDocker, /corepack prepare pnpm@9\.12\.0 --activate/);
  assert.match(nextDocker, /ARG NODE_VERSION=20\.16\.0/);
});

test('original public PDF/favicon bytes and URLs are pinned without reading a frontend source directory', () => {
  for (const [path, bytes] of protectedBytes) assert.equal(sha(bytes), ONBOARD_PUBLIC_ASSETS[path]);
  assert.equal(protectedBytes.get('favicon.svg').length, 310);
  assert.equal(protectedBytes.get('legal-docs/Capiro-Subscription-Agreement.pdf').length, 201149);
  assert.equal(protectedBytes.get('legal-docs/Capiro-Terms-of-Service.pdf').length, 58509);
});

test('digest/source-bound static fixture succeeds with a distinct byte-only receipt and exact file inventory', () => {
  const data = fixture();
  assert.deepEqual(validate(data), { receipt: 'ONBOARD_STATIC_SPA_ARTIFACT_VALIDATED', manifestSha256: data.pins.manifestSha256,
    source: data.manifest.source, files: 13, qualification: 'static-byte-contract-only' });
  const fsFixture = fakePorts(data);
  assert.deepEqual(readOnboardSpaArtifact(fsFixture.directory, data.pins, fsFixture.ports), validate(data));
  assert.equal(fsFixture.calls.filter(([kind]) => kind === 'read').length, 14);
});

test('empty/malformed/duplicate/conflicting invocation refuses before filesystem operations', () => {
  const good = ['--artifact-dir', '/provided/artifact', '--manifest-sha256', 'b'.repeat(64),
    '--source-repository', 'fixtures/onboard-static-artifact', '--source-commit', 'a'.repeat(40)];
  assert.equal(parseOnboardSpaArtifactInvocation(good).directory, '/provided/artifact');
  for (const args of [[], good.slice(0, -2), [...good, '--source-commit', 'a'.repeat(40)],
    good.map((value, index) => index === 0 ? '--unknown' : value),
    good.map((value, index) => index === 1 ? '' : value),
    good.map((value, index) => index === 3 ? 'sha256:' + value : value),
    good.map((value, index) => index === 7 ? value.toUpperCase() : value)]) assert.throws(() => parseOnboardSpaArtifactInvocation(args), /refused:/);
  const port = fakePorts(fixture());
  assert.throws(() => readOnboardSpaArtifact(port.directory, {}, port.ports), /explicit/);
  assert.deepEqual(port.calls, []);
});

test('missing supplied directory never falls back to existing Web trees', () => {
  const data = fixture(); const port = fakePorts(data, { '/provided/artifact': null });
  assert.throws(() => readOnboardSpaArtifact(port.directory, data.pins, port.ports), /ENOENT/);
  assert.equal(port.calls.filter(([kind]) => kind === 'read').length, 0);
});

test('manifest digest/source mismatch, truncation, duplicate keys and malformed file proofs fail closed', () => {
  const data = fixture();
  for (const pins of [{ ...data.pins, manifestSha256: '0'.repeat(64) }, { ...data.pins, sourceCommit: 'b'.repeat(40) },
    { ...data.pins, sourceRepository: 'other/source' }]) assert.throws(() => validateOnboardSpaArtifact(data, pins), /refused:/);
  for (const mutate of [(manifest) => { manifest.schemaVersion = 2; }, (manifest) => { manifest.files[0].bytes = 0; },
    (manifest) => { manifest.files[0].sha256 = 'bad'; }, (manifest) => { manifest.files.push(manifest.files[0]); }]) {
    const manifest = structuredClone(data.manifest); mutate(manifest);
    assert.throws(() => validate(fromManifest(manifest, data.files)), /refused:/);
  }
  for (const manifestBytes of [Buffer.from('{'), Buffer.from(data.manifestBytes.toString().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'))]) {
    assert.throws(() => validateOnboardSpaArtifact({ ...data, manifestBytes }, { ...data.pins, manifestSha256: sha(manifestBytes) }), /truncated|duplicate/);
  }
});

test('escaping, encoded, hidden, absolute and executable file names refuse even with fresh valid digests', () => {
  for (const path of ['../escape.js', '/assets/x.js', 'assets/../../escape.js', 'assets/%2e.js', 'assets//x.js',
    'assets\\x.js', '.env', 'assets/.private.json', 'assets/private.pem', 'assets/code.sh']) {
    const data = fixture({ [path]: 'untrusted' }); assert.throws(() => validate(data), /unsafe/);
  }
});

test('missing/unlisted/truncated/changed files and absent or replaced protected public assets refuse', () => {
  const data = fixture();
  for (const operation of ['missing', 'unlisted', 'truncated', 'changed']) {
    const files = new Map(data.files);
    if (operation === 'missing') files.delete('assets/main.js');
    if (operation === 'unlisted') files.set('extra.js', Buffer.from('extra'));
    if (operation === 'truncated') files.set('assets/main.js', files.get('assets/main.js').subarray(0, 4));
    if (operation === 'changed') files.set('assets/main.js', Buffer.alloc(files.get('assets/main.js').length));
    assert.throws(() => validateOnboardSpaArtifact({ ...data, files }, data.pins), /mismatch/);
  }
  for (const path of Object.keys(ONBOARD_PUBLIC_ASSETS)) {
    for (const operation of ['missing', 'changed']) {
      const files = new Map(data.files); if (operation === 'missing') files.delete(path); else files.set(path, Buffer.from('replacement'));
      assert.throws(() => validate(pack(files)), /original public asset/);
    }
  }
});

test('HTML/module/dynamic-import/export/CSS/font/SVG/Vite-table local closure remains mandatory', () => {
  for (const path of ['assets/main.js', 'assets/main.css', 'assets/chunk.js', 'assets/export.js', 'assets/lazy.js',
    'assets/nested.css', 'assets/font.woff2', 'assets/icon.svg', 'assets/pixel.png']) {
    const data = fixture(); data.files.delete(path); assert.throws(() => validate(pack(data.files)), /missing .* closure/);
  }
  for (const code of ['const deps=["assets/missing.js"];', 'const asset="/missing.png";', 'const worker=new URL("./missing.js",import.meta.url);']) {
    assert.throws(() => validate(fixture({ 'assets/main.js': code })), /missing .* closure/);
  }
});

test('unsafe/bare/nonstatic module or local resource references refuse; inert data images require no file', () => {
  for (const code of ['import "react";', 'import("https://elsewhere/a.js");', 'import(variable);',
    'const image=new URL(variable,import.meta.url);', 'const image="/../escape.png";', 'const image="/assets/%2e.png";']) {
    assert.throws(() => validate(fixture({ 'assets/main.js': code })), /unsafe|unbundled|nonstatic/);
  }
  assert.throws(() => validate(fixture({ 'assets/main.css': 'body{background:url(javascript:alert)}' })), /unsafe/);
  assert.throws(() => validate(fixture({ 'assets/main.css': 'body{background:url(../../../escape.svg)}' })), /unsafe/);
  assert.equal(validate(fixture({ 'assets/main.css': 'body{background:url(data:image/png;base64,aGVsbG8=)}' })).qualification, 'static-byte-contract-only');
});

test('empty/incomplete index or metadata-only artifact cannot yield an application-shell receipt', () => {
  for (const html of ['', '<!doctype html><html><body></body></html>', '<!doctype html><html><body><script src="/assets/main.js"></script>']) {
    assert.throws(() => validate(fixture({ 'index.html': html })), /refused:/);
  }
});

test('port reader rejects missing/unlisted roots, file/ancestor symlinks and nonregular entries before content reads', () => {
  const data = fixture();
  for (const changes of [{ '/provided': 'symlink' }, { '/provided/artifact': 'symlink' },
    { '/provided/artifact/manifest.json': 'symlink' }, { '/provided/artifact/site': 'symlink' },
    { '/provided/artifact/site/assets': 'symlink' }, { '/provided/artifact/site/assets/main.js': 'symlink' },
    { '/provided/artifact/site/assets/main.js': 'socket' }, { '/provided/artifact/private.pem': Buffer.from('private') },
    { '/provided/artifact/site/unknown': 'dir' }, { '/provided/artifact/site/assets/extra.js': Buffer.from('extra') }]) {
    const port = fakePorts(data, changes);
    assert.throws(() => readOnboardSpaArtifact(port.directory, data.pins, port.ports), /refused:/);
    for (const [kind, path] of port.calls) if (kind === 'read') assert.notEqual(changes[path], 'symlink');
  }
  for (const operation of ['lstatSync', 'readdirSync', 'readFileSync']) {
    const port = fakePorts(data); port.ports[operation] = () => { throw new Error('READ_FAILURE'); };
    assert.throws(() => readOnboardSpaArtifact(port.directory, data.pins, port.ports), /READ_FAILURE/);
  }
});

test('physical supplied fixture qualifies with legacy frontend denied, and physical symlink escape refuses', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'onboard-artifact-contract-'));
  try {
    const data = fixture();
    fs.mkdirSync(join(directory, 'site'));
    fs.writeFileSync(join(directory, 'manifest.json'), data.manifestBytes);
    for (const [path, bytes] of data.files) {
      fs.mkdirSync(dirname(join(directory, 'site', path)), { recursive: true }); fs.writeFileSync(join(directory, 'site', path), bytes);
    }
    const reads = [];
    const ports = { ...fs, readFileSync: (path) => { reads.push(path); assert.ok(!/apps\/(?:onboard-web|web)/.test(path)); return fs.readFileSync(path); } };
    assert.deepEqual(readOnboardSpaArtifact(directory, data.pins, ports), validate(data));
    assert.equal(reads.length, 14);
    const target = join(directory, 'site/assets/main.js'); fs.unlinkSync(target);
    fs.symlinkSync('/never-read/apps/onboard-web/dist/main.js', target);
    assert.throws(() => readOnboardSpaArtifact(directory, data.pins, ports), /symbolic/);
    const alias = directory + '-link'; fs.symlinkSync(directory, alias);
    try { assert.throws(() => readOnboardSpaArtifact(alias, data.pins, ports), /unsafe filesystem/); }
    finally { fs.unlinkSync(alias); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('case/control regression preserves all former cases and limits the helper change to canonical paths and pins', () => {
  const before = reconstructedHistoricalHelper();
  assert.equal(sha(before), '1fd6adc7466f0e49e2d582e3072a3a2dadfcc032ebba05055c524084869b2b59');
  const next = beforeCommentLinkageGuard();
  const inverse = next
    .replace(`  if (!pins || ['manifestSha256', 'sourceCommit', 'sourceRepository'].some((key) =>
    typeof pins[key] !== 'string' || !pins[key] || pins[key].trim() !== pins[key] || /[\\s\\u0000-\\u001f\\u007f]/.test(pins[key])) ||
      !/^[a-f0-9]{64}$/.test(pins.manifestSha256) ||`, `  if (!pins || !/^[a-f0-9]{64}$/.test(pins.manifestSha256 ?? '') ||`)
    .replace(`typeof value !== 'string' || /[\\s\\u0000-\\u001f\\u007f]/.test(value) ||`, `typeof value !== 'string' ||`)
    .replace('webm|map)$/.test(value)', 'webm|map)$/i.test(value)')
    .replace(`typeof name !== 'string' || /[\\s\\u0000-\\u001f\\u007f]/.test(name) ||`, `typeof name !== 'string' ||`);
  assert.equal(inverse, before);
  const prefix = source('scripts/ci/onboard-spa-artifact.contract.spec.mjs').slice(0, 20003);
  assert.equal(sha(prefix), 'ecae39d24423d4cd8f0e87a9bfcad67c54808751b97c34544315c1788685e27e', 'exact former controls with only receiving baseline/lock bindings');
});

function reconstructedHistoricalHelper() {
  const next = beforeCommentLinkageGuard();
  const inverse = next
    .replace(`  if (!pins || ['manifestSha256', 'sourceCommit', 'sourceRepository'].some((key) =>
    typeof pins[key] !== 'string' || !pins[key] || pins[key].trim() !== pins[key] || /[\\s\\u0000-\\u001f\\u007f]/.test(pins[key])) ||
      !/^[a-f0-9]{64}$/.test(pins.manifestSha256) ||`, `  if (!pins || !/^[a-f0-9]{64}$/.test(pins.manifestSha256 ?? '') ||`)
    .replace(`typeof value !== 'string' || /[\\s\\u0000-\\u001f\\u007f]/.test(value) ||`, `typeof value !== 'string' ||`)
    .replace('webm|map)$/.test(value)', 'webm|map)$/i.test(value)')
    .replace(`typeof name !== 'string' || /[\\s\\u0000-\\u001f\\u007f]/.test(name) ||`, `typeof name !== 'string' ||`);
  assert.equal(sha(inverse), '1fd6adc7466f0e49e2d582e3072a3a2dadfcc032ebba05055c524084869b2b59');
  return inverse;
}

async function beforeCaseControlFix() {
  const before = reconstructedHistoricalHelper();
  assert.equal(sha(before), '1fd6adc7466f0e49e2d582e3072a3a2dadfcc032ebba05055c524084869b2b59');
  // Inert immutable module only; the data URL cannot match the direct-CLI entrypoint.
  return import('data:text/javascript;base64,' + Buffer.from(before + '\nexport { pinsContract as beforePinsContract };\n').toString('base64'));
}

test('uppercase JS/CSS/HTML/MJS/SVG missing-resource counterexamples now refuse, while uppercase basenames remain valid', async () => {
  const before = await beforeCaseControlFix();
  const variants = [
    ['main.JS', 'import "./missing.js";', (html) => html.replace('/assets/main.js', '/assets/main.JS')],
    ['main.CSS', 'body{background:url("./missing.png")}', (html) => html.replace('/assets/main.css', '/assets/main.CSS')],
    ['frame.HTML', '<!doctype html><html><body><img src="./missing.png"></body></html>', (html) => html.replace('</body>', '<iframe src="/assets/frame.HTML"></iframe></body>')],
    ['main.MJS', 'export {x} from "./missing.js";', (html) => html.replace('/assets/main.js', '/assets/main.MJS')],
    ['icon.SVG', '<svg><image href="./missing.png"/></svg>', (html) => html.replace('</body>', '<img src="/assets/icon.SVG"></body>')],
  ];
  for (const [name, code, index] of variants) {
    const data = fixture({ ['assets/' + name]: code });
    data.files.set('index.html', Buffer.from(index(data.files.get('index.html').toString('utf8'))));
    const supplied = pack(data.files);
    assert.equal(before.validateOnboardSpaArtifact(supplied, supplied.pins).receipt, 'ONBOARD_STATIC_SPA_ARTIFACT_VALIDATED', name + ': immutable earlier acceptance');
    assert.throws(() => validate(supplied), /unsafe static file path/, name + ': corrected refusal');
    const lowerFiles = new Map(supplied.files); lowerFiles.delete('assets/' + name);
    lowerFiles.set('assets/' + name.toLowerCase(), Buffer.from(code));
    lowerFiles.set('index.html', Buffer.from(supplied.files.get('index.html').toString('utf8').replaceAll('assets/' + name, 'assets/' + name.toLowerCase())));
    assert.throws(() => validate(pack(lowerFiles)), /missing .* closure/, name + ': lowercase resource still fails positively');
  }
  assert.equal(validate(fixture({ 'assets/Uppercase-Basename.js': 'export const valid=1;' })).qualification, 'static-byte-contract-only');
});

test('trailing-LF manifest/file names now refuse before payload reads or stat of unsafe filesystem names', async () => {
  const before = await beforeCaseControlFix();
  const data = fixture({ 'assets/main.js\n': 'import "./missing.js";' });
  assert.throws(() => before.validateOnboardSpaArtifact(data, data.pins), /unsafe static file path/, 'immutable non-multiline path regex already refuses LF');
  assert.throws(() => validate(data), /unsafe static file path/);
  const port = fakePorts(data);
  assert.throws(() => readOnboardSpaArtifact(port.directory, data.pins, port.ports), /unsafe static file path/);
  assert.deepEqual(port.calls.filter(([kind]) => kind === 'read'), [['read', port.directory + '/manifest.json']]);
  const valid = fixture(); const extra = fakePorts(valid, { '/provided/artifact/site/assets/extra.js\n': Buffer.from('extra') });
  assert.throws(() => readOnboardSpaArtifact(extra.directory, valid.pins, extra.ports), /unsafe filesystem name/);
  assert.ok(!extra.calls.some(([, path]) => path.endsWith('\n')));
});

test('pure pins refuse coerced/non-string/control values before filesystem operations; original LF refusal is preserved', async () => {
  const before = await beforeCaseControlFix();
  const data = fixture();
  for (const key of ['sourceCommit', 'sourceRepository']) {
    const manifest = structuredClone(data.manifest);
    manifest.source[key === 'sourceCommit' ? 'commit' : 'repository'] += '\n';
    const variant = fromManifest(manifest, data.files); variant.pins[key] += '\n';
    assert.throws(() => before.validateOnboardSpaArtifact(variant, variant.pins), /explicit manifest SHA256/, 'immutable non-multiline pin regex already refuses LF');
    assert.throws(() => validate(variant), /explicit manifest SHA256/);
  }
  for (const key of ['manifestSha256', 'sourceCommit', 'sourceRepository']) {
    for (const value of [[data.pins[key]], new String(data.pins[key])]) {
      const pins = { ...data.pins, [key]: value };
      assert.doesNotThrow(() => before.beforePinsContract(pins), key + ': previous pure format admission');
      const previousPort = fakePorts(data);
      assert.throws(() => before.readOnboardSpaArtifact(previousPort.directory, pins, previousPort.ports), /manifest SHA256 mismatch|manifest\/source identity contract/);
      assert.ok(previousPort.calls.some(([kind]) => kind === 'read'), 'previous type coercion reaches the manifest read before proof refusal');
      const port = fakePorts(data);
      assert.throws(() => readOnboardSpaArtifact(port.directory, pins, port.ports), /explicit manifest SHA256/);
      assert.deepEqual(port.calls, []);
    }
    for (const value of [data.pins[key] + '\n', ' ' + data.pins[key], data.pins[key] + '\t', data.pins[key] + '\u007f', 42, null]) {
      const port = fakePorts(data);
      assert.throws(() => readOnboardSpaArtifact(port.directory, { ...data.pins, [key]: value }, port.ports), /explicit manifest SHA256/);
      assert.deepEqual(port.calls, []);
    }
  }
});

function beforeCommentLinkageGuard() {
  const next = source('scripts/lib/onboard-spa-artifact-contract.mjs');
  const block = "  // Token separators may contain comments; quoted reference bytes are never stripped.\n  const cssTrivia = String.raw`(?:\\s|\\/\\*(?:(?!\\*\\/)[\\s\\S])*\\*\\/)*`;\n  const jsTrivia = String.raw`(?:\\s|\\/\\*(?:(?!\\*\\/)[\\s\\S])*\\*\\/|\\/\\/[^\\r\\n]*(?:\\r?\\n|$))*`;\n  if (path.endsWith('.css')) {\n    for (const match of text.matchAll(new RegExp(String.raw`\\burl${cssTrivia}\\(${cssTrivia}(?:\"([^\"]+)\"|'([^']+)'|([^\\s)]+))${cssTrivia}\\)`, 'gi'))) add(match[1] ?? match[2] ?? match[3]);\n    for (const match of text.matchAll(new RegExp(String.raw`@import\\b${cssTrivia}[\"']([^\"']+)[\"']`, 'gi'))) add(match[1]);\n  }\n  if (/\\.(?:m?js)$/.test(path)) {\n    for (const match of text.matchAll(new RegExp(String.raw`\\b(?:import|export)\\b${jsTrivia}(?:(?:[^;'\"()/]|\\/\\*(?:(?!\\*\\/)[\\s\\S])*\\*\\/|\\/\\/[^\\r\\n]*(?:\\r?\\n|$)|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')*?\\bfrom\\b${jsTrivia})?[\"']([^\"']+)[\"']`, 'g'))) add(match[1], 'module');\n    const literal = new RegExp(String.raw`^${jsTrivia}([\"'])([^\"']+)\\1${jsTrivia}$`);\n    const imports = new Set();\n    for (const match of text.matchAll(new RegExp(String.raw`\\bimport\\b${jsTrivia}\\(([^)]*)\\)`, 'g'))) {\n      imports.add(match.index);\n      const value = literal.exec(match[1]);\n      if (!value) fail(`nonstatic module reference in ${path}`);\n      add(value[2], 'module');\n    }\n    for (const match of text.matchAll(new RegExp(String.raw`\\bimport\\b${jsTrivia}\\(`, 'g'))) {\n      if (!imports.has(match.index)) fail(`unsupported module reference in ${path}`);\n    }\n    const urls = new Set();\n    for (const match of text.matchAll(new RegExp(String.raw`\\bnew\\b${jsTrivia}URL\\b${jsTrivia}\\(([^)]*),${jsTrivia}import\\b${jsTrivia}\\.${jsTrivia}meta\\b${jsTrivia}\\.${jsTrivia}url\\b${jsTrivia}\\)`, 'g'))) {\n      urls.add(match.index);\n      const value = literal.exec(match[1]);\n      if (!value) fail(`nonstatic asset reference in ${path}`);\n      add(value[2]);\n    }\n    for (const match of text.matchAll(new RegExp(String.raw`\\bnew\\b${jsTrivia}URL\\b${jsTrivia}\\(`, 'g'))) {\n      if (!urls.has(match.index)) fail(`unsupported asset reference in ${path}`);\n    }\n";
  assert.equal(next.split(block).length, 2);
  const before = next.replace(block, "  if (path.endsWith('.css')) {\n    for (const match of text.matchAll(/url\\(\\s*(?:\"([^\"]+)\"|'([^']+)'|([^\\s)]+))\\s*\\)/gi)) add(match[1] ?? match[2] ?? match[3]);\n    for (const match of text.matchAll(/@import\\s+[\"']([^\"']+)[\"']/gi)) add(match[1]);\n  }\n  if (/\\.(?:m?js)$/.test(path)) {\n    for (const match of text.matchAll(/\\b(?:import|export)\\s*(?:[^;'\"()]*?\\bfrom\\s*)?[\"']([^\"']+)[\"']/g)) add(match[1], 'module');\n    for (const match of text.matchAll(/\\bimport\\s*\\(([^)]*)\\)/g)) {\n      const value = /^\\s*([\"'])([^\"']+)\\1\\s*$/.exec(match[1]);\n      if (!value) fail(`nonstatic module reference in ${path}`);\n      add(value[2], 'module');\n    }\n    for (const match of text.matchAll(/\\bnew\\s+URL\\s*\\(([^)]*),\\s*import\\.meta\\.url\\s*\\)/g)) {\n      const value = /^\\s*([\"'])([^\"']+)\\1\\s*$/.exec(match[1]);\n      if (!value) fail(`nonstatic asset reference in ${path}`);\n      add(value[2]);\n    }\n");
  assert.equal(sha(before), '47a5ba0c0164cebd9ed1721a14cf9ca907a024a4cd12044dcc297b8c562c0eb6');
  return before;
}

for (const [name, js, css] of [
  ['comment-separated bare static import', 'import/*review*/"react";', undefined],
  ['comment-separated nonstatic dynamic import', 'import/*review*/(variable);', undefined],
  ['comment-separated bare dynamic import', 'import/*review*/("react");', undefined],
  ['comment-separated bare export', 'export/*review*/{x}/*review*/from/*review*/"react";', undefined],
  ['comment-separated local CSS import', 'export const valid=1;', '@import/**/"./missing.css";'],
]) test(`actual static guard refuses ${name} without executing payloads`, () => {
  assert.throws(() => validate(fixture({ 'assets/main.js': js,
    ...(css === undefined ? {} : { 'assets/main.css': css }) })), /refused:/);
});

test('comment token gaps retain legitimate closed references and quoted remote URL text', () => {
  const data = fixture({
    'assets/main.js': 'import/*gap*/"./chunk.js"; export/*gap*/{x}/*gap*/from/*gap*/"./export.js"; const lazy=import/*gap*/(/*gap*/"./lazy.js"/*gap*/); const font=new/*gap*/URL/*gap*/(/*gap*/"./font.woff2"/*gap*/,/*gap*/import/*gap*/./*gap*/meta/*gap*/./*gap*/url/*gap*/); const text="/*kept in string*/";',
    'assets/main.css': '@import/**/"./nested.css";body{background:url/**/("https://example.test/x/*literal*/image.png");font-family:demo}@font-face{font-family:demo;src:url/**/("./font.woff2")}',
  });
  assert.equal(validate(data).qualification, 'static-byte-contract-only');
});

test('recognized unsupported or escaped module and URL argument forms refuse before resource lookup', () => {
  for (const js of [
    'import/*gap*/("https://example.test/x.js");',
    'import/*gap*/(".\\/chunk.js");',
    'import/*gap*/(variable',
    'const x=new/*gap*/URL/*gap*/(variable,import.meta.url);',
    'const x=new/*gap*/URL/*gap*/("./font.woff2",otherBase);',
    'const x=new/*gap*/URL/*gap*/("./missing.png",import.meta.url);',
  ]) assert.throws(() => validate(fixture({ 'assets/main.js': js })), /refused:/);
});

for (const js of [
  'import {x /* "ignored" */} from "react";',
  'export {x /* ) */} from "react";',
  'export {x /* "ignored" */} from "react";',
  'import {"foo" as x} from "react";',
  'export {x as "foo"} from "react";',
]) test(`binding clause cannot hide an unbundled module: ${js}`, () => {
  assert.throws(() => validate(fixture({ 'assets/main.js': js })), /unbundled module/);
});

test('comment and quoted binding tokens retain closed module references without swallowing later declarations', () => {
  const data = fixture({ 'assets/main.js': 'import {c /* "ignored" */} from "./chunk.js"; export {x /* ) */} from "./export.js"; import {"c" as named} from "./chunk.js"; const note="/* quoted text stays */";' });
  assert.equal(validate(data).qualification, 'static-byte-contract-only');
  assert.throws(() => validate(fixture({ 'assets/main.js': 'import /* harmless */ "./chunk.js"; /* second */ import "react";' })), /unbundled module/);
});
