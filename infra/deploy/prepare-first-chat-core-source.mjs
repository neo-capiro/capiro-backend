#!/usr/bin/env node
// Prepare a reviewable, tracked-only Docker context for the integrated Core API.
// No network, Docker, SQL, or cloud operation occurs here.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const inputPaths = [
  '.dockerignore',
  'apps/api/Dockerfile.alpine-qualification',
  'docs/runtime-production-closure-20261014/RUNTIME-CLOSURE-CONTRACT.json',
  'apps/api/package.json',
  'apps/api/nest-cli.json',
  'apps/api/tsconfig.json',
  'apps/api/tsconfig.build.json',
  'apps/api/src',
  'apps/api/prisma',
  'apps/api/scripts',
  'apps/api/data',
  'packages/shared/package.json',
  'packages/shared/tsconfig.json',
  'packages/shared/src',
  'packages/meriv2-core/package.json',
  'packages/meriv2-core/tsconfig.json',
  'packages/meriv2-core/src',
  'packages/defense-contracts/package.json',
  'packages/defense-contracts/tsconfig.json',
  'packages/defense-contracts/src',
  'packages/defense-domain/package.json',
  'packages/defense-domain/tsconfig.json',
  'packages/defense-domain/src',
  'pnpm-workspace.yaml',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.base.json',
];
const reviewedStage1Migration =
  'apps/api/prisma/migrations/20281018090000_clio_meri_memory_submissions_content_free/migration.sql';
// Git archive preserves LF blob bytes. The Windows CRLF checkout hashes to
// 0e358884..., which is not the migration shipped in this tracked-only ZIP.
const reviewedStage1Sha256 = 'f9d2f4a13474a1af97afdd9b5b8587a6e27e90a36d07fdd1e6f30344bb595c51';
const heldHelperMigration = 'apps/api/prisma/migrations/20281018100000_meri_memory_eligibility_helper';
const migrationFiles = [
  'apps/api/prisma/migrations/20281018020000_clio_meri_memory_submissions/migration.sql',
  'apps/api/prisma/reserved-migrations/20281018060000_meri_read_delegation/migration.sql',
  'apps/api/prisma/migrations/20281018080000_clio_memory_scope_unique/migration.sql',
  reviewedStage1Migration,
];
const forbiddenPath = /(^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.aws|\.ssh|id_rsa|id_ed25519|credentials\.json|service-account\.json)$|\.(?:pem|p12|pfx|key)$/i;

