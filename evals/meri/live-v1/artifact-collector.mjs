import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/u;
const SECRET_KEY = /(?:authorization|cookie|token|secret|password|api[_-]?key|session)/iu;
const SECRET_TEXT = /(?:Bearer\s+)[A-Za-z0-9._~+\/-]+=*|(?:__session|__client_uat|CLERK_SECRET_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*[^\s,;"']+/giu;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Stable(value) {
  return sha256Bytes(stableJson(value));
}

export function redactSecrets(value, secretValues = []) {
  const known = secretValues.filter((item) => typeof item === 'string' && item.length >= 4);
  const redactText = (input) => {
    let text = input.replace(SECRET_TEXT, '[REDACTED]').replace(JWT, '[REDACTED_JWT]');
    for (const secret of known) text = text.split(secret).join('[REDACTED]');
    return text;
  };
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, known));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY.test(key) ? '[REDACTED]' : redactSecrets(item, known),
  ]));
}

function safeRef(root, ref) {
  if (typeof ref !== 'string' || !ref || isAbsolute(ref) || /^[a-z]:[\\/]/iu.test(ref) || ref.startsWith('\\\\') || ref.includes('\0')) {
    throw new Error('artifact ref must be a non-empty relative path');
  }
  if (ref.includes('\\')) throw new Error(`artifact ref must use portable forward slashes: ${ref}`);
  const parts = ref.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`artifact traversal ref refused: ${ref}`);
  const target = resolve(root, ...parts);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error(`artifact ref escapes owned root: ${ref}`);
  return { parts, target };
}

function identity(stats) {
  return `${stats.dev}:${stats.ino}:${stats.mode}:${stats.birthtimeNs}`;
}

function within(root, target) {
  const boundary = relative(root, target);
  return boundary === '' || (!isAbsolute(boundary) && boundary !== '..' && !boundary.startsWith(`..${sep}`));
}

async function assertExistingPathHasNoLinks(path, label) {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    const stats = await lstat(cursor, { bigint: true }).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!stats) throw new Error(`${label} does not exist: ${cursor}`);
    if (stats.isSymbolicLink()) throw new Error(`${label} contains a symlink or reparse link: ${cursor}`);
  }
}

