/**
 * @cleanup-smoke noArgsExit=2 helpExit=0
 *
 * Legacy Web (port 8080) artifact assembly from the already-qualified frontend
 * image. This operator is pure Node: it never runs docker, never compiles the
 * frontend, never builds or pushes an image and never calls AWS. The image pull
 * and the `/app` extraction are performed by the calling build step with an
 * explicit immutable digest; this operator only:
 *
 *   1. checks the extracted `apps/web` tree is already the artifact rootfs
 *      layout (and refuses anything else);
 *   2. binds the declared source commit to the reviewed *active* artifact
 *      source in scripts/lib/newsletter-accepted-source-profile.json;
 *   3. inventories the extracted bytes into the manifest the existing byte gate
 *      requires (inspectFrontendStandaloneManifest runs before writing);
 *   4. hands manifest + trees to the existing assembly owner
 *      (assembleNewsletterReleaseArtifact), which admits and publishes
 *      release-artifacts/capiro-frontend/{manifest.json,rootfs/**,build-receipt.json}.
 *
 * Why extraction and not a frontend export build: the qualified primary image
 * `capiro/portfolio-preview@sha256:983eb6d9…` is the accepted, scanned producer
 * for frontend commit ee470d7d (capiro-frontend
 * docs/legacy-web-20261029/SOURCE-PIN-QUALIFICATION.md) and its /app already
 * holds the standalone root with public/ and .next/static inside. Building the
 * frontend again in this path would produce different bytes and would not be
 * the qualified producer.
 *
 * Usage (Linux builder, Node24):
 *   node scripts/legacy-web-release.mjs artifact \
 *     --extracted-app-dir /abs/work/app \
 *     --frontend-commit <40-hex> \
 *     --image-digest sha256:<64-hex> \
 *     --manifest /abs/work/artifact.manifest.json \
 *     --output-dir /abs/work/release-artifacts/capiro-frontend \
 *     --backend-commit <40-hex> \
 *     --arch arm64
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectFrontendStandaloneManifest, inspectFrontendStandalonePath,
  NEWSLETTER_ACCEPTED_SOURCE_PROFILE } from './lib/frontend-standalone-artifact-contract.mjs';
import { assembleNewsletterReleaseArtifact } from './lib/newsletter-artifact-packaging-plan.mjs';

export const LEGACY_WEB_USAGE = 'Usage: node scripts/legacy-web-release.mjs artifact --extracted-app-dir ABS --frontend-commit 40HEX --image-digest sha256:64HEX --manifest ABS --output-dir ABS --backend-commit 40HEX --arch arm64|amd64';
export const LEGACY_WEB_FLAGS = Object.freeze(['--extracted-app-dir', '--frontend-commit', '--image-digest',
  '--manifest', '--output-dir', '--backend-commit', '--arch']);
export const LEGACY_WEB_APP_LAYOUT = Object.freeze({
  requiredFiles: Object.freeze(['apps/web/server.js', 'apps/web/.next/BUILD_ID',
    'apps/web/.next/required-server-files.json']),
  requiredDirectories: Object.freeze(['apps/web/.next/static', 'apps/web/public/newsletter']),
});
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
    extractedAppDir: absolute(values.get('--extracted-app-dir')),
    frontendCommit: values.get('--frontend-commit'),
    imageDigest: values.get('--image-digest'),
    manifestPath: absolute(values.get('--manifest')),
    outputDir: absolute(values.get('--output-dir')),
    backendCommit: values.get('--backend-commit'),
    arch: values.get('--arch'),
  });
  if (!/^[a-f0-9]{40}$/.test(options.frontendCommit) || !/^[a-f0-9]{40}$/.test(options.backendCommit))
    refuse('40-hex frontend and backend commits required');
  if (!/^sha256:[a-f0-9]{64}$/.test(options.imageDigest)) refuse('immutable image digest required');
  if (!['arm64', 'amd64'].includes(options.arch)) refuse('explicit linux arm64 or amd64 target required');
  if (!NEWSLETTER_ACCEPTED_SOURCE_PROFILE.runtimeProfile.architectures.includes(options.arch))
    refuse('target architecture outside the reviewed runtime profile');
  if (options.outputDir === options.extractedAppDir || options.outputDir.startsWith(options.extractedAppDir + '/') ||
      options.extractedAppDir.startsWith(options.outputDir + '/'))
    refuse('artifact output overlaps the extracted image tree');
  if (options.manifestPath === options.extractedAppDir || options.manifestPath.startsWith(options.extractedAppDir + '/'))
    refuse('manifest must live outside the extracted image tree');
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
async function statOrNull(value) {
  try { return await fs.lstat(value); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
/** The extracted image tree must already be the artifact rootfs layout. */
export async function assertExtractedAppLayout(appDir) {
  await requireDirectory(appDir);
  for (const file of LEGACY_WEB_APP_LAYOUT.requiredFiles) {
    const stat = await statOrNull(appDir + '/' + file);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size === 0)
      refuse('missing extracted layout file: ' + file);
  }
  for (const directory of LEGACY_WEB_APP_LAYOUT.requiredDirectories) {
    const stat = await statOrNull(appDir + '/' + directory);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink())
      refuse('missing extracted layout directory: ' + directory);
  }
  const staticEntries = await countFiles(appDir + '/apps/web/.next/static');
  if (staticEntries === 0) refuse('empty extracted Next static output');
  const newsletterEntries = await countFiles(appDir + '/apps/web/public/newsletter');
  if (newsletterEntries === 0) refuse('empty extracted Newsletter public assets');
  return Object.freeze({ requiredFiles: LEGACY_WEB_APP_LAYOUT.requiredFiles.length,
    staticEntries, newsletterEntries });
}
/** Count regular files below a directory (bounded, no symlink following). */
async function countFiles(root, depth = 0) {
  if (depth > 8) refuse('extracted layout nesting budget');
  let count = 0;
  for (const name of await fs.readdir(root)) {
    const stat = await fs.lstat(root + '/' + name);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) count += await countFiles(root + '/' + name, depth + 1);
    else if (stat.isFile()) count++;
  }
  return count;
}
/** Exhaustive inventory of the extracted tree as rootfs-relative entries. */
export async function inventoryExtractedApp({ appDir }) {
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
      } else refuse('nonregular extracted entry');
      const previous = entries.get(relative);
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) refuse('conflicting extracted overlays');
      if (!previous) entries.set(relative, entry);
      if (entries.size > MAX_ENTRIES) refuse('extracted inventory budget');
    }
  }
  // The image's /app already contains public/ and .next/static inside the
  // standalone root, so the three declared inputs hold the same bytes; the
  // assembly owner revalidates them as exhaustive overlays.
  await walk(appDir, '');
  await walk(appDir + '/apps/web/public', 'apps/web/public/');
  await walk(appDir + '/apps/web/.next/static', 'apps/web/.next/static/');
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
/**
 * The declared artifact source must be the reviewed *active* source. This is the
 * binding between the selected source and the producer path: the commit the
 * image was built from is the commit the gate admits.
 */
