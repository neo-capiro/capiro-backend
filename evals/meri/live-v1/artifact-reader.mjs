import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { assertWindowsArtifactStorage } from './windows-artifact-storage.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const REMOTE_OR_FILE_URL = /^[a-z][a-z0-9+.-]*:/iu;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export class ArtifactIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArtifactIntegrityError';
  }
}

function isUrl(value) {
  return REMOTE_OR_FILE_URL.test(value) && !/^[a-z]:[\\/]/iu.test(value);
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashesEqual(left, right) {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function assertOwnedRelativeRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0) throw new ArtifactIntegrityError('artifact ref must be a nonempty string');
  if (isUrl(ref)) throw new ArtifactIntegrityError(`remote or URL artifact ref refused: ${ref}`);
  if (isAbsolute(ref) || /^[a-z]:[\\/]/iu.test(ref) || ref.startsWith('\\\\')) {
    throw new ArtifactIntegrityError(`absolute artifact ref refused: ${ref}`);
  }
  if (ref.includes('\\')) throw new ArtifactIntegrityError(`artifact ref must use portable forward slashes: ${ref}`);
  const parts = ref.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new ArtifactIntegrityError(`artifact traversal ref refused: ${ref}`);
  return parts;
}

function assertNoSymlinkComponents(path, label) {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    const stats = lstatSync(cursor, { throwIfNoEntry: false });
    if (!stats) throw new ArtifactIntegrityError(`${label} does not exist`);
    if (stats.isSymbolicLink()) throw new ArtifactIntegrityError(`${label} contains a symlink component`);
  }
}