async function inspectRoot(root, expected = null) {
  await assertExistingPathHasNoLinks(root, 'owned root');
  const stats = await lstat(root, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('owned root is not a plain directory');
  await realpath(root);
  const observed = identity(stats);
  if (expected && observed !== expected) throw new Error('owned root identity changed');
  return observed;
}

async function inspectDirectory(root, directory) {
  if (!within(root, directory)) throw new Error('artifact parent escaped owned root');
  await assertExistingPathHasNoLinks(directory, 'artifact parent');
  const stats = await lstat(directory, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('artifact parent is not a plain directory');
  const canonical = await realpath(directory);
  const canonicalRoot = await realpath(root);
  if (!within(canonicalRoot, canonical)) throw new Error('artifact parent canonical path escaped');
  return { path: directory, identity: identity(stats) };
}

async function recheckDirectories(root, snapshots) {
  for (const snapshot of snapshots) {
    const observed = await inspectDirectory(root, snapshot.path);
    if (observed.identity !== snapshot.identity) throw new Error(`artifact directory identity changed: ${snapshot.path}`);
  }
}

async function readOwnedFile(root, rootIdentity, ref) {
  const { parts, target } = safeRef(root, ref);
  await inspectRoot(root, rootIdentity);
  const snapshots = [];
  let cursor = root;
  snapshots.push(await inspectDirectory(root, cursor));
  for (const part of parts.slice(0, -1)) {
    cursor = resolve(cursor, part);
    snapshots.push(await inspectDirectory(root, cursor));
  }
  const targetStats = await lstat(target, { bigint: true });
  if (targetStats.isSymbolicLink() || !targetStats.isFile()) throw new Error(`artifact is not a plain file: ${ref}`);
  if (targetStats.size > BigInt(MAX_ARTIFACT_BYTES)) throw new Error(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes: ${ref}`);
  const canonical = await realpath(target);
  if (!within(await realpath(root), canonical)) throw new Error(`artifact canonical path escaped: ${ref}`);

  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || identity(before) !== identity(targetStats)) throw new Error(`artifact identity changed before read: ${ref}`);
    const bytes = await handle.readFile();
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes while reading: ${ref}`);
    const after = await handle.stat({ bigint: true });
    if (identity(before) !== identity(after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error(`artifact changed while being read: ${ref}`);
    }
    await recheckDirectories(root, snapshots);
    await inspectRoot(root, rootIdentity);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function listFiles(root, rootIdentity, dir = root) {
  await inspectRoot(root, rootIdentity);
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = join(dir, entry.name);
    const stats = await lstat(target, { bigint: true });
    if (stats.isSymbolicLink()) throw new Error(`linked artifact path refused: ${relative(root, target)}`);
    if (stats.isDirectory()) files.push(...await listFiles(root, rootIdentity, target));
    else if (stats.isFile()) files.push(relative(root, target).split(sep).join('/'));
    else throw new Error(`non-file artifact path refused: ${relative(root, target)}`);
  }
  return files.sort();
}

export class ArtifactCollector {
  constructor(root, owner, secretValues = []) {
    if (!isAbsolute(root)) throw new Error('owned run directory must be absolute');
    if (owner?.provenance === 'LIVE_CAPTURE') {
      const error = new Error('portable Node path APIs cannot pin every parent directory handle; LIVE_CAPTURE artifact writes are unsafe and unsupported');
      error.code = 'LIVE_ARTIFACT_PATH_UNSAFE';
      throw error;
    }
    this.root = resolve(root);
    this.owner = owner;
    this.secretValues = secretValues;
    this.entries = new Map();
    this.initialized = false;
  }

  async init() {
    const parent = resolve(this.root, '..');
    await assertExistingPathHasNoLinks(parent, 'owned root parent');
    const parentBefore = await lstat(parent, { bigint: true });
    if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) throw new Error('owned root parent is not a plain directory');
    await mkdir(this.root, { recursive: false });
    this.rootIdentity = await inspectRoot(this.root);
    const parentAfter = await lstat(parent, { bigint: true });
    if (identity(parentBefore) !== identity(parentAfter)) throw new Error('owned root parent identity changed during initialization');
    this.initialized = true;
    await this.writeBytes('.capture-owned', Buffer.from(`${this.owner.captureRunId}\n`, 'utf8'), { declare: false });
    const descriptor = await this.writeJson('bundle-owner.json', this.owner);
    this.ownerSha256 = descriptor.sha256;
    return descriptor;
  }

  async writeBytes(ref, bytes, { declare = true } = {}) {
    if (!this.initialized) throw new Error('collector is not initialized');
    const { parts, target } = safeRef(this.root, ref);
    await inspectRoot(this.root, this.rootIdentity);
    const snapshots = [await inspectDirectory(this.root, this.root)];
    let parent = this.root;
    for (const part of parts.slice(0, -1)) {
      const next = resolve(parent, part);
      const existing = await lstat(next, { bigint: true }).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (!existing) await mkdir(next, { recursive: false });
      snapshots.push(await inspectDirectory(this.root, next));
      parent = next;
    }
    const existingTarget = await lstat(target, { bigint: true }).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (existingTarget) throw new Error(`artifact destination already exists or is linked: ${ref}`);

    const sanitized = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const temporary = resolve(parent, `.capture-new-${randomUUID()}`);
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.writeFile(sanitized);
      await handle.sync();
      await handle.close();
      handle = null;
      const temporaryStats = await lstat(temporary, { bigint: true });
      if (!temporaryStats.isFile() || temporaryStats.isSymbolicLink()) throw new Error(`temporary artifact is not a plain file: ${ref}`);
      await link(temporary, target);
      const committedStats = await lstat(target, { bigint: true });
      if (!committedStats.isFile() || committedStats.isSymbolicLink() || identity(committedStats) !== identity(temporaryStats)) {
        throw new Error(`artifact identity changed during commit: ${ref}`);
      }
      const canonical = await realpath(target);
      if (!within(await realpath(this.root), canonical)) throw new Error(`artifact escaped owned root during commit: ${ref}`);
      await recheckDirectories(this.root, snapshots);
      await inspectRoot(this.root, this.rootIdentity);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    }
    const descriptor = { ref, sha256: sha256Bytes(sanitized), bytes: sanitized.length };
    if (declare) this.entries.set(descriptor.ref, descriptor);
    return descriptor;
  }

  readBytes(ref) {
    if (!this.initialized) throw new Error('collector is not initialized');
    return readOwnedFile(this.root, this.rootIdentity, ref);
  }

  writeText(ref, text) {
    return this.writeBytes(ref, Buffer.from(redactSecrets(String(text), this.secretValues), 'utf8'));
  }

  writeJson(ref, value) {
    const sanitized = redactSecrets(value, this.secretValues);
    return this.writeBytes(ref, Buffer.from(`${JSON.stringify(sanitized, null, 2)}\n`, 'utf8'));
  }

  async finalize(summary) {
    const manifest = {
      schemaVersion: 1,
      kind: 'meri-live-read-capture-manifest',
      captureRunId: this.owner.captureRunId,
      owner: { ref: 'bundle-owner.json', sha256: this.ownerSha256 },
      summary: redactSecrets(summary, this.secretValues),
      artifacts: [...this.entries.values()].sort((a, b) => a.ref.localeCompare(b.ref)),
    };
    const descriptor = await this.writeJson('capture-manifest.json', manifest);
    return { ...manifest, manifest: descriptor };
  }
}

export async function verifyCollectedArtifacts(root) {
  const absolute = resolve(root);
  const errors = [];
  let rootIdentity;
  let manifestBytes = Buffer.alloc(0);
  let manifest = {};
  try {
    rootIdentity = await inspectRoot(absolute);
    manifestBytes = await readOwnedFile(absolute, rootIdentity, 'capture-manifest.json');
    const manifestText = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
    manifest = JSON.parse(manifestText);
  } catch (error) {
    errors.push(`capture-manifest.json: ${error.message}`);
  }
  if (manifest.kind !== 'meri-live-read-capture-manifest') errors.push('manifest kind is invalid');
  if (!Array.isArray(manifest.artifacts)) errors.push('manifest artifacts are missing');
  const declared = new Map((manifest.artifacts ?? []).map((entry) => [entry.ref, entry]));
  if (declared.size !== (manifest.artifacts ?? []).length) errors.push('manifest contains duplicate artifact refs');
  for (const [ref, descriptor] of declared) {
    if (!SHA256.test(descriptor?.sha256 ?? '')) {
      errors.push(`${ref}: malformed sha256`);
      continue;
    }
    try {
      const bytes = await readOwnedFile(absolute, rootIdentity, ref);
      if (sha256Bytes(bytes) !== descriptor.sha256) errors.push(`${ref}: sha256 mismatch`);
      if (bytes.length !== descriptor.bytes) errors.push(`${ref}: byte count mismatch`);
    } catch (error) {
      errors.push(`${ref}: ${error.message}`);
    }
  }
  try {
    const actual = (await listFiles(absolute, rootIdentity)).filter((ref) => !['.capture-owned', 'capture-manifest.json'].includes(ref));
    for (const ref of actual) if (!declared.has(ref)) errors.push(`${ref}: undeclared artifact`);
  } catch (error) {
    errors.push(`owned tree: ${error.message}`);
  }
  const owner = declared.get('bundle-owner.json');
  if (!owner || manifest.owner?.sha256 !== owner.sha256) errors.push('owner binding mismatch');
  return {
    valid: errors.length === 0,
    errors,
    captureRunId: manifest.captureRunId,
    manifestSha256: sha256Bytes(manifestBytes),
  };
}

export function newCaptureRunId(prefix = 'meri-live-read') {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`;
}
