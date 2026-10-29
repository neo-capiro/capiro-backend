/**
 * @cleanup-smoke noArgsExit=2 helpExit=0
 *
 * Legacy Web (port 8080) artifact preparation for the existing Backend recipe.
 *
 * This operator only drives builders that already exist. It never compiles the
 * frontend itself, never starts an application, never builds or pushes an image
 * and never calls AWS:
 *
 *   1. the frontend's existing Dockerfile build stage is exported through its
 *      `standalone-artifact` target with buildx's local exporter;
 *   2. the exported trees are inventoried into the manifest the existing byte
 *      gate requires (scripts/lib/frontend-standalone-artifact-contract.mjs);
 *   3. the manifest and trees are handed to the existing assembly owner
 *      (assembleNewsletterReleaseArtifact), which admits them and publishes
 *      release-artifacts/capiro-frontend/{manifest.json,rootfs/**,build-receipt.json}.
 *
 * Every input is explicit; there is no default source, target, path or pin.
 * The produced artifact keeps the reviewed source admission gate, so a source
 * that is not the reviewed active frontend commit is refused.
 *
 * Usage (Linux builder, Node24):
 *   node scripts/legacy-web-release.mjs artifact \
 *     --frontend-checkout /abs/capiro-frontend \
 *     --frontend-commit <40-hex> \
 *     --export-dir /abs/export \
 *     --manifest /abs/export.manifest.json \
 *     --output-dir /abs/context/release-artifacts/capiro-frontend \
 *     --backend-commit <40-hex> \
 *     --arch arm64
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectFrontendStandaloneManifest, inspectFrontendStandalonePath,
  NEWSLETTER_ACCEPTED_SOURCE_PROFILE } from './lib/frontend-standalone-artifact-contract.mjs';
import { assembleNewsletterReleaseArtifact } from './lib/newsletter-artifact-packaging-plan.mjs';

export const LEGACY_WEB_USAGE = 'Usage: node scripts/legacy-web-release.mjs artifact --frontend-checkout ABS --frontend-commit 40HEX --export-dir ABS --manifest ABS --output-dir ABS --backend-commit 40HEX --arch arm64|amd64';
export const LEGACY_WEB_FLAGS = Object.freeze(['--frontend-checkout', '--frontend-commit', '--export-dir',
  '--manifest', '--output-dir', '--backend-commit', '--arch']);
const SOURCE_REPOSITORY = NEWSLETTER_ACCEPTED_SOURCE_PROFILE.repository;
const SERVER_ENTRYPOINT = 'apps/web/server.js';
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refuse = (reason) => { throw new Error('Legacy Web release refused: ' + reason); };
const literal = (value) => typeof value === 'string' && value.length > 0 && value === value.trim() &&
  !/[\u0000-\u001f\u007f\\]/.test(value);
function absolute(value) {
  if (!literal(value) || !value.startsWith('/') || value === '/' || path.posix.normalize(value) !== value)
    refuse('literal canonical absolute path required');
  inspectFrontendStandalonePath(value.slice(1));
  return value;
}
/** Exact flag contract: no defaults, no repeats, no positional arguments. */
export function parseLegacyWebInvocation(args) {
  if (Array.isArray(args) && args.length === 1 && ['--help', '-h'].includes(args[0])) return Object.freeze({ mode: 'help' });
  if (!Array.isArray(args) || args[0] !== 'artifact' || args.length !== 1 + LEGACY_WEB_FLAGS.length * 2)
    refuse('one explicit artifact mode with all seven flags required');
  const values = new Map();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    if (!LEGACY_WEB_FLAGS.includes(flag) || values.has(flag) || !literal(args[index + 1]))
      refuse('unknown, duplicate or nonliteral flag');
    values.set(flag, args[index + 1]);
  }
  const options = Object.freeze({
    frontendCheckout: absolute(values.get('--frontend-checkout')),
    frontendCommit: values.get('--frontend-commit'),
    exportDir: absolute(values.get('--export-dir')),
    manifestPath: absolute(values.get('--manifest')),
    outputDir: absolute(values.get('--output-dir')),
    backendCommit: values.get('--backend-commit'),
    arch: values.get('--arch'),
  });
  if (!/^[a-f0-9]{40}$/.test(options.frontendCommit) || !/^[a-f0-9]{40}$/.test(options.backendCommit))
    refuse('40-hex frontend and backend commits required');
  if (!['arm64', 'amd64'].includes(options.arch)) refuse('explicit linux arm64 or amd64 target required');
  for (const input of [options.frontendCheckout, options.exportDir])
    if (options.outputDir === input || options.outputDir.startsWith(input + '/') || input.startsWith(options.outputDir + '/'))
      refuse('artifact output overlaps a build input');
  if (options.manifestPath.startsWith(options.exportDir + '/') || options.manifestPath === options.exportDir)
    refuse('manifest must live outside the exported trees');
  if (options.manifestPath === options.outputDir || options.manifestPath.startsWith(options.outputDir + '/'))
    refuse('manifest must live outside the assembled artifact');
  return Object.freeze({ mode: 'artifact', options });
}

async function regularReadable(file) {
  const stat = await fs.lstat(file);
  // Regular, non-symlink, bounded input. Ancestor realpath and exhaustive
  // inventory equality are revalidated by the canonical reader at assembly.
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES)
    refuse('regular bounded input file required');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}
