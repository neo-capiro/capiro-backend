import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';
import { LEGACY_WEB_APP_LAYOUT, LEGACY_WEB_USAGE, assertActiveSourceCommit, assertExtractedAppLayout,
  inventoryExtractedApp, manifestBytesFor, parseLegacyWebInvocation, runLegacyWebArtifact } from '../legacy-web-release.mjs';
import { NEWSLETTER_ACCEPTED_SOURCE_PROFILE as PROFILE } from '../lib/frontend-standalone-artifact-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER = path.join('scripts', 'legacy-web-release.mjs');
const SOURCE = readFileSync(path.join(ROOT, OWNER), 'utf8');
const FRONTEND = 'ee470d7d44b811dc84d147c62a3eab7c9b5be09f';
const DIGEST = 'sha256:983eb6d99feb25e664a0a2f14244d60e906f12f88a3a262b27519ffbed53f930';
const BACKEND = 'b'.repeat(40);
const base = {
  '--extracted-app-dir': '/work/app', '--frontend-commit': FRONTEND, '--image-digest': DIGEST,
  '--manifest': '/work/artifact.manifest.json',
  '--output-dir': '/work/context/release-artifacts/capiro-frontend',
  '--backend-commit': BACKEND, '--arch': 'arm64',
};
const args = (change = {}) => ['artifact', ...Object.entries({ ...base, ...change }).flat()];

/** Minimal tree that already has the qualified image's /app artifact layout. */
const tree = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'legacy-web-'));
  const app = path.join(root, 'app');
  mkdirSync(path.join(app, 'apps', 'web', '.next', 'static', 'chunks'), { recursive: true });
  mkdirSync(path.join(app, 'apps', 'web', '.next', 'server', 'app'), { recursive: true });
  mkdirSync(path.join(app, 'apps', 'web', 'public', 'newsletter'), { recursive: true });
  writeFileSync(path.join(app, 'apps', 'web', 'server.js'), 'process.exit(0)\n');
  writeFileSync(path.join(app, 'apps', 'web', '.next', 'BUILD_ID'), 'build-id\n');
  writeFileSync(path.join(app, 'apps', 'web', '.next', 'required-server-files.json'),
    `${JSON.stringify({ config: { output: 'standalone', distDir: '.next' }, relativeAppDir: 'apps/web', files: [] })}\n`);
  writeFileSync(path.join(app, 'apps', 'web', '.next', 'static', 'chunks', 'a.js'), 'console.log(1)\n');
  writeFileSync(path.join(app, 'apps', 'web', 'public', 'newsletter', 'capitol.png'), 'png');
  return { root, app };
};