function safelyReadBoundedFile(path, ref) {
  let fd;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new ArtifactIntegrityError(`artifact is not a regular file: ${ref}`);
    if (before.size > BigInt(MAX_ARTIFACT_BYTES)) throw new ArtifactIntegrityError(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes: ${ref}`);

    const chunks = [];
    let total = 0;
    while (total <= MAX_ARTIFACT_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_ARTIFACT_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    if (total > MAX_ARTIFACT_BYTES) throw new ArtifactIntegrityError(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes while reading: ${ref}`);
    const after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new ArtifactIntegrityError(`artifact changed while being read: ${ref}`);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) throw error;
    throw new ArtifactIntegrityError(`safe artifact open/read failed for ${ref}: ${error.message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class OwnedArtifactReader {
  constructor(rootPath, expectedOwner, { storage = null } = {}) {
    if (typeof rootPath !== 'string' || !isAbsolute(rootPath) || isUrl(rootPath)) {
      throw new ArtifactIntegrityError('artifactRoot must be an absolute local filesystem path');
    }
    this.storage = storage ? assertWindowsArtifactStorage(storage, rootPath) : null;
    if (storage) {
      this.root = resolve(rootPath);
    } else {
      assertNoSymlinkComponents(rootPath, 'artifactRoot');
      const rootStats = lstatSync(rootPath, { throwIfNoEntry: false });
      if (!rootStats?.isDirectory()) throw new ArtifactIntegrityError('artifactRoot is missing or is not a directory');
      if (rootStats.isSymbolicLink()) throw new ArtifactIntegrityError('symlink artifactRoot refused');
      this.root = realpathSync(rootPath);
    }
    this.owner = this.readJson({ ref: 'bundle-owner.json', sha256: expectedOwner.ownerSha256 }, { allowOwner: true });
    const ownerKeys = ['captureRunId', 'contractSourceSha256', 'fixtureSha256', 'fixtureVersion', 'kind', 'provenance', 'schemaVersion'];
    if (JSON.stringify(Object.keys(this.owner ?? {}).sort()) !== JSON.stringify(ownerKeys)) {
      throw new ArtifactIntegrityError('bundle owner shape contains missing or additional fields');
    }
    const expected = {
      schemaVersion: 1,
      kind: 'meri-live-v1-artifact-bundle',
      captureRunId: expectedOwner.captureRunId,
      fixtureVersion: expectedOwner.fixtureVersion,
      fixtureSha256: expectedOwner.fixtureSha256,
      contractSourceSha256: expectedOwner.contractSourceSha256,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (this.owner?.[key] !== value) throw new ArtifactIntegrityError(`bundle owner ${key} is not bound to the capture bundle`);
    }
    if (!['UNIT_FIXTURE_NOT_LIVE', 'LIVE_CAPTURE'].includes(this.owner.provenance)) {
      throw new ArtifactIntegrityError('bundle owner provenance is invalid');
    }
  }

  resolveRef(ref, { allowOwner = false } = {}) {
    const parts = assertOwnedRelativeRef(ref);
    if (!allowOwner && ref === 'bundle-owner.json') throw new ArtifactIntegrityError('owner marker cannot be reused as evidence');
    if (this.storage) throw new ArtifactIntegrityError('native storage does not expose path-based artifact reads');
    let cursor = this.root;
    for (const part of parts) {
      cursor = resolve(cursor, part);
      const stats = lstatSync(cursor, { throwIfNoEntry: false });
      if (!stats) throw new ArtifactIntegrityError(`artifact does not exist: ${ref}`);
      if (stats.isSymbolicLink()) throw new ArtifactIntegrityError(`symlink artifact ref refused: ${ref}`);
    }
    const canonical = realpathSync(cursor);
    const boundary = relative(this.root, canonical);
    if (boundary === '..' || boundary.startsWith(`..${sep}`) || isAbsolute(boundary)) {
      throw new ArtifactIntegrityError(`artifact escaped owned root: ${ref}`);
    }
    const stats = lstatSync(canonical);
    if (!stats.isFile()) throw new ArtifactIntegrityError(`artifact is not a regular file: ${ref}`);
    if (stats.size > MAX_ARTIFACT_BYTES) throw new ArtifactIntegrityError(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes: ${ref}`);
    return canonical;
  }

  readBytes(descriptor, options) {
    if (!descriptor || typeof descriptor !== 'object') throw new ArtifactIntegrityError('artifact descriptor is missing');
    if (!SHA256.test(descriptor.sha256 ?? '')) throw new ArtifactIntegrityError(`artifact hash is malformed: ${String(descriptor.ref)}`);
    let bytes;
    if (this.storage) {
      assertOwnedRelativeRef(descriptor.ref);
      if (!options?.allowOwner && descriptor.ref === 'bundle-owner.json') throw new ArtifactIntegrityError('owner marker cannot be reused as evidence');
      try {
        bytes = this.storage.readBytes(descriptor.ref);
      } catch {
        throw new ArtifactIntegrityError('native artifact integrity read failed closed');
      }
      if (bytes.length > MAX_ARTIFACT_BYTES) throw new ArtifactIntegrityError('artifact exceeds reader byte limit');
    } else {
      bytes = safelyReadBoundedFile(this.resolveRef(descriptor.ref, options), descriptor.ref);
    }
    const actualSha256 = hashBytes(bytes);
    if (!hashesEqual(actualSha256, descriptor.sha256)) {
      throw new ArtifactIntegrityError(`artifact hash mismatch for ${descriptor.ref}: declared ${descriptor.sha256}, actual ${actualSha256}`);
    }
    return { bytes, sha256: actualSha256, ref: descriptor.ref };
  }

  readText(descriptor, options) {
    const artifact = this.readBytes(descriptor, options);
    try {
      return { ...artifact, text: new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes) };
    } catch {
      throw new ArtifactIntegrityError(`artifact is not valid UTF-8: ${descriptor.ref}`);
    }
  }

  readJson(descriptor, options) {
    const artifact = this.readText(descriptor, options);
    try {
      return JSON.parse(artifact.text);
    } catch {
      throw new ArtifactIntegrityError(`artifact is not valid JSON: ${descriptor.ref}`);
    }
  }
}

export function sha256RawBytes(value) {
  return hashBytes(value);
}
