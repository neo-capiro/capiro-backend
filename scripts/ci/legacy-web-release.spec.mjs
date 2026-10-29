import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';
import { LEGACY_WEB_USAGE, inventoryExportedTrees, manifestBytesFor,
  parseLegacyWebInvocation, runLegacyWebArtifact } from '../legacy-web-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER = path.join('scripts', 'legacy-web-release.mjs');
const SOURCE = readFileSync(path.join(ROOT, OWNER), 'utf8');
const COMMIT = 'e'.repeat(40);
const BACKEND = 'b'.repeat(40);
const base = {
  '--frontend-checkout': '/work/capiro-frontend', '--frontend-commit': COMMIT,
  '--export-dir': '/work/export', '--manifest': '/work/export.manifest.json',
  '--output-dir': '/work/context/release-artifacts/capiro-frontend',
  '--backend-commit': BACKEND, '--arch': 'arm64',
};
const args = (change = {}) => {
  const values = { ...base, ...change };
  return ['artifact', ...Object.entries(values).flat()];
};

describe('legacy Web artifact operator invocation', () => {
  test('help exits 0 and no arguments exits 2 with the explicit usage', () => {
    const help = spawnSync(process.execPath, [OWNER, '--help'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stdout.trim(), LEGACY_WEB_USAGE);
    const empty = spawnSync(process.execPath, [OWNER], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(empty.status, 2);
    assert.equal(JSON.parse(empty.stderr).artifactAssemblyPerformed, false);
    assert.equal(JSON.parse(empty.stderr).shippingAuthorized, false);
  });

  test('the operator drives no push, deploy, registry or cloud API', () => {
    for (const forbidden of ['docker push', "'--push'", 'update-service', 'force-new-deployment',
      'codebuild', 'start-build', 'ecr', "'aws'"])
      assert.ok(!SOURCE.includes(forbidden), forbidden);
    assert.match(SOURCE, /'buildx', 'build'/);
    assert.match(SOURCE, /'--target', 'standalone-artifact'/);
    assert.match(SOURCE, /'--output', 'type=local,dest='/);
  });

  test('all seven explicit flags are required with no default or positional fallback', () => {
    const invocation = parseLegacyWebInvocation(args());
    assert.equal(invocation.mode, 'artifact');
    assert.deepEqual(invocation.options, {
      frontendCheckout: '/work/capiro-frontend', frontendCommit: COMMIT, exportDir: '/work/export',
      manifestPath: '/work/export.manifest.json',
      outputDir: '/work/context/release-artifacts/capiro-frontend', backendCommit: BACKEND, arch: 'arm64',
    });
    assert.equal(Object.isFrozen(invocation.options), true);
    for (const [name, value] of [['--frontend-commit', 'main'], ['--backend-commit', 'HEAD'],
      ['--arch', 'x86_64'], ['--arch', 'linux/arm64'], ['--frontend-checkout', 'relative/dir'],
      ['--manifest', '/work/export/manifest.json'], ['--output-dir', '/work/export/artifact'],
      ['--frontend-checkout', '/work/context']])
      assert.throws(() => parseLegacyWebInvocation(args({ [name]: value })), undefined, name);
    assert.throws(() => parseLegacyWebInvocation(['artifact', ...Object.entries(base).flat().slice(2)]));
    assert.throws(() => parseLegacyWebInvocation(['artifact', ...Object.entries(base).flat(), '--arch', 'amd64']));
    assert.throws(() => parseLegacyWebInvocation(['image', ...Object.entries(base).flat()]));
    assert.throws(() => parseLegacyWebInvocation(args({ '--push': 'true' })));
  });
});

describe('legacy Web artifact inventory and manifest', () => {
  const tree = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'legacy-web-'));
    const standalone = path.join(root, 'standalone'), publicDir = path.join(root, 'public');
    const staticDir = path.join(root, 'static');
    mkdirSync(path.join(standalone, 'apps', 'web', '.next', 'static', 'chunks'), { recursive: true });
    mkdirSync(path.join(publicDir, 'newsletter'), { recursive: true });
    mkdirSync(path.join(staticDir, 'css'), { recursive: true });
    writeFileSync(path.join(standalone, 'apps', 'web', 'server.js'), 'process.exit(0)\n');
    writeFileSync(path.join(standalone, 'apps', 'web', '.next', 'BUILD_ID'), 'build-id\n');
    writeFileSync(path.join(standalone, 'apps', 'web', '.next', 'required-server-files.json'),
      `${JSON.stringify({ config: { output: 'standalone', distDir: '.next' }, relativeAppDir: 'apps/web', files: [] })}\n`);
    writeFileSync(path.join(standalone, 'apps', 'web', '.next', 'static', 'chunks', 'a.js'), 'console.log(1)\n');
    writeFileSync(path.join(publicDir, 'newsletter', 'capitol.png'), 'png');
    writeFileSync(path.join(staticDir, 'css', 'app.css'), 'body{}');
    return { root, standalone, publicDir, staticDir };
  };

  test('inventory indexes every exported file with rootfs-relative paths and real digests', async () => {
    const { standalone, publicDir, staticDir } = tree();
    const entries = await inventoryExportedTrees({ standaloneDir: standalone, publicDir, staticDir });
    assert.deepEqual(entries.map((entry) => entry.path), [
      'apps/web/.next/BUILD_ID', 'apps/web/.next/required-server-files.json',
      'apps/web/.next/static/chunks/a.js', 'apps/web/.next/static/css/app.css',
      'apps/web/public/newsletter/capitol.png', 'apps/web/server.js',
    ]);
    const css = await inventoryExportedTrees({ standaloneDir: standalone, publicDir, staticDir });
    assert.deepEqual(entries, css, 'inventory is deterministic');
    const server = entries.find((entry) => entry.path === 'apps/web/server.js');
    assert.equal(server.type, 'file'); assert.equal(server.bytes, 16);
    assert.equal(server.sha256, createHash('sha256').update('process.exit(0)\n').digest('hex'));
    for (const entry of entries) assert.deepEqual(Object.keys(entry).sort(),
      entry.type === 'file' ? ['bytes', 'path', 'sha256', 'type'] : ['path', 'target', 'type']);
  });

  test('inventory refuses a credential-shaped exported path instead of indexing it', async () => {
    const { standalone, publicDir, staticDir } = tree();
    writeFileSync(path.join(standalone, '.env.production'), 'secret\n');
    await assert.rejects(inventoryExportedTrees({ standaloneDir: standalone, publicDir, staticDir }),
      /unsafe or credential artifact path/);
  });

  test('manifest bytes stay refused by the canonical gate until the required server and Newsletter assets exist', async () => {
    const { standalone, publicDir, staticDir } = tree();
    const entries = await inventoryExportedTrees({ standaloneDir: standalone, publicDir, staticDir });
    assert.throws(() => manifestBytesFor({ entries, sourceCommit: COMMIT, arch: 'arm64' }),
      /required Newsletter public asset/);
    assert.throws(() => manifestBytesFor({ entries, sourceCommit: 'main', arch: 'arm64' }), /source repository/);
    const escaping = [...entries, { path: 'apps/web/link', type: 'symlink', target: '../../../etc/passwd' }];
    assert.throws(() => manifestBytesFor({ entries: escaping, sourceCommit: COMMIT, arch: 'arm64' }),
      /escaping symlink\/reference target/);
    const duplicate = [...entries, entries[0]];
    assert.throws(() => manifestBytesFor({ entries: duplicate, sourceCommit: COMMIT, arch: 'arm64' }),
      /duplicate artifact path/);
  });

  test('a non-Linux/Node24 host is refused before any export, manifest or artifact write', async () => {
    const options = parseLegacyWebInvocation(args({ '--export-dir': '/work/export-2',
      '--manifest': '/work/export-2.manifest.json', '--output-dir': '/work/assembled-2' })).options;
    if (process.platform === 'linux' && process.versions.node.split('.')[0] === '24') {
      // The reviewed assembly host is exercised by the release run, not here.
      assert.equal(typeof runLegacyWebArtifact, 'function');
      return;
    }
    await assert.rejects(runLegacyWebArtifact(options), /requires Linux\/Node24/);
  });
});