describe('legacy Web artifact operator (extraction from the qualified image)', () => {
  test('help exits 0 and no arguments exits 2 with the explicit usage', () => {
    const help = spawnSync(process.execPath, [OWNER, '--help'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stdout.trim(), LEGACY_WEB_USAGE);
    const empty = spawnSync(process.execPath, [OWNER], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(empty.status, 2);
    assert.equal(JSON.parse(empty.stderr).artifactAssemblyPerformed, false);
    assert.equal(JSON.parse(empty.stderr).shippingAuthorized, false);
  });

  test('the producer path is extraction only: no container tooling, no frontend build target, no push or cloud API', () => {
    for (const forbidden of ['buildx', '--target', "'docker'", 'execFileSync', 'spawnSync',
      'docker push', 'update-service', 'start-build', 'codebuild', "'aws'", 'ecr'])
      assert.ok(!SOURCE.includes(forbidden), forbidden);
    assert.match(SOURCE, /--image-digest/);
    assert.match(SOURCE, /assembleNewsletterReleaseArtifact/);
    assert.match(SOURCE, /inspectFrontendStandaloneManifest/);
  });
});

describe('legacy Web artifact invocation contract', () => {
  test('all seven explicit flags are required with no default or positional fallback', () => {
    const invocation = parseLegacyWebInvocation(args());
    assert.equal(invocation.mode, 'artifact');
    assert.deepEqual(invocation.options, {
      extractedAppDir: '/work/app', frontendCommit: FRONTEND, imageDigest: DIGEST,
      manifestPath: '/work/artifact.manifest.json',
      outputDir: '/work/context/release-artifacts/capiro-frontend', backendCommit: BACKEND, arch: 'arm64',
    });
    assert.equal(Object.isFrozen(invocation.options), true);
    for (const [name, value] of [['--frontend-commit', 'main'], ['--backend-commit', 'HEAD'],
      ['--arch', 'x86_64'], ['--arch', 'linux/arm64'], ['--extracted-app-dir', 'relative/dir'],
      ['--image-digest', 'sha256:983eb6d9'], ['--image-digest', '983eb6d99feb25e664a0a2f14244d60e906f12f88a3a262b27519ffbed53f930'],
      ['--manifest', '/work/app/manifest.json'], ['--output-dir', '/work/app/artifact'],
      ['--extracted-app-dir', '/work/context']])
      assert.throws(() => parseLegacyWebInvocation(args({ [name]: value })), undefined, name);
    assert.throws(() => parseLegacyWebInvocation(['artifact', ...Object.entries(base).flat().slice(2)]));
    assert.throws(() => parseLegacyWebInvocation(['artifact', ...Object.entries(base).flat(), '--arch', 'amd64']));
    assert.throws(() => parseLegacyWebInvocation(['image', ...Object.entries(base).flat()]));
    assert.throws(() => parseLegacyWebInvocation(args({ '--push': 'true' })));
  });

  test('the declared source must be the reviewed active source, not merely a valid commit', () => {
    assert.equal(PROFILE.activeCommit, FRONTEND, 'pinned active artifact source');
    assert.equal(assertActiveSourceCommit(FRONTEND), FRONTEND);
    for (const commit of ['c8aa693e884de86001d2fc04fbb60d48db09341c',
      '83f54f5ac0107822833adbbfef2b453e0240bc56', '90ccdd47de7a989e822590d616d69baa15a37d5d',
      '7c87678730538958ace9762f824dc3e588bf445b', 'c'.repeat(40)])
      assert.throws(() => assertActiveSourceCommit(commit), /is not the active accepted source/);
    // The producer's /app layout is the artifact rootfs the contract expects.
    assert.deepEqual([...LEGACY_WEB_APP_LAYOUT.requiredFiles], ['apps/web/server.js',
      'apps/web/.next/BUILD_ID', 'apps/web/.next/required-server-files.json']);
    assert.deepEqual([...LEGACY_WEB_APP_LAYOUT.requiredDirectories], ['apps/web/.next/static',
      'apps/web/public/newsletter']);
  });
});

describe('legacy Web extracted-tree admission', () => {
  test('the qualified image layout is accepted and its inventory is deterministic with real digests', async () => {
    const { app } = tree();
    const layout = await assertExtractedAppLayout(app);
    assert.equal(layout.requiredFiles, 3);
    assert.equal(layout.staticEntries, 1);
    assert.equal(layout.newsletterEntries, 1);
    const entries = await inventoryExtractedApp({ appDir: app });
    assert.deepEqual(entries.map((entry) => entry.path), [
      'apps/web/.next/BUILD_ID', 'apps/web/.next/required-server-files.json', 'apps/web/.next/static/chunks/a.js',
      'apps/web/public/newsletter/capitol.png', 'apps/web/server.js',
    ]);
    assert.deepEqual(entries, await inventoryExtractedApp({ appDir: app }), 'inventory is deterministic');
    const server = entries.find((entry) => entry.path === 'apps/web/server.js');
    assert.equal(server.bytes, 16);
    assert.equal(server.sha256, createHash('sha256').update('process.exit(0)\n').digest('hex'));
    for (const entry of entries) assert.deepEqual(Object.keys(entry).sort(),
      entry.type === 'file' ? ['bytes', 'path', 'sha256', 'type'] : ['path', 'target', 'type']);
  });

  test('an image tree that is not the artifact layout is refused instead of indexed', async () => {
    const missingServer = tree();
    rmSync(path.join(missingServer.app, 'apps', 'web', 'server.js'), { force: true });
    await assert.rejects(assertExtractedAppLayout(missingServer.app), /missing extracted layout file/);
    const emptyStatic = tree();
    rmSync(path.join(emptyStatic.app, 'apps', 'web', '.next', 'static', 'chunks', 'a.js'), { force: true });
    await assert.rejects(assertExtractedAppLayout(emptyStatic.app), /empty extracted Next static output/);
    const noNewsletter = tree();
    rmSync(path.join(noNewsletter.app, 'apps', 'web', 'public', 'newsletter', 'capitol.png'), { force: true });
    await assert.rejects(assertExtractedAppLayout(noNewsletter.app), /empty extracted Newsletter public assets/);
    const credential = tree();
    writeFileSync(path.join(credential.app, '.env.production'), 'secret\n');
    await assert.rejects(inventoryExtractedApp({ appDir: credential.app }), /unsafe or credential artifact path/);
  });

  test('manifest bytes stay refused by the canonical gate until the required server and Newsletter assets exist', async () => {
    const { app } = tree();
    const entries = await inventoryExtractedApp({ appDir: app });
    assert.throws(() => manifestBytesFor({ entries, sourceCommit: FRONTEND, arch: 'arm64' }),
      /required Newsletter public asset/);
    assert.throws(() => manifestBytesFor({ entries, sourceCommit: 'main', arch: 'arm64' }), /source repository/);
    const escaping = [...entries, { path: 'apps/web/link', type: 'symlink', target: '../../../etc/passwd' }];
    assert.throws(() => manifestBytesFor({ entries: escaping, sourceCommit: FRONTEND, arch: 'arm64' }),
      /escaping symlink\/reference target/);
    assert.throws(() => manifestBytesFor({ entries: [...entries, entries[0]], sourceCommit: FRONTEND, arch: 'arm64' }),
      /duplicate artifact path/);
  });

  test('a non-Linux/Node24 host is refused before any manifest or artifact write', async () => {
    const options = parseLegacyWebInvocation(args({ '--extracted-app-dir': '/work/app-2',
      '--manifest': '/work/app-2.manifest.json', '--output-dir': '/work/assembled-2' })).options;
    if (process.platform === 'linux' && process.versions.node.split('.')[0] === '24') {
      // The reviewed assembly host is exercised by the release run, not here.
      assert.equal(typeof runLegacyWebArtifact, 'function');
      return;
    }
    await assert.rejects(runLegacyWebArtifact(options), /requires Linux\/Node24/);
  });
});
