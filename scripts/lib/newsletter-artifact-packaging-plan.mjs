/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectFrontendStandaloneManifest, inspectFrontendStandalonePath, validateFrontendStandaloneArtifact,
  NEWSLETTER_ACCEPTED_SOURCE_PROFILE, inspectNewsletterSourceAdmission, assertAcceptedNewsletterArtifactSource,
  readFrontendStandaloneArtifact } from './frontend-standalone-artifact-contract.mjs';

export const NEWSLETTER_BACKEND_PACKAGING_SOURCE = Object.freeze({
  repository: 'neo-capiro/capirov2', path: 'scripts/build-newsletter-release.sh',
  boundary: 'local-already-built-artifact-assembly', nodeMajor: 24,
});
export const NEWSLETTER_FRONTEND_ARTIFACT_PROFILE = Object.freeze({
  repository: NEWSLETTER_ACCEPTED_SOURCE_PROFILE.repository,
  dockerConsumer: 'apps/web/Dockerfile.frontend-artifact',
  serverEntrypoint: 'apps/web/server.js', receipt: 'build-receipt.json',
  maxEntries: 20000, maxTotalBytes: 512 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024,
  maxManifestBytes: 16 * 1024 * 1024,
});
const refuse = reason => { throw new Error('Newsletter assembly refused: ' + reason); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const keys = ['standaloneDir', 'publicDir', 'staticDir', 'manifestPath', 'manifestSha256',
  'sourceRepository', 'sourceCommit', 'targetPlatform', 'targetLibc', 'targetNodeMajor',
  'backendSourceCommit', 'outputDir'];
const flags = new Map([['--standalone-dir', 'standaloneDir'], ['--public-dir', 'publicDir'],
  ['--static-dir', 'staticDir'], ['--manifest', 'manifestPath'], ['--manifest-sha256', 'manifestSha256'],
  ['--source-repository', 'sourceRepository'], ['--source-commit', 'sourceCommit'],
  ['--target-platform', 'targetPlatform'], ['--target-libc', 'targetLibc'],
  ['--target-node-major', 'targetNodeMajor'], ['--backend-source-commit', 'backendSourceCommit'],
  ['--output-dir', 'outputDir']]);
const literal = value => typeof value === 'string' && value.length > 0 && value === value.trim()
  && !/[\u0000-\u001f\u007f\\]/.test(value);
function absolute(value) {
  if (!literal(value) || !value.startsWith('/') || value === '/' || path.posix.normalize(value) !== value)
    refuse('literal canonical absolute input/output path');
  inspectFrontendStandalonePath(value.slice(1));
  return value;
}
function optionsContract(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).sort().join(',') !== [...keys].sort().join(',')) refuse('exact explicit build options');
  const copy = Object.fromEntries(keys.map(key => [key, options[key]]));
  for (const key of ['standaloneDir', 'publicDir', 'staticDir', 'manifestPath', 'outputDir']) absolute(copy[key]);
  if (copy.sourceRepository !== NEWSLETTER_FRONTEND_ARTIFACT_PROFILE.repository
      || !literal(copy.sourceCommit) || !/^[a-f0-9]{40}$/.test(copy.sourceCommit)
      || !literal(copy.manifestSha256) || !/^[a-f0-9]{64}$/.test(copy.manifestSha256)
      || !literal(copy.backendSourceCommit) || !/^[a-f0-9]{40}$/.test(copy.backendSourceCommit)
      || !['linux/amd64', 'linux/arm64'].includes(copy.targetPlatform)
      || copy.targetLibc !== 'musl' || copy.targetNodeMajor !== '24') refuse('approved source/manifest/Linux/musl/Node24 pins');
  const inputs = [copy.standaloneDir, copy.publicDir, copy.staticDir, copy.manifestPath];
  for (const input of inputs) if (copy.outputDir === input || copy.outputDir.startsWith(input + '/')
      || input.startsWith(copy.outputDir + '/')) refuse('output overlaps input');
  return Object.freeze(copy);
}
export function parseNewsletterBuildInvocation(args) {
  if (Array.isArray(args) && args.length === 1 && args[0] === '--help') return Object.freeze({ mode: 'help' });
  if (!Array.isArray(args) || !['--plan', '--run'].includes(args[0]) || args.length !== 1 + flags.size * 2)
    refuse('one explicit --plan/--run and all twelve flag values required');
  const options = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = flags.get(args[i]);
    if (!key || Object.hasOwn(options, key) || !literal(args[i + 1])) refuse('unknown/duplicate/nonliteral build argument');
    options[key] = args[i + 1];
  }
  const checked = optionsContract(options);
  if (args[0] === '--run') assertAcceptedNewsletterArtifactSource(pinsFor(checked));
  return Object.freeze({ mode: args[0].slice(2), options: checked });
}
function pinsFor(options) {
  return { sourceRepository: options.sourceRepository, sourceCommit: options.sourceCommit,
    manifestSha256: options.manifestSha256,
    runtimeTarget: { os: 'linux', arch: options.targetPlatform.split('/')[1], libc: 'musl', nodeMajor: 24 } };
}
export function createNewsletterArtifactPackagingPlan(input, { sourceAdmissionFixture } = {}) {
  const options = optionsContract(input);
  return Object.freeze({ schemaVersion: 1, kind: 'newsletter-release-assembly-plan',
    sourceOnly: true, source: { repository: options.sourceRepository, commit: options.sourceCommit },
    declaredBackendSource: { repository: NEWSLETTER_BACKEND_PACKAGING_SOURCE.repository, commit: options.backendSourceCommit },
    runtimeTarget: pinsFor(options).runtimeTarget, manifestSha256: options.manifestSha256,
    sourceAdmission: inspectNewsletterSourceAdmission(pinsFor(options), { sourceAdmissionFixture }),
    inputs: { standalone: options.standaloneDir, public: options.publicDir, static: options.staticDir, manifest: options.manifestPath },
    outputDir: options.outputDir, receiptPath: options.outputDir + '/build-receipt.json',
    dockerConsumer: NEWSLETTER_FRONTEND_ARTIFACT_PROFILE.dockerConsumer,
    assemblyPerformed: false, buildUsedSourceVerified: false, nativeRuntimeCompatibilityVerified: false,
    localServingVerified: false, uiAcceptanceVerified: false, shippingAuthorized: false });
}
async function directory(io, value) {
  await io.lstat('/').then(stat => { if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('nonregular root directory'); });
  const parts = value.split('/').filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const item = '/' + parts.slice(0, i).join('/');
    const stat = await io.lstat(item);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await io.realpath(item) !== item) refuse('symlink/nonregular input/output ancestor');
  }
}
async function absent(io, value) {
  try { await io.lstat(value); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  refuse('immutable output already exists');
}
async function regularBuffer(io, file, limit) {
  const stat = await io.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || await io.realpath(file) !== file)
    refuse('regular bounded input file required');
  const handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const chunks = []; let count = 0;
    while (count <= limit) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - count));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, count);
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > chunk.length) refuse('bounded snapshot read');
      if (bytesRead === 0) break;
      count += bytesRead;
      if (count > limit) refuse('bounded snapshot read');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (count !== stat.size) refuse('bounded snapshot read');
    return Buffer.concat(chunks, count);
  } finally { await handle.close(); }
}
async function syncDirectory(io, value) {
  const handle = await io.open(value, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeBuffer(io, value, bytes, mode = 0o644) {
  const handle = await io.open(value, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
}
function receiptFor(options, artifact, counts, fixtureLabel, builtinFilesystem, sourceAdmission) {
  return { schemaVersion: 1, kind: 'newsletter-release-assembly', status: 'PASS',
    syntheticModel: fixtureLabel !== undefined || sourceAdmission.syntheticSourceApprovalModel, fixtureLabel: fixtureLabel ?? null,
    sourceAdmission,
    builtinFilesystem, builtinFilesystemEffectsPerformed: builtinFilesystem, filesystemEffectsIndependentlyAttested: false,
    approvedSource: { repository: options.sourceRepository, commit: options.sourceCommit },
    declaredBackendSource: { repository: NEWSLETTER_BACKEND_PACKAGING_SOURCE.repository, commit: options.backendSourceCommit },
    backendSourceIndependentlyVerified: false, manifestSha256: options.manifestSha256,
    runtimeTarget: pinsFor(options).runtimeTarget, artifact, counts,
    permissionHandling: { regularFileMode: '0644 | observed source execute bits (0111)',
      privilegedBitsPreserved: false, manifestAuthenticatesPermissions: false, runtimePermissionsCompatibilityVerified: false },
    assemblyHost: { node: process.version, platform: process.platform, architecture: process.arch },
    outputDir: options.outputDir, receiptPath: options.outputDir + '/build-receipt.json',
    atomicDirectoryPublishPerformed: builtinFilesystem, durableFilesAndDirectorySyncPerformed: builtinFilesystem,
    buildUsedSourceVerified: false, nativeRuntimeCompatibilityVerified: false,
    runtimeDependencyClosureVerified: false, localServingVerified: false,
    uiAcceptanceVerified: false, shippingAuthorized: false };
}
/** Copy already-built declared bytes, never execute them. Test identity ports
 * require a fixture label and retain the canonical owner's false admission.
 * Exclusive locks coordinate this builder; hostile filesystem races are outside
 * the same bounded static filesystem model as the canonical reader. */
export async function assembleNewsletterReleaseArtifact(input, { io = fs, newsletterIdentity, fixtureLabel, sourceAdmissionFixture } = {}) {
  const options = optionsContract(input);
  const sourceAdmission = assertAcceptedNewsletterArtifactSource(pinsFor(options), { sourceAdmissionFixture });
  if (process.versions.node.split('.')[0] !== '24' || process.platform !== 'linux') refuse('assembly host requires Linux/Node24');
  const customPort = newsletterIdentity !== undefined || io !== fs;
  if ((newsletterIdentity !== undefined && typeof newsletterIdentity !== 'function')
      || (customPort && (typeof fixtureLabel !== 'string' || !/^[A-Za-z0-9 ._-]{1,80}$/.test(fixtureLabel)))
      || (!customPort && fixtureLabel !== undefined)) refuse('explicit labelled synthetic identity/filesystem port');
  await directory(io, path.dirname(options.manifestPath));
  const manifestBytes = await regularBuffer(io, options.manifestPath, NEWSLETTER_FRONTEND_ARTIFACT_PROFILE.maxManifestBytes);
  const pins = pinsFor(options);
  // Full canonical declaration grammar is checked before any root inventory/content read.
  const manifest = inspectFrontendStandaloneManifest({ manifestBytes, pins });
  const entries = new Map(manifest.entries.map(entry => [entry.path, entry]));
  const totalBytes = manifest.entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.bytes : 0), 0);
  if (entries.size > NEWSLETTER_FRONTEND_ARTIFACT_PROFILE.maxEntries
      || totalBytes > NEWSLETTER_FRONTEND_ARTIFACT_PROFILE.maxTotalBytes
      || manifest.entries.some(entry => entry.type === 'file' && entry.bytes > NEWSLETTER_FRONTEND_ARTIFACT_PROFILE.maxFileBytes))
    refuse('artifact resource budget');
  const files = new Map(), symlinks = new Map(), fileModes = new Map();
  async function walk(root, prefix) {
    await directory(io, root);
    const names = await io.readdir(root);
    if (!Array.isArray(names) || new Set(names).size !== names.length) refuse('ambiguous input directory');
    for (const name of names) {
      if (!literal(name) || name.includes('/') || ['.', '..'].includes(name)) refuse('nonliteral input name');
      const local = root + '/' + name, target = prefix + name, stat = await io.lstat(local);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (![...entries.keys()].some(item => item.startsWith(target + '/'))) refuse('unlisted input directory');
        await walk(local, target + '/');
      } else {
        const entry = entries.get(target);
        if (!entry) refuse('unlisted input entry');
        if (stat.isSymbolicLink()) {
          if (entry.type !== 'symlink') refuse('input type drift');
          const link = await io.readlink(local);
          if (link !== entry.target || files.has(target) || (symlinks.has(target) && symlinks.get(target) !== link)) refuse('conflicting input link');
          symlinks.set(target, link);
        } else {
          if (!stat.isFile() || entry.type !== 'file' || symlinks.has(target)) refuse('input type drift');
          const bytes = await regularBuffer(io, local, Math.min(entry.bytes, NEWSLETTER_FRONTEND_ARTIFACT_PROFILE.maxFileBytes));
          if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256 || (files.has(target) && !files.get(target).equals(bytes)))
            refuse('input byte identity/conflicting overlay');
          const mode = 0o644 | (stat.mode & 0o111);
          if (fileModes.has(target) && fileModes.get(target) !== mode) refuse('conflicting input executable modes');
          fileModes.set(target, mode); files.set(target, bytes);
        }
      }
    }
  }
  await walk(options.standaloneDir, '');
  await walk(options.publicDir, 'apps/web/public/');
  await walk(options.staticDir, 'apps/web/.next/static/');
  const artifact = await validateFrontendStandaloneArtifact({ manifestBytes, files, symlinks, pins, newsletterIdentity });
  const counts = { regularFiles: files.size, symlinks: symlinks.size, bytes: totalBytes,
    fileModes: [...fileModes].sort(([a], [b]) => a.localeCompare(b)).map(([name, mode]) => ({ path: name, mode: mode.toString(8) })) };
  const parent = path.dirname(options.outputDir), lockPath = options.outputDir + '.newsletter-assembly.lock';
  await directory(io, parent); await absent(io, options.outputDir);
  let lock, temporary, published = false;
  try {
    lock = await io.open(lockPath, 'wx', 0o600);
    await lock.writeFile(options.manifestSha256 + '\n'); await lock.sync();
    await absent(io, options.outputDir);
    temporary = await io.mkdtemp(parent + '/.newsletter-assembly-');
    const rootfs = temporary + '/rootfs'; await io.mkdir(rootfs);
    const dirs = new Set([rootfs]);
    for (const entry of manifest.entries) {
      for (let folder = path.posix.dirname(entry.path); folder !== '.'; folder = path.posix.dirname(folder)) dirs.add(rootfs + '/' + folder);
    }
    for (const folder of [...dirs].sort((a, b) => a.length - b.length)) if (folder !== rootfs) await io.mkdir(folder);
    for (const [name, bytes] of files) await writeBuffer(io, rootfs + '/' + name, bytes, fileModes.get(name));
    for (const [name, target] of symlinks) await io.symlink(target, rootfs + '/' + name);
    await writeBuffer(io, temporary + '/manifest.json', manifestBytes);
    const revalidated = await readFrontendStandaloneArtifact({ artifactDir: temporary, pins, newsletterIdentity,
      ports: { lstat: value => io.lstat(value), readdir: value => io.readdir(value), realpath: value => io.realpath(value),
        readlink: value => io.readlink(value), readFile: value => regularBuffer(io, value, NEWSLETTER_FRONTEND_ARTIFACT_PROFILE.maxFileBytes) } });
    if (revalidated.artifactEntriesSha256 !== artifact.artifactEntriesSha256 || revalidated.actualArtifactBytesVerified !== artifact.actualArtifactBytesVerified)
      refuse('assembled output validation drift');
    const receipt = receiptFor(options, revalidated, counts, fixtureLabel, io === fs, sourceAdmission);
    await writeBuffer(io, temporary + '/build-receipt.json', Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
    for (const folder of [...dirs].sort((a, b) => b.length - a.length)) await syncDirectory(io, folder);
    await syncDirectory(io, temporary);
    await absent(io, options.outputDir);
    await io.rename(temporary, options.outputDir); published = true; temporary = undefined;
    await syncDirectory(io, parent);
    return Object.freeze(receipt);
  } catch (error) {
    if (temporary) await io.rm(temporary, { recursive: true, force: true });
    if (published) await io.rm(options.outputDir, { recursive: true, force: true });
    throw error;
  } finally {
    if (lock) { await lock.close(); await io.unlink(lockPath); }
  }
}
export const NEWSLETTER_BUILD_USAGE = 'Usage: build-newsletter-release.sh --node-bin /absolute/node --plan|--run --standalone-dir ABS --public-dir ABS --static-dir ABS --manifest ABS --manifest-sha256 SHA256 --source-repository neo-capiro/capiro-frontend --source-commit ACTIVE_ACCEPTED_FRONTEND_SHA --target-platform linux/amd64|linux/arm64 --target-libc musl --target-node-major 24 --backend-source-commit SHA --output-dir ABS';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const invocation = parseNewsletterBuildInvocation(process.argv.slice(2));
    if (invocation.mode === 'help') console.log(NEWSLETTER_BUILD_USAGE);
    else if (invocation.mode === 'plan') console.log(JSON.stringify(createNewsletterArtifactPackagingPlan(invocation.options), null, 2));
    else console.log(JSON.stringify(await assembleNewsletterReleaseArtifact(invocation.options), null, 2));
  } catch (error) { console.error(JSON.stringify({ status: 'FAIL', assemblyCompleted: false, shippingAuthorized: false, usage: NEWSLETTER_BUILD_USAGE, error: String(error.message).slice(0, 300) })); process.exitCode = 2; }
}
