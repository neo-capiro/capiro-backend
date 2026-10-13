import { createHash } from 'node:crypto';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { types as utilTypes } from 'node:util';
import acceptedSourceProfile from './newsletter-accepted-source-profile.json' with { type: 'json' };
import { canonicalNewsletterManifest, qualifyNewsletterArtifact } from './newsletter-static-release-contract.mjs';

// Supplied runtime bytes only. Import never reads files/env or starts a server.
export const FRONTEND_ARTIFACT_TYPE = 'capiro-frontend-next-standalone';
export const FRONTEND_SERVER_ENTRYPOINT = 'apps/web/server.js';
const app = 'apps/web/';
const fail = (message) => { throw new Error(`Frontend standalone artifact refused: ${message}`); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function literal(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\u0000-\u001f\u007f\\]/.test(value);
}
function sourcePins(pins) {
  if (!pins || !literal(pins.sourceRepository) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pins.sourceRepository) ||
      !literal(pins.sourceCommit) || pins.sourceCommit.length !== 40 || !/^[a-f0-9]{40}$/.test(pins.sourceCommit) ||
      !literal(pins.manifestSha256) || pins.manifestSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(pins.manifestSha256))
    fail('explicit source repository/commit and manifest SHA256 required');
  runtimeTarget(pins.runtimeTarget);
}
function runtimeTarget(target) {
  if (!exactKeys(target, ['os', 'arch', 'libc', 'nodeMajor']) || target.os !== 'linux' ||
      !['amd64', 'arm64'].includes(target.arch) || !['glibc', 'musl'].includes(target.libc) || target.nodeMajor !== 24)
    fail('explicit Linux architecture/libc/Node24 runtime target required');
}
function safePath(path) {
  if (!literal(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..' ||
        /^\.env(?:[._-]|$)/i.test(part) || /^(?:\.envrc|\.git|\.ssh|\.aws|\.azure|\.gnupg|\.npmrc|\.yarnrc(?:\.yml)?|\.netrc|\.pypirc|credentials(?:\.json)?|service[-_]account(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|kubeconfig)$/i.test(part) ||
        /\.(?:pem|key|p12|pfx)$/i.test(part))) fail('unsafe or credential artifact path');
  return path;
}
function internalTarget(path, target) {
  if (!literal(target) || target.startsWith('/') || /^[A-Za-z]:/.test(target)) fail('unsafe symlink/reference target');
  // POSIX resolves intermediate symlinks before '..'. Lexical cancellation of
  // a named component can therefore hide an escape. Permit leading parents
  // from the indexed, unsymlinked containing directory, then only descendants.
  let namedComponent = false;
  for (const part of target.split('/')) {
    if (part === '..' && namedComponent) fail('parent segment after named symlink/reference component');
    if (part !== '' && part !== '.' && part !== '..') namedComponent = true;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) fail('escaping symlink/reference target');
  if (resolved !== '.') safePath(resolved);
  return resolved === '.' ? '' : resolved;
}
function parseJson(bytes, label) {
  if (!Buffer.isBuffer(bytes)) fail(`${label} bytes required`);
  let value;
  const text = bytes.toString('utf8');
  try { value = JSON.parse(text); } catch { fail(`malformed ${label}`); }
  // Refuse duplicate object keys rather than accept JSON.parse's last value.
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') stack.push(text[i] === '{' ? new Set() : null);
    else if (text[i] === '}' || text[i] === ']') stack.pop();
    else if (text[i] === '"') {
      const start = i++;
      for (; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      const key = JSON.parse(text.slice(start, i + 1));
      if (/^\s*:/.test(text.slice(i + 1)) && stack.at(-1)) {
        if (stack.at(-1).has(key)) fail(`duplicate ${label} key`);
        stack.at(-1).add(key);
      }
    }
  }
  return value;
}
function manifestContract(manifestBytes, pins) {
  sourcePins(pins);
  if (!Buffer.isBuffer(manifestBytes) || sha(manifestBytes) !== pins.manifestSha256) fail('manifest byte identity');
  const manifest = parseJson(manifestBytes, 'artifact manifest');
  if (!exactKeys(manifest, ['schemaVersion', 'artifactType', 'source', 'runtimeTarget', 'serverEntrypoint', 'entries']) ||
      manifest.schemaVersion !== 1 || manifest.artifactType !== FRONTEND_ARTIFACT_TYPE ||
      !exactKeys(manifest.source, ['repository', 'commit']) || manifest.source.repository !== pins.sourceRepository ||
      manifest.source.commit !== pins.sourceCommit || manifest.serverEntrypoint !== FRONTEND_SERVER_ENTRYPOINT ||
      !Array.isArray(manifest.entries) || manifest.entries.length === 0) fail('manifest layout/source-pin equality');
  runtimeTarget(manifest.runtimeTarget);
  if (Object.keys(manifest.runtimeTarget).some((key) => manifest.runtimeTarget[key] !== pins.runtimeTarget[key])) fail('runtime target equality');
  const index = new Map(), directories = new Set(['']);
  for (const entry of manifest.entries) {
    if (!entry || !['file', 'symlink'].includes(entry.type)) fail('artifact entry type');
    safePath(entry.path);
    if (index.has(entry.path)) fail('duplicate artifact path');
    if (entry.type === 'file') {
      if (!exactKeys(entry, ['path', 'type', 'bytes', 'sha256']) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
          !literal(entry.sha256) || entry.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail('malformed file identity');
    } else {
      if (!exactKeys(entry, ['path', 'type', 'target'])) fail('malformed symlink');
      internalTarget(entry.path, entry.target);
    }
    index.set(entry.path, entry);
    for (let directory = posix.dirname(entry.path); directory !== '.'; directory = posix.dirname(directory)) directories.add(directory);
  }
  for (const path of index.keys()) {
    for (let directory = posix.dirname(path); directory !== '.'; directory = posix.dirname(directory))
      if (index.has(directory)) fail('indexed entry used as ancestor');
  }
  const dereference = (path, allowDirectory = false) => {
    safePath(path);
    const seen = new Set();
    for (let depth = 0; depth <= index.size; depth++) {
      if (seen.has(path)) fail('cyclic internal symlink');
      seen.add(path);
      const parts = path.split('/');
      let redirected = false;
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/'), link = index.get(prefix);
        if (link?.type !== 'symlink') continue;
        path = posix.join(internalTarget(prefix, link.target), ...parts.slice(i));
        if (path !== '.') safePath(path);
        else path = '';
        redirected = true; break;
      }
      if (redirected) continue;
      if (index.get(path)?.type === 'file' || (allowDirectory && directories.has(path))) return path;
      fail('missing declared file/symlink target');
    }
    fail('internal symlink depth');
  };
  for (const entry of index.values()) if (entry.type === 'symlink') {
    const target = internalTarget(entry.path, entry.target);
    if (target) dereference(target, true);
  }
  for (const path of [FRONTEND_SERVER_ENTRYPOINT, app + '.next/BUILD_ID', app + '.next/required-server-files.json'])
    if (index.get(path)?.type !== 'file' || index.get(path).bytes === 0) fail(`required regular server file: ${path}`);
  if (![...index.values()].some((entry) => entry.type === 'file' && entry.path.startsWith(app + '.next/static/') && entry.bytes > 0))
    fail('required Next static output');
  for (const entry of canonicalNewsletterManifest())
    if (index.get(app + 'public' + entry.publicPath)?.type !== 'file') fail('required Newsletter public asset');
  return { manifest, index, directories, dereference };
}

/** Canonical relative path grammar only; no I/O or normalization. */
export function inspectFrontendStandalonePath(value) {
  return safePath(value);
}

/** Canonical declaration grammar only; no I/O or byte/runtime admission. */
export function inspectFrontendStandaloneManifest({ manifestBytes, pins }) {
  return manifestContract(manifestBytes, pins).manifest;
}

function policyData(value, keys, label) {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`source policy ${label}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string') ||
      Object.keys(descriptors).sort().join(',') !== [...keys].sort().join(',') ||
      Object.values(descriptors).some(item => !Object.hasOwn(item, 'value'))) fail(`source policy ${label}`);
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function policyArray(value, label, maximum) {
  if (!value || utilTypes.isProxy(value) || !Array.isArray(value) || value.length > maximum)
    fail(`source policy ${label}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = ['length', ...Array.from({ length: value.length }, (_, index) => String(index))];
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string') ||
      Object.keys(descriptors).sort().join(',') !== expected.sort().join(',') ||
      Object.values(descriptors).some(item => !Object.hasOwn(item, 'value'))) fail(`source policy ${label}`);
  return Array.from({ length: value.length }, (_, index) => descriptors[index].value);
}
function sourcePolicy(value) {
  const policy = policyData(value, ['schemaVersion', 'repository', 'activeCommit', 'acceptedSources', 'runtimeProfile'], 'layout');
  if (policy.schemaVersion !== 1 || policy.repository !== 'neo-capiro/capiro-frontend') fail('source policy owner/version');
  const runtime = policyData(policy.runtimeProfile, ['os', 'architectures', 'libc', 'nodeMajor', 'nodeVersion', 'nodeImage'], 'runtime');
  const architectures = policyArray(runtime.architectures, 'architectures', 2);
  if (runtime.os !== 'linux' || architectures.join(',') !== 'amd64,arm64' || runtime.libc !== 'musl' ||
      runtime.nodeMajor !== 24 || runtime.nodeVersion !== '24.21.0' ||
      runtime.nodeImage !== 'node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2')
    fail('source policy pinned runtime');
  const sha40 = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  const commits = new Set();
  const accepted = policyArray(policy.acceptedSources, 'accepted sources', 16).map(value => {
    const source = policyData(value, ['commit', 'tree', 'qualificationReceipt'], 'accepted entry');
    const receipt = policyData(source.qualificationReceipt, ['repository', 'commit', 'path', 'sha256'], 'qualification receipt');
    if (!sha40(source.commit) || !sha40(source.tree) || commits.has(source.commit) ||
        receipt.repository !== policy.repository || !sha40(receipt.commit) ||
        !literal(receipt.sha256) || !/^[a-f0-9]{64}$/.test(receipt.sha256)) fail('source policy acceptance identity');
    safePath(receipt.path);
    if (!receipt.path.startsWith('docs/')) fail('source policy qualification receipt path');
    commits.add(source.commit);
    return Object.freeze({ ...source, qualificationReceipt: Object.freeze(receipt) });
  });
  if (policy.activeCommit !== null && (!sha40(policy.activeCommit) || !commits.has(policy.activeCommit)))
    fail('source policy active accepted entry');
  return Object.freeze({ ...policy, acceptedSources: Object.freeze(accepted),
    runtimeProfile: Object.freeze({ ...runtime, architectures: Object.freeze(architectures) }) });
}

/** Reviewed repository data, never a caller-selected file, environment or remote branch. */
export const NEWSLETTER_ACCEPTED_SOURCE_PROFILE = sourcePolicy(acceptedSourceProfile);
function admissionPolicy(sourceAdmissionFixture) {
  if (sourceAdmissionFixture === undefined) return { policy: NEWSLETTER_ACCEPTED_SOURCE_PROFILE, synthetic: false };
  const fixture = policyData(sourceAdmissionFixture, ['kind', 'label', 'profile'], 'fixture port');
  if (fixture.kind !== 'newsletter-source-admission-fixture' || typeof fixture.label !== 'string' ||
      !/^[A-Za-z0-9 ._-]{1,80}$/.test(fixture.label)) fail('explicit labelled source-admission fixture');
  return { policy: sourcePolicy(fixture.profile), synthetic: true };
}
/** A matched reviewed policy is separate from source-build, ABI or receipt-byte proof. */
export function inspectNewsletterSourceAdmission(pins, { sourceAdmissionFixture } = {}) {
  sourcePins(pins);
  const { policy, synthetic } = admissionPolicy(sourceAdmissionFixture);
  const active = policy.acceptedSources.find(entry => entry.commit === policy.activeCommit);
  const allowed = Boolean(active && pins.sourceRepository === policy.repository && pins.sourceCommit === active.commit &&
    pins.runtimeTarget.os === policy.runtimeProfile.os && policy.runtimeProfile.architectures.includes(pins.runtimeTarget.arch) &&
    pins.runtimeTarget.libc === policy.runtimeProfile.libc && pins.runtimeTarget.nodeMajor === policy.runtimeProfile.nodeMajor);
  return Object.freeze({ status: allowed ? (synthetic ? 'fixture-accepted' : 'accepted') : (active ? 'refused' : 'pending'),
    assemblyAdmissionAllowed: allowed, syntheticSourceApprovalModel: synthetic,
    sourceAcceptedByReviewedPolicy: allowed && !synthetic, sourceApprovalProofVerified: false,
    independentFrontendQualificationVerified: false, buildUsedSourceVerified: false, nativeRuntimeCompatibilityVerified: false,
    activeSource: active ? Object.freeze({ repository: policy.repository, ...active }) : null,
    requiredRuntimeProfile: policy.runtimeProfile });
}
export function assertAcceptedNewsletterArtifactSource(pins, fixtureOptions) {
  const admission = inspectNewsletterSourceAdmission(pins, fixtureOptions);
  if (!admission.assemblyAdmissionAllowed) fail(admission.status === 'pending'
    ? 'final accepted frontend source and qualified receipt pin required' : 'active accepted frontend source/runtime mismatch');
  return admission;
}
/** Shipping entrypoint: refuse admission before every artifact filesystem port. */
export async function readAcceptedFrontendStandaloneArtifact({ sourceAdmissionFixture, ...input }) {
  const sourceAdmission = assertAcceptedNewsletterArtifactSource(input.pins, { sourceAdmissionFixture });
  const artifact = await readFrontendStandaloneArtifact(input);
  return Object.freeze({ ...artifact, sourceAdmission });
}

/** All regular buffers and all symlinks must be exhaustively provided. A custom
 * Newsletter identity port is an inert model and can never produce a byte receipt.
 * Source equality is not proof that this was the tree used by a Next build.
 */
export async function validateFrontendStandaloneArtifact({ manifestBytes, files, symlinks = new Map(), pins, newsletterIdentity }) {
  const { manifest, index, dereference } = manifestContract(manifestBytes, pins);
  if (!(files instanceof Map) || !(symlinks instanceof Map)) fail('exhaustive file/symlink Maps required');
  for (const [map, type] of [[files, 'file'], [symlinks, 'symlink']]) {
    for (const path of map.keys()) { safePath(path); if (index.get(path)?.type !== type) fail('unlisted or wrong-type artifact entry'); }
  }
  if (files.size + symlinks.size !== index.size) fail('missing artifact entries');
  for (const entry of index.values()) {
    if (entry.type === 'symlink') {
      if (symlinks.get(entry.path) !== entry.target) fail('symlink identity drift');
    } else {
      const bytes = files.get(entry.path);
      if (!Buffer.isBuffer(bytes) || bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) fail('file byte identity drift');
    }
  }
  const required = parseJson(files.get(app + '.next/required-server-files.json'), 'required-server-files');
  if (!required || !Array.isArray(required.files) || required.files.length === 0 ||
      required.config?.output !== 'standalone' ||
      (required.config.distDir !== undefined && required.config.distDir !== '.next') ||
      (required.relativeAppDir !== undefined && required.relativeAppDir !== 'apps/web')) fail('required-server-files layout');
  for (const file of required.files) dereference(internalTarget(app + 'server.js', file));
  let traceManifestsVerified = 0, traceFileReferencesVerified = 0;
  for (const entry of index.values()) if (entry.path.endsWith('.nft.json')) {
    if (entry.type !== 'file') fail('Next trace manifest must be regular');
    const trace = parseJson(files.get(entry.path), 'Next trace');
    if (!trace || !Array.isArray(trace.files)) fail('Next trace file list');
    // Next traces can name directory symlinks. Only directories inferred from
    // nonempty indexed descendants qualify; exhaustive entry identities above
    // cover their contents. Required-server-files remains file-only.
    for (const file of trace.files) { dereference(internalTarget(entry.path, file), true); traceFileReferencesVerified++; }
    traceManifestsVerified++;
  }
  const newsletter = await qualifyNewsletterArtifact({ manifest: canonicalNewsletterManifest(),
    assets: new Map([...files].filter(([path]) => path.startsWith(app + 'public/newsletter/'))
      .map(([path, bytes]) => [path.slice((app + 'public').length), bytes])),
    artifactSource: manifest.source, ...(newsletterIdentity ? { identity: newsletterIdentity } : {}) });
  return Object.freeze({ schemaVersion: 1, artifactType: FRONTEND_ARTIFACT_TYPE,
    source: Object.freeze({ ...manifest.source }), manifestSha256: pins.manifestSha256,
    runtimeTarget: Object.freeze({ ...manifest.runtimeTarget }), runtimeTargetEqualityVerified: true,
    nativeRuntimeCompatibilityVerified: false,
    serverEntrypoint: FRONTEND_SERVER_ENTRYPOINT, artifactEntriesSha256: sha(Buffer.from(JSON.stringify(manifest.entries))),
    regularFiles: files.size, symlinks: symlinks.size, exhaustiveArtifactIndexVerified: true,
    safeInternalSymlinksVerified: true, requiredServerFileClosureVerified: true,
    traceManifestsVerified, traceFileReferencesVerified, newsletter,
    actualArtifactBytesVerified: newsletter.actualArtifactBytesVerified, sourcePinEqualityVerified: true,
    buildUsedSourceVerified: false, runtimeDependencyClosureVerified: false,
    localServingVerified: false, deployedServingVerified: false, uiAcceptanceVerified: false });
}

function artifactDirectory(path) {
  if (!literal(path) || !path.startsWith('/') || posix.normalize(path) !== path || path === '/') fail('canonical absolute artifact directory');
  safePath(path.slice(1));
  return path;
}
/** No default filesystem ports. First reject the entire manifest and inventory;
 * never follow inventory symlinks, and check regular-file realpaths before reads.
 */
export async function readFrontendStandaloneArtifact({ artifactDir, pins, ports, newsletterIdentity }) {
  sourcePins(pins); artifactDirectory(artifactDir);
  if (!ports || ['lstat', 'readdir', 'readFile', 'readlink', 'realpath'].some((key) => typeof ports[key] !== 'function')) fail('explicit filesystem ports');
  const directory = async (path) => {
    const stat = await ports.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('nonregular artifact ancestor');
  };
  const parts = artifactDir.split('/').filter(Boolean);
  await directory('/');
  for (let i = 1; i <= parts.length; i++) await directory('/' + parts.slice(0, i).join('/'));
  if (await ports.realpath(artifactDir) !== artifactDir) fail('artifact ancestor realpath');
  const manifestPath = artifactDir + '/manifest.json', rootfs = artifactDir + '/rootfs';
  const stat = await ports.lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || await ports.realpath(manifestPath) !== manifestPath) fail('nonregular manifest file');
  const manifestBytes = await ports.readFile(manifestPath);
  const contract = manifestContract(manifestBytes, pins);
  await directory(rootfs);
  if (await ports.realpath(rootfs) !== rootfs) fail('rootfs realpath');
  const observed = new Map();
  const enumerate = async (directoryPath, prefix = '') => {
    const names = await ports.readdir(directoryPath);
    if (!Array.isArray(names) || new Set(names).size !== names.length) fail('ambiguous artifact directory');
    for (const name of names) {
      if (typeof name !== 'string' || name.includes('/')) fail('nonliteral directory entry');
      const path = safePath(prefix + name), absolute = rootfs + '/' + path, entryStat = await ports.lstat(absolute);
      if (entryStat.isSymbolicLink()) {
        const target = await ports.readlink(absolute); internalTarget(path, target);
        observed.set(path, { type: 'symlink', target });
      } else if (entryStat.isDirectory()) {
        if (await ports.realpath(absolute) !== absolute) fail('directory realpath escape');
        await enumerate(absolute, path + '/');
      } else if (entryStat.isFile()) observed.set(path, { type: 'file' });
      else fail('nonregular artifact entry');
    }
  };
  await enumerate(rootfs);
  if (observed.size !== contract.index.size) fail('exhaustive artifact inventory mismatch');
  for (const [path, observedEntry] of observed) {
    const expected = contract.index.get(path);
    if (!expected || observedEntry.type !== expected.type ||
        (expected.type === 'symlink' && observedEntry.target !== expected.target)) fail('unlisted/type/symlink inventory drift');
  }
  const files = new Map(), symlinks = new Map();
  for (const entry of contract.index.values()) {
    if (entry.type === 'symlink') symlinks.set(entry.path, entry.target);
    else {
      const path = rootfs + '/' + entry.path;
      if (await ports.realpath(path) !== path) fail('regular file realpath escape');
      files.set(entry.path, await ports.readFile(path));
    }
  }
  return validateFrontendStandaloneArtifact({ manifestBytes, files, symlinks, pins, newsletterIdentity });
}
export function parseFrontendStandaloneInvocation(args) {
  const flags = ['--artifact-dir', '--manifest-sha256', '--source-repository', '--source-commit',
    '--target-platform', '--target-libc', '--target-node-major'];
  if (!Array.isArray(args) || args.length !== 14) fail('seven explicit artifact/source/runtime flags required');
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!flags.includes(args[i]) || values.has(args[i]) || !literal(args[i + 1])) fail('unknown/duplicate/missing artifact flag');
    values.set(args[i], args[i + 1]);
  }
  const platform = values.get('--target-platform');
  if (!['linux/amd64', 'linux/arm64'].includes(platform) || values.get('--target-node-major') !== '24') fail('runtime target flags');
  const options = { artifactDir: values.get('--artifact-dir'), pins: {
    manifestSha256: values.get('--manifest-sha256'), sourceRepository: values.get('--source-repository'), sourceCommit: values.get('--source-commit'),
    runtimeTarget: { os: 'linux', arch: platform.split('/')[1], libc: values.get('--target-libc'), nodeMajor: 24 } } };
  sourcePins(options.pins); artifactDirectory(options.artifactDir);
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseFrontendStandaloneInvocation(process.argv.slice(2));
    const fs = await import('node:fs/promises'), { constants } = await import('node:fs');
    const receipt = await readAcceptedFrontendStandaloneArtifact({ ...options, ports: {
      lstat: fs.lstat, readdir: fs.readdir, realpath: fs.realpath, readlink: fs.readlink,
      readFile: (path) => fs.readFile(path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW }) } });
    console.log(JSON.stringify(receipt));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
