#!/usr/bin/env node
// Prepare a reviewable, tracked-only Docker context for the integrated Core API.
// No network, Docker, SQL, or cloud operation occurs here.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const inputPaths = [
  '.dockerignore',
  'apps/api/Dockerfile',
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
const migrationFiles = [
  'apps/api/prisma/migrations/20281018020000_clio_meri_memory_submissions/migration.sql',
  'apps/api/prisma/migrations/20281018060000_meri_read_delegation/migration.sql',
  'apps/api/prisma/migrations/20281018080000_clio_memory_scope_unique/migration.sql',
  'apps/api/prisma/migrations/20281018090000_clio_meri_memory_submissions_content_free/migration.sql',
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
function option(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ref = option('--ref');
const base = option('--base');
const manifestPath = option('--manifest');
const archivePath = option('--archive');
if (!ref || !/^[0-9a-f]{40}$/.test(ref) || (base && !/^[0-9a-f]{40}$/.test(base))) {
  throw new Error('Use --ref <exact 40-character commit SHA> [--base <exact commit SHA>] [--manifest <path>] [--archive <path>].');
}
const sourceSha = git(['rev-parse', `${ref}^{commit}`]).trim();
if (sourceSha !== ref) throw new Error('Source ref did not resolve to the exact requested commit.');
const treeSha = git(['rev-parse', `${ref}^{tree}`]).trim();
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
const dockerfile = git(['show', `${ref}:apps/api/Dockerfile`]);
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
  dockerfileSha256: sha256(git(['show', `${ref}:apps/api/Dockerfile`], null)),
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
if (archivePath) {
  const output = resolve(archivePath);
  if (existsSync(output)) throw new Error(`Refusing to overwrite archive: ${output}`);
  mkdirSync(dirname(output), { recursive: true });
  git(['archive', '--format=zip', `--output=${output}`, sourceSha, ...inputPaths]);
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