async function requireDirectory(value) {
  const stat = await fs.lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('nonregular directory input');
}
/** Exhaustive inventory of the three exported trees as rootfs-relative entries. */
export async function inventoryExportedTrees({ standaloneDir, publicDir, staticDir }) {
  const entries = new Map();
  async function walk(root, prefix) {
    await requireDirectory(root);
    for (const name of (await fs.readdir(root)).sort()) {
      const local = root + '/' + name, relative = prefix + name;
      inspectFrontendStandalonePath(relative);
      const stat = await fs.lstat(local);
      if (stat.isDirectory() && !stat.isSymbolicLink()) { await walk(local, relative + '/'); continue; }
      let entry;
      if (stat.isSymbolicLink()) entry = { path: relative, type: 'symlink', target: await fs.readlink(local) };
      else if (stat.isFile()) {
        const bytes = await regularReadable(local);
        entry = { path: relative, type: 'file', bytes: bytes.length, sha256: sha(bytes) };
      } else refuse('nonregular exported entry');
      const previous = entries.get(relative);
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) refuse('conflicting exported overlays');
      if (!previous) entries.set(relative, entry);
      if (entries.size > MAX_ENTRIES) refuse('exported inventory budget');
    }
  }
  await walk(standaloneDir, '');
  await walk(publicDir, 'apps/web/public/');
  await walk(staticDir, 'apps/web/.next/static/');
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
}
/** Deterministic manifest bytes for the existing standalone artifact contract. */
export function manifestBytesFor({ entries, sourceCommit, arch }) {
  const manifest = { schemaVersion: 1, artifactType: 'capiro-frontend-next-standalone',
    source: { repository: SOURCE_REPOSITORY, commit: sourceCommit },
    runtimeTarget: { os: 'linux', arch, libc: 'musl', nodeMajor: 24 },
    serverEntrypoint: SERVER_ENTRYPOINT, entries };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const manifestSha256 = sha(bytes);
  // The canonical declaration grammar runs before the manifest is written.
  inspectFrontendStandaloneManifest({ manifestBytes: bytes,
    pins: { sourceRepository: SOURCE_REPOSITORY, sourceCommit, manifestSha256, runtimeTarget: manifest.runtimeTarget } });
  return { bytes, manifestSha256 };
}
function assertFrontendCheckout(checkout, commit) {
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  if (git('rev-parse', 'HEAD') !== commit) refuse('frontend checkout is not at the declared commit');
  if (git('status', '--porcelain', '--untracked-files=no') !== '') refuse('frontend checkout has tracked modifications');
}
export async function runLegacyWebArtifact(options) {
  // The existing assembly owner only publishes on the reviewed Linux/Node24 host;
  // refuse before spending an export if this is not that host.
  if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '24')
    refuse('legacy Web artifact preparation requires Linux/Node24');
  assertFrontendCheckout(options.frontendCheckout, options.frontendCommit);
  for (const absent of [options.exportDir, options.manifestPath, options.outputDir]) {
    try { await fs.lstat(absent); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    refuse('immutable input/output already exists');
  }
  await fs.mkdir(path.dirname(options.manifestPath), { recursive: true });
  await fs.mkdir(path.dirname(options.outputDir), { recursive: true });
  execFileSync('docker', ['buildx', 'build', '--platform', 'linux/' + options.arch,
    '--target', 'standalone-artifact', '--output', 'type=local,dest=' + options.exportDir,
    options.frontendCheckout], { stdio: 'inherit' });
  const entries = await inventoryExportedTrees({ standaloneDir: options.exportDir + '/standalone',
    publicDir: options.exportDir + '/public', staticDir: options.exportDir + '/static' });
  const { bytes, manifestSha256 } = manifestBytesFor({ entries, sourceCommit: options.frontendCommit, arch: options.arch });
  await fs.writeFile(options.manifestPath, bytes, { flag: 'wx' });
  const receipt = await assembleNewsletterReleaseArtifact({
    standaloneDir: options.exportDir + '/standalone', publicDir: options.exportDir + '/public',
    staticDir: options.exportDir + '/static', manifestPath: options.manifestPath, manifestSha256,
    sourceRepository: SOURCE_REPOSITORY, sourceCommit: options.frontendCommit,
    targetPlatform: 'linux/' + options.arch, targetLibc: 'musl', targetNodeMajor: '24',
    backendSourceCommit: options.backendCommit, outputDir: options.outputDir,
  });
  return Object.freeze({ status: receipt.status, manifestSha256, outputDir: options.outputDir,
    receiptPath: options.outputDir + '/build-receipt.json', counts: receipt.counts,
    artifact: options.outputDir, imageBuildArgs: Object.freeze({
      FRONTEND_ARTIFACT_MANIFEST_SHA256: manifestSha256, FRONTEND_ARTIFACT_SOURCE_REPOSITORY: SOURCE_REPOSITORY,
      FRONTEND_ARTIFACT_SOURCE_COMMIT: options.frontendCommit }) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const invocation = parseLegacyWebInvocation(process.argv.slice(2));
    if (invocation.mode === 'help') console.log(LEGACY_WEB_USAGE);
    else console.log(JSON.stringify(await runLegacyWebArtifact(invocation.options), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'FAIL', artifactAssemblyPerformed: false,
      imageBuildPerformed: false, shippingAuthorized: false, usage: LEGACY_WEB_USAGE,
      error: String(error.message).slice(0, 300) }));
    process.exitCode = 2;
  }
}