export function assertActiveSourceCommit(frontendCommit) {
  const active = NEWSLETTER_ACCEPTED_SOURCE_PROFILE.activeCommit;
  if (!active) refuse('no reviewed active artifact source is selected');
  if (frontendCommit !== active) refuse(`declared source ${frontendCommit} is not the active accepted source ${active}`);
  return active;
}
export async function runLegacyWebArtifact(options) {
  // The existing assembly owner only publishes on the reviewed Linux/Node24 host.
  if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '24')
    refuse('legacy Web artifact assembly requires Linux/Node24');
  assertActiveSourceCommit(options.frontendCommit);
  const layout = await assertExtractedAppLayout(options.extractedAppDir);
  for (const absent of [options.manifestPath, options.outputDir]) {
    try { await fs.lstat(absent); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    refuse('immutable input/output already exists');
  }
  await fs.mkdir(path.dirname(options.manifestPath), { recursive: true });
  await fs.mkdir(path.dirname(options.outputDir), { recursive: true });
  const entries = await inventoryExtractedApp({ appDir: options.extractedAppDir });
  const { bytes, manifestSha256 } = manifestBytesFor({ entries, sourceCommit: options.frontendCommit, arch: options.arch });
  await fs.writeFile(options.manifestPath, bytes, { flag: 'wx' });
  const receipt = await assembleNewsletterReleaseArtifact({
    standaloneDir: options.extractedAppDir, publicDir: options.extractedAppDir + '/apps/web/public',
    staticDir: options.extractedAppDir + '/apps/web/.next/static', manifestPath: options.manifestPath, manifestSha256,
    sourceRepository: SOURCE_REPOSITORY, sourceCommit: options.frontendCommit,
    targetPlatform: 'linux/' + options.arch, targetLibc: 'musl', targetNodeMajor: '24',
    backendSourceCommit: options.backendCommit, outputDir: options.outputDir,
  });
  return Object.freeze({ status: receipt.status, manifestSha256, outputDir: options.outputDir,
    receiptPath: options.outputDir + '/build-receipt.json', counts: receipt.counts, layout,
    extractionBinding: Object.freeze({ imageDigest: options.imageDigest, frontendCommit: options.frontendCommit,
      activeAcceptedSource: NEWSLETTER_ACCEPTED_SOURCE_PROFILE.activeCommit, arch: options.arch }),
    sourcePinVerified: true, imageExtractionPerformedByCaller: true,
    imageBuildPerformed: false, frontendCompilationPerformed: false,
    consumerBuildArgs: Object.freeze({ FRONTEND_ARTIFACT_MANIFEST_SHA256: manifestSha256,
      FRONTEND_ARTIFACT_SOURCE_REPOSITORY: SOURCE_REPOSITORY,
      FRONTEND_ARTIFACT_SOURCE_COMMIT: options.frontendCommit, TARGETPLATFORM: 'linux/' + options.arch }) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const invocation = parseLegacyWebInvocation(process.argv.slice(2));
    if (invocation.mode === 'help') console.log(LEGACY_WEB_USAGE);
    else console.log(JSON.stringify(await runLegacyWebArtifact(invocation.options), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'FAIL', artifactAssemblyPerformed: false,
      imageBuildPerformed: false, frontendCompilationPerformed: false, shippingAuthorized: false,
      usage: LEGACY_WEB_USAGE, error: String(error.message).slice(0, 300) }));
    process.exitCode = 2;
  }
}