function git(args, encoding = 'utf8') {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    // This preparer must fail on a missing local object, never fetch one from a
    // partial clone while collecting a supposedly offline source inventory.
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.slice(0, 3).join(' ')} failed: ${result.error?.message ?? String(result.stderr)}`);
  }
  return result.stdout;
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function covered(path) { return inputPaths.some(prefix => path === prefix || path.startsWith(`${prefix}/`)); }
function readAt(descriptor, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const bytes = readSync(descriptor, buffer, offset, length - offset, position + offset);
    if (!bytes) throw new Error('Unexpected end of ZIP while inspecting entries.');
    offset += bytes;
  }
  return buffer;
}
function inspectZip(path, selectedFiles) {
  const descriptor = openSync(path, 'r');
  try {
    const length = fstatSync(descriptor).size;
    const tail = readAt(descriptor, Math.min(length, 65557), length - Math.min(length, 65557));
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at--) {
      if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) {
        eocd = at;
        break;
      }
    }
    if (eocd < 0 || tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) {
      throw new Error('Archive is not a single-disk ZIP with a valid end directory.');
    }
    const count = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff ||
        centralOffset + centralSize > length) {
      throw new Error('ZIP64 or out-of-bounds archive directory is not supported.');
    }
    const central = readAt(descriptor, centralSize, centralOffset);
    const expected = new Map(selectedFiles.map(file => [file.path, file]));
    const directories = new Set();
    for (const file of selectedFiles) {
      const segments = file.path.split('/');
      for (let n = 1; n < segments.length; n++) directories.add(`${segments.slice(0, n).join('/')}/`);
    }
    let cursor = 0;
    let entries = 0;
    while (cursor < central.length) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error('Malformed ZIP central directory entry.');
      }
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const size = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (next > central.length) throw new Error('ZIP entry extends beyond central directory.');
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
        throw new Error(`Unsafe ZIP path: ${name}`);
      }
      if (name.endsWith('/')) {
        if (!directories.has(name)) throw new Error(`Unexpected ZIP directory: ${name}`);
      } else {
        const file = expected.get(name);
        if (!file || file.size !== size || (flags & 1) || ![0, 8].includes(method)) {
          throw new Error(`Unexpected ZIP file, size, encryption, or method: ${name}`);
        }
        const unixMode = central.readUInt32LE(cursor + 38) >>> 16;
        // Git ZIP writes ordinary 100644 files as DOS entries with zero Unix
        // attributes; executable 100755 files carry their Unix mode.
        if (![Number.parseInt(file.mode, 8), ...(file.mode === '100644' ? [0] : [])].includes(unixMode)) {
          throw new Error(`ZIP mode differs from Git tree: ${name}`);
        }
        const localOffset = central.readUInt32LE(cursor + 42);
        if (localOffset === 0xffffffff || compressedSize === 0xffffffff || size === 0xffffffff ||
            localOffset + 30 > centralOffset) throw new Error(`Invalid ZIP local offset: ${name}`);
        const local = readAt(descriptor, 30, localOffset);
        if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`Missing ZIP local header: ${name}`);
        const localNameLength = local.readUInt16LE(26);
        const localExtraLength = local.readUInt16LE(28);
        const localName = readAt(descriptor, localNameLength, localOffset + 30).toString('utf8');
        if (localName !== name) throw new Error(`ZIP local/central name mismatch: ${name}`);
        const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
        if (dataOffset + compressedSize > centralOffset) throw new Error(`ZIP data exceeds directory: ${name}`);
        const compressed = readAt(descriptor, compressedSize, dataOffset);
        const data = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(size, 1) });
        const blobSha = createHash('sha1').update(`blob ${size}\0`).update(data).digest('hex');
        if (data.length !== size || blobSha !== file.blobSha) {
          throw new Error(`ZIP content differs from Git blob: ${name}`);
        }
        expected.delete(name);
      }
      entries++;
      cursor = next;
    }
    if (entries !== count || expected.size) {
      throw new Error(`ZIP entries did not match tracked source files (${expected.size} missing).`);
    }
    return entries;
  } finally {
    closeSync(descriptor);
  }
}
function option(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ref = option('--ref');
const base = option('--base');
const manifestPath = option('--manifest');
const archivePath = option('--archive');
const verifyArchivePath = option('--verify-archive');
if (!ref || !/^[0-9a-f]{40}$/.test(ref) || (base && !/^[0-9a-f]{40}$/.test(base))) {
  throw new Error('Use --ref <exact 40-character commit SHA> [--base <exact commit SHA>] [--manifest <path>] [--archive <path> | --verify-archive <path>].');
}
if (archivePath && verifyArchivePath) throw new Error('Choose either --archive or --verify-archive.');
const sourceSha = git(['rev-parse', `${ref}^{commit}`]).trim();
if (sourceSha !== ref) throw new Error('Source ref did not resolve to the exact requested commit.');
const treeSha = git(['rev-parse', `${ref}^{tree}`]).trim();
if (git(['ls-tree', '-r', '--name-only', ref, '--', heldHelperMigration]).trim()) {
  throw new Error(`Held helper migration must remain outside this Stage 1 source packet: ${heldHelperMigration}.`);
}
const stage1Sha256 = sha256(git(['show', `${ref}:${reviewedStage1Migration}`], null));
if (stage1Sha256 !== reviewedStage1Sha256) {
  throw new Error(`Unreviewed Stage 1 memory migration ${stage1Sha256}; expected ${reviewedStage1Sha256}.`);
}
const raw = git(['ls-tree', '-r', '-l', '-z', ref, '--', ...inputPaths]);
const files = raw.split('\0').filter(Boolean).map(row => {
  const match = /^(\d{6}) blob ([0-9a-f]{40})\s+(\d+)\t(.+)$/.exec(row);
  if (!match) throw new Error(`Non-regular or malformed tree entry: ${row.slice(0, 120)}`);
  const [, mode, blobSha, size, path] = match;
  if (!['100644', '100755'].includes(mode) || !covered(path) || forbiddenPath.test(path)) {
    throw new Error(`Disallowed archive entry: ${path}`);
  }
  return { path, mode, blobSha, size: Number(size) };
});
if (!files.length || new Set(files.map(file => file.path)).size !== files.length) {
  throw new Error('Archive input inventory is empty or duplicated.');
}
for (const path of inputPaths) {
  if (!files.some(file => file.path === path || file.path.startsWith(`${path}/`))) {
    throw new Error(`Missing required Docker build input: ${path}`);
  }
}

// Fail if the Dockerfile adds a new local COPY source without expanding the
// reviewed inventory. Staged COPY --from references are generated internally.
const dockerfile = git(['show', `${ref}:apps/api/Dockerfile.alpine-qualification`]);
const localCopySources = new Set();
for (const line of dockerfile.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)) {
  const match = /^\s*COPY\s+(.+)$/i.exec(line);
  if (!match) continue;
  const tokens = match[1].trim().split(/\s+/);
  const flags = tokens.filter(token => token.startsWith('--'));
  if (flags.some(flag => flag.startsWith('--from='))) continue;
  const sources = tokens.filter(token => !token.startsWith('--')).slice(0, -1);
  for (const source of sources) {
    if (source === 'pnpm-lock.yaml*') {
      localCopySources.add('pnpm-lock.yaml');
    } else {
      localCopySources.add(source);
    }
  }
}
for (const source of localCopySources) {
  if (!covered(source) || !files.some(file => file.path === source || file.path.startsWith(`${source}/`))) {
    throw new Error(`Uncovered local Dockerfile COPY source: ${source}`);
  }
}
if (files.some(file => file.path.startsWith('pnpm-lock.yaml.') && file.path !== 'pnpm-lock.yaml')) {
  throw new Error('pnpm-lock.yaml* would include an unreviewed extra input.');
}

const inventoryText = files.map(file => `${file.mode} ${file.blobSha} ${file.size}\t${file.path}\n`).join('');
const result = {
  sourceSha,
  treeSha,
  baseSha: base ?? null,
  trackedOnly: true,
  dockerfileCopySources: [...localCopySources].sort(),
  inputPathspecs: inputPaths,
  fileCount: files.length,
  uncompressedBlobBytes: files.reduce((sum, file) => sum + file.size, 0),
  inventorySha256: sha256(inventoryText),
  dockerfileSha256: sha256(git(['show', `${ref}:apps/api/Dockerfile.alpine-qualification`], null)),
  reviewedBuildspecSha256: sha256(git(['show', `${ref}:infra/deploy/first-chat-core-preview.buildspec.yml`], null)),
  criticalMigrationSha256: Object.fromEntries(migrationFiles.map(path =>
    [path, sha256(git(['show', `${ref}:${path}`], null))])),
  files,
};
if (base) {
  if (git(['rev-parse', `${base}^{commit}`]).trim() !== base) throw new Error('Base ref did not resolve exactly.');
  const diff = git(['diff', '--binary', '--no-ext-diff', base, sourceSha], null);
  result.baseToSourceDiffSha256 = sha256(diff);
  result.baseToSourceChangedPaths = git(['diff', '--name-only', '--no-ext-diff', base, sourceSha]).trim().split(/\r?\n/).filter(Boolean);
}
if (archivePath || verifyArchivePath) {
  const output = resolve(archivePath ?? verifyArchivePath);
  const inRepository = relative(root, output);
  if (!inRepository.startsWith('..') && !isAbsolute(inRepository)) {
    throw new Error('Archive output must be outside this Git worktree.');
  }
  if (basename(output) !== `core-${sourceSha}.zip`) {
    throw new Error(`Archive name must be core-${sourceSha}.zip.`);
  }
  if (archivePath) {
    if (existsSync(output)) throw new Error(`Refusing to overwrite archive: ${output}`);
    mkdirSync(dirname(output), { recursive: true });
    // A Windows checkout may set core.autocrlf=true. Without this override Git
    // archive rewrites unconstrained text blobs (including .dockerignore) to
    // CRLF, so its ZIP entries cease to match the pinned Git blob inventory.
    git(['-c', 'core.autocrlf=false', 'archive', '--format=zip', `--output=${output}`, sourceSha, ...inputPaths]);
  }
  if (!existsSync(output)) throw new Error(`Archive is missing: ${output}`);
  result.archiveEntries = inspectZip(output, files);
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(output)) hash.update(chunk);
  result.archivePath = output;
  result.archiveSha256 = hash.digest('hex');
  result.s3Key = `inputs/core-${sourceSha}.zip`;
}
const json = `${JSON.stringify(result, null, 2)}\n`;
if (manifestPath) {
  const output = resolve(manifestPath);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, json, { flag: 'wx' });
}
process.stdout.write(JSON.stringify({ sourceSha, treeSha, fileCount: result.fileCount,
  uncompressedBlobBytes: result.uncompressedBlobBytes, inventorySha256: result.inventorySha256,
  baseToSourceDiffSha256: result.baseToSourceDiffSha256, changedPathCount: result.baseToSourceChangedPaths?.length,
  archiveSha256: result.archiveSha256, manifestPath: manifestPath ? resolve(manifestPath) : undefined }) + '\n');
