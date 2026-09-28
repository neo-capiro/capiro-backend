import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/u;
const SECRET_KEY = /(?:authorization|cookie|token|secret|password|api[_-]?key|session)/iu;
const SECRET_TEXT = /(?:Bearer\s+)[A-Za-z0-9._~+\/-]+=*|(?:__session|__client_uat|CLERK_SECRET_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*[^\s,;"']+/giu;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;

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
  if (typeof ref !== 'string' || !ref || isAbsolute(ref) || ref.includes('\0')) throw new Error('artifact ref must be a non-empty relative path');
  const target = resolve(root, ref);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..') throw new Error(`artifact ref escapes owned root: ${ref}`);
  return target;
}

async function listFiles(root, dir = root) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, target));
    else if (entry.isFile()) files.push(relative(root, target).split(sep).join('/'));
  }
  return files.sort();
}

export class ArtifactCollector {
  constructor(root, owner, secretValues = []) {
    if (!isAbsolute(root)) throw new Error('owned run directory must be absolute');
    this.root = resolve(root);
    this.owner = owner;
    this.secretValues = secretValues;
    this.entries = new Map();
    this.initialized = false;
  }

  async init() {
    await mkdir(this.root, { recursive: false });
    const lock = await open(join(this.root, '.capture-owned'), 'wx');
    await lock.writeFile(`${this.owner.captureRunId}\n`);
    await lock.close();
    this.initialized = true;
    const descriptor = await this.writeJson('bundle-owner.json', this.owner);
    this.ownerSha256 = descriptor.sha256;
    return descriptor;
  }

  async writeBytes(ref, bytes) {
    if (!this.initialized) throw new Error('collector is not initialized');
    const target = safeRef(this.root, ref);
    await mkdir(resolve(target, '..'), { recursive: true });
    const sanitized = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    await writeFile(target, sanitized, { flag: 'wx' });
    const descriptor = { ref: ref.split('\\').join('/'), sha256: sha256Bytes(sanitized), bytes: sanitized.length };
    this.entries.set(descriptor.ref, descriptor);
    return descriptor;
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
  const manifestBytes = await readFile(join(absolute, 'capture-manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const errors = [];
  if (manifest.kind !== 'meri-live-read-capture-manifest') errors.push('manifest kind is invalid');
  if (!Array.isArray(manifest.artifacts)) errors.push('manifest artifacts are missing');
  const declared = new Map((manifest.artifacts ?? []).map((entry) => [entry.ref, entry]));
  for (const [ref, descriptor] of declared) {
    if (!SHA256.test(descriptor?.sha256 ?? '')) {
      errors.push(`${ref}: malformed sha256`);
      continue;
    }
    try {
      const bytes = await readFile(safeRef(absolute, ref));
      if (sha256Bytes(bytes) !== descriptor.sha256) errors.push(`${ref}: sha256 mismatch`);
      if (bytes.length !== descriptor.bytes) errors.push(`${ref}: byte count mismatch`);
    } catch (error) {
      errors.push(`${ref}: ${error.message}`);
    }
  }
  const actual = (await listFiles(absolute)).filter((ref) => !['.capture-owned', 'capture-manifest.json'].includes(ref));
  for (const ref of actual) if (!declared.has(ref)) errors.push(`${ref}: undeclared artifact`);
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
