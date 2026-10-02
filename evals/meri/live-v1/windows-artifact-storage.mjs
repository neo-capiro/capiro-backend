import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const instances = new WeakSet();
const helper = fileURLToPath(new URL('./lib/windows-artifact-protocol.py', import.meta.url));
const MAX_BYTES = 32 * 1024 * 1024;

/** Trusted operator input, never a field of the model/scope configuration. */
export function createWindowsArtifactStorage(root, { pythonExecutable } = {}) {
  if (process.platform !== 'win32')
    throw new Error('Windows native artifact storage is unavailable');
  if (!isAbsolute(root) || typeof pythonExecutable !== 'string' || !isAbsolute(pythonExecutable)) {
    throw new Error('absolute owned root and trusted Python executable are required');
  }
  const ownedRoot = resolve(root);
  let state;
  let failed = false;
  const invoke = (request) => {
    if (failed)
      throw new Error('native artifact storage is poisoned after an unsuccessful operation');
    try {
      const processResult = spawnSync(pythonExecutable, ['-I', helper], {
        input: JSON.stringify({ ...request, root: ownedRoot, state }),
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: 15000,
        maxBuffer: 48 * 1024 * 1024,
      });
      if (processResult.error || processResult.status !== 0)
        throw new Error('native operation failed closed');
      const response = JSON.parse(processResult.stdout);
      if (response.ok !== true || response.state?.root !== ownedRoot)
        throw new Error('invalid native response');
      state = response.state;
      return response.result;
    } catch {
      failed = true;
      throw new Error('native owned-artifact operation failed closed');
    }
  };
  const storage = Object.freeze({
    root: ownedRoot,
    init(owner, marker) {
      if (state) throw new Error('native artifact storage was already initialized');
      return invoke({
        op: 'init',
        owner: Buffer.from(owner).toString('base64'),
        marker: Buffer.from(marker).toString('base64'),
      });
    },
    writeBytes(ref, bytes) {
      const buffer = Buffer.from(bytes);
      if (buffer.length > MAX_BYTES) throw new Error('artifact exceeds native byte limit');
      const descriptor = invoke({ op: 'write', ref, bytes: buffer.toString('base64') });
      if (
        descriptor.ref !== ref ||
        descriptor.bytes !== buffer.length ||
        descriptor.sha256 !== createHash('sha256').update(buffer).digest('hex')
      ) {
        failed = true;
        throw new Error('native write descriptor differs from actual submitted bytes');
      }
      return descriptor;
    },
    readBytes(ref) {
      const result = invoke({ op: 'read', ref });
      const bytes = Buffer.from(result.bytes, 'base64');
      if (
        bytes.length > MAX_BYTES ||
        createHash('sha256').update(bytes).digest('hex') !== result.sha256
      ) {
        failed = true;
        throw new Error('native read hash mismatch');
      }
      return bytes;
    },
    listFiles() {
      return invoke({ op: 'list' });
    },
  });
  instances.add(storage);
  return storage;
}

export function assertWindowsArtifactStorage(storage, root) {
  if (!instances.has(storage) || storage.root !== resolve(root))
    throw new Error('unverified native artifact storage capability');
  return storage;
}
