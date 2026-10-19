'use strict';
// Source-only reproducibility helper. Tooling and derived artifacts stay outside repositories.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const repository = path.resolve(process.argv[2] || '');
const toolsRoot = path.resolve(process.argv[3] || '');
const sourceCommit = '50475125275853299798fc40f8cb119f0b865464';
const cli = path.join(toolsRoot, 'node_modules/prisma/build/index.js');
assert.equal(JSON.parse(fs.readFileSync(path.join(toolsRoot, 'node_modules/prisma/package.json'), 'utf8')).version, '5.22.0');
const canonical = cp.execFileSync('git', ['-c', 'safe.directory=' + repository.replaceAll('\\', '/'), 'show', sourceCommit + ':apps/api/prisma/schema.prisma'], { cwd: repository });
assert(!canonical.includes(13), 'canonical schema must have LF bytes');
const source = canonical.toString('utf8');
const generator = /generator client\s*\{[^}]*\}/.exec(source);
assert(generator, 'client generator required');
const from = '"linux-arm64-openssl-3.0.x"';
assert.equal(generator[0].split(from).length - 1, 1, 'one source generator target required');
const hash = value => createHash('sha256').update(value).digest('hex');
const environment = {};
for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PATHEXT', 'SystemDrive', 'ComSpec', 'COMSPEC', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) {
  if (process.env[name] !== undefined) environment[name] = process.env[name];
}
environment.CHECKPOINT_DISABLE = '1';
environment.PRISMA_HIDE_UPDATE_MESSAGE = '1';
environment.PRISMA_SKIP_POSTINSTALL_GENERATE = '1';
environment.CACHE_DIR = path.join(toolsRoot, 'engine-cache');
// No engine-path override or checksum-ignore flag. CLI performs normal pinned engine acquisition.
const rows = [];
for (const [architecture, target] of [['arm64', 'linux-musl-arm64-openssl-3.0.x'], ['x64', 'linux-musl-openssl-3.0.x']]) {
  const raw = Buffer.from(source.replace(generator[0], generator[0].replace(from, JSON.stringify(target))));
  const rawName = 'schema.' + architecture + '.raw.prisma';
  const formattedName = 'schema.' + architecture + '.formatted.prisma';
  fs.writeFileSync(path.join(__dirname, rawName), raw);
  fs.writeFileSync(path.join(__dirname, formattedName), raw);
  const invocation = cp.spawnSync(process.execPath, [cli, 'format', '--schema', path.join(__dirname, formattedName)], {
    cwd: __dirname, env: environment, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
  });
  assert.equal(invocation.status, 0, 'Prisma 5.22.0 format failed: ' + (invocation.error?.message || invocation.stderr || invocation.stdout));
  const formatted = fs.readFileSync(path.join(__dirname, formattedName));
  assert(!formatted.includes(13), 'formatted schema must have LF bytes');
  rows.push({ architecture, target, rawArtifact: rawName, rawSHA256: hash(raw), formattedArtifact: formattedName, generatedCompanionSHA256: hash(formatted), formatExitCode: invocation.status });
}
const wasm = fs.readFileSync(path.join(toolsRoot, 'node_modules/prisma/build/prisma_schema_build_bg.wasm'));
assert.equal(wasm.length, 2893316);
assert.equal(hash(wasm), 'adf02f9b486d507024be2bf59b271a88e39f48c3ca2266c6c46d7e9109296c05');
const result = {
  sourceCommit, sourceSchemaSHA256: hash(canonical), schemaPath: 'apps/api/prisma/schema.prisma',
  tool: { package: 'prisma', version: '5.22.0', wasmBytes: wasm.length, wasmSHA256: hash(wasm) },
  mode: 'UNMODIFIED_PRISMA_CLI_FORMAT_WITH_NORMAL_CHECKSUM_VERIFIED_ENGINE_ACQUISITION',
  environment: { sanitizedAllowlist: true, inheritedCredentials: false, checkpointDisabled: true, updateNoticeDisabled: true, engineOverrides: false, checksumVerificationBypassed: false },
  rows,
  limits: ['Formatting evidence only; no generated application client, image, native ABI, database or runtime qualification.'],
};
fs.writeFileSync(path.join(__dirname, 'schema-pins.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
