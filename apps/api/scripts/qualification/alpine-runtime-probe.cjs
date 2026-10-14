/* Offline qualification only. No database clients, migration execution or secrets. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const { createHash } = require('node:crypto');
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 30000 });
function assertDumbInitVersion(file = 'dumb-init', args = ['--version'], { timeout = 30000 } = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'dumb-init version command must exit successfully');
  assert.match(result.stdout + result.stderr, /dumb-init v?1\.2\.5/);
}
function contained(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function elfMetadata(data) {
  assert(data.length >= 64 && data.subarray(0, 4).toString('hex') === '7f454c46', 'native artifact must be ELF');
  assert.equal(data[4], 2, 'ELF64 required'); assert.equal(data[5], 1, 'little-endian ELF required');
  const number = offset => { const value = data.readBigUInt64LE(offset); assert(value <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(value); };
  const sectionOffset = number(40), sectionSize = data.readUInt16LE(58), sectionCount = data.readUInt16LE(60);
  assert(sectionSize >= 64 && sectionCount > 0 && sectionCount <= 8192, 'bounded ELF sections required');
  assert(sectionOffset + sectionSize * sectionCount <= data.length, 'truncated ELF sections');
  const section = index => {
    assert(index < sectionCount);
    const offset = sectionOffset + index * sectionSize;
    const value = { type: data.readUInt32LE(offset + 4), offset: number(offset + 24), size: number(offset + 32), link: data.readUInt32LE(offset + 40) };
    if (value.type !== 8) assert(value.offset + value.size <= data.length, 'truncated ELF section');
    return value;
  };
  const needed = [];
  for (let i = 0; i < sectionCount; i++) {
    const dynamic = section(i); if (dynamic.type !== 6) continue;
    const strings = section(dynamic.link); assert.equal(strings.type, 3); assert.equal(dynamic.size % 16, 0);
    for (let offset = dynamic.offset; offset < dynamic.offset + dynamic.size; offset += 16) {
      const tag = number(offset); if (tag === 0) break;
      if (tag !== 1) continue; // DT_NEEDED, never arbitrary matching bytes.
      const start = number(offset + 8); assert(start < strings.size);
      const end = data.indexOf(0, strings.offset + start);
      assert(end >= 0 && end < strings.offset + strings.size, 'unterminated ELF dependency');
      needed.push(data.toString('utf8', strings.offset + start, end));
    }
  }
  const glibc = needed.some(name => name === 'libc.so.6' || /^ld-linux-/.test(name));
  const musl = needed.some(name => /^libc\.musl-|^ld-musl-/.test(name));
  assert(!(glibc && musl), 'conflicting ELF libc dependencies');
  return { class: 64, machine: data.readUInt16LE(18), needed, libc: glibc ? 'glibc' : musl ? 'musl' : null };
}
function classifyNativeArtifact(file, { root = '/app/node_modules/.pnpm' } = {}) {
  root = fs.realpathSync(root); file = fs.realpathSync(file);
  assert(contained(root, file) && file !== root, 'native artifact escapes inventory root');
  const stat = fs.statSync(file); assert(stat.isFile() && stat.size <= 512 * 1024 * 1024, 'bounded regular native file required');
  let ownerRoot = path.dirname(file), metadata;
  while (contained(root, ownerRoot)) {
    const manifest = path.join(ownerRoot, 'package.json');
    if (fs.existsSync(manifest)) {
      assert(contained(ownerRoot, fs.realpathSync(manifest)) && fs.statSync(manifest).isFile(), 'package manifest escapes owner');
      metadata = JSON.parse(fs.readFileSync(manifest, 'utf8')); break;
    }
    if (ownerRoot === root) break;
    ownerRoot = path.dirname(ownerRoot);
  }
  assert(metadata && typeof metadata.name === 'string' && typeof metadata.version === 'string', 'native package identity missing');
  for (const key of ['os', 'cpu', 'libc']) assert(metadata[key] === undefined || (Array.isArray(metadata[key]) && metadata[key].length > 0 && metadata[key].every(value => typeof value === 'string')), `invalid package ${key}`);
  const data = fs.readFileSync(file), elf = elfMetadata(data);
  const owner = { root: ownerRoot, name: metadata.name, version: metadata.version, os: metadata.os || null, cpu: metadata.cpu || null, libc: metadata.libc || null };
  const declaredCpu = owner.cpu && owner.cpu.filter(value => !value.startsWith('!'));
  const machineByCpu = { arm64: 183, x64: 62, arm: 40, ia32: 3, ppc64: 21, s390x: 22, riscv64: 243 };
  if (declaredCpu?.length === 1 && machineByCpu[declaredCpu[0]]) assert.equal(elf.machine, machineByCpu[declaredCpu[0]], 'package/ELF cpu disagreement');
  const allows = (list, target) => !list || (!list.includes(`!${target}`) && (!list.some(value => !value.startsWith('!')) || list.includes(target)));
  const observedCpu = Object.keys(machineByCpu).find(cpu => machineByCpu[cpu] === elf.machine);
  if (observedCpu) assert(allows(owner.cpu, observedCpu), 'package/ELF cpu constraint disagreement');
  if (elf.libc) assert(allows(owner.libc, elf.libc), 'package/ELF libc constraint disagreement');
  const reasons = [];
  if (!allows(owner.os, 'linux')) reasons.push('package-os');
  if (!allows(owner.cpu, 'arm64') || elf.machine !== 183) reasons.push('package-or-elf-cpu');
  const positiveLibc = owner.libc && owner.libc.filter(value => !value.startsWith('!'));
  const declaredLibc = positiveLibc && positiveLibc.length === 1 && ['glibc', 'musl'].includes(positiveLibc[0]) ? positiveLibc[0] : null;
  if (declaredLibc && elf.libc) assert.equal(declaredLibc, elf.libc, 'package/ELF libc disagreement');
  const libc = declaredLibc || elf.libc;
  if (!allows(owner.libc, 'musl') || libc === 'glibc') reasons.push('package-or-elf-libc');
  const state = reasons.length ? 'INCOMPATIBLE' : libc === 'musl' ? 'COMPATIBLE' : 'UNKNOWN';
  return { file, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, owner, elf, libc, state, reasons };
}
function assertActiveBinding(file, options) {
  const receipt = classifyNativeArtifact(file, options);
  assert.equal(receipt.state, 'COMPATIBLE', `active native binding is not proven ARM64/musl: ${receipt.owner.name}`);
  return receipt;
}
function resolveInstalledManifest(parentManifest, dependencyName, root) {
  assert(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(dependencyName), 'invalid dependency identity');
  const paths = createRequire(parentManifest).resolve.paths(dependencyName);
  for (const lookup of paths || []) {
    const candidate = path.join(lookup, dependencyName);
    if (!fs.existsSync(candidate)) continue;
    const ownerRoot = fs.realpathSync(candidate), manifest = path.join(ownerRoot, 'package.json');
    assert(contained(root, ownerRoot) && fs.existsSync(manifest), 'resolved dependency owner is not in deployed store');
    const resolvedManifest = fs.realpathSync(manifest);
    assert(contained(ownerRoot, resolvedManifest), 'dependency manifest escapes owner');
    return resolvedManifest;
  }
  return null;
}
function assertOptionalInactive(receipt, parentManifests, { root = '/app/node_modules/.pnpm', imageRoot = '/app' } = {}) {
  root = fs.realpathSync(root);
  imageRoot = fs.realpathSync(imageRoot);
  assert.equal(receipt.state, 'INCOMPATIBLE', 'only incompatible artifacts may request an inactive exemption');
  assert(parentManifests.length <= 30000, 'bounded dependency owner set required');
  const evidence = [];
  for (const parent of [...new Set(parentManifests.map(file => fs.realpathSync(file)))]) {
    assert(contained(imageRoot, parent) && fs.statSync(parent).isFile(), 'optional parent escapes deployed image');
    const metadata = JSON.parse(fs.readFileSync(parent, 'utf8'));
    const dependencyName = receipt.owner.name;
    const optional = metadata.optionalDependencies?.[dependencyName];
    const required = metadata.dependencies?.[dependencyName];
    if (optional === undefined && required === undefined) continue;
    assert(typeof metadata.name === 'string' && typeof metadata.version === 'string', 'dependency parent identity missing');
    const resolvedManifest = resolveInstalledManifest(parent, dependencyName, root);
    if (!resolvedManifest || path.dirname(resolvedManifest) !== receipt.owner.root) continue;
    const child = JSON.parse(fs.readFileSync(resolvedManifest, 'utf8'));
    assert.equal(child.name, dependencyName); assert.equal(child.version, receipt.owner.version);
    assert(required === undefined, 'incompatible artifact has a required deployed dependency owner');
    assert.equal(optional, child.version, 'inactive optional dependency must have an exact installed version pin');
    evidence.push({ parentManifest: parent, parentName: metadata.name, parentVersion: metadata.version,
      dependencyName, declaredVersion: optional, resolvedManifest, resolvedOwnerRoot: receipt.owner.root, relation: 'optionalDependencies' });
  }
  assert(evidence.length > 0, 'incompatible artifact lacks verified optional dependency ownership');
  return evidence;
}
async function sharpDispatcherProbe(manifest, { root = '/app/node_modules/.pnpm' } = {}) {
  root = fs.realpathSync(root); manifest = fs.realpathSync(manifest);
  const ownerRoot = path.dirname(manifest);
  assert(contained(root, manifest) && fs.statSync(manifest).isFile(), 'Sharp owner escapes store');
  const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(metadata.name, 'sharp'); assert.equal(metadata.version, '0.35.5');
  const ownerRequire = createRequire(manifest), entry = fs.realpathSync(ownerRequire.resolve('./'));
  assert(contained(ownerRoot, entry) && fs.statSync(entry).isFile(), 'Sharp entry escapes owner');
  const expectedName = '@img/sharp-linuxmusl-arm64';
  assert.equal(metadata.optionalDependencies?.[expectedName], metadata.version, 'Sharp optional binding pin mismatch');
  const bindingManifest = fs.realpathSync(ownerRequire.resolve(`${expectedName}/package`));
  assert(contained(root, bindingManifest) && fs.statSync(bindingManifest).isFile(), 'Sharp optional owner escapes store');
  const expectedRoot = path.dirname(bindingManifest), optional = JSON.parse(fs.readFileSync(bindingManifest, 'utf8'));
  assert.equal(optional.name, expectedName); assert.equal(optional.version, metadata.version);
  const sharp = ownerRequire(entry);
  const pixels = await sharp(Buffer.from([17, 31, 47]), { raw: { width: 1, height: 1, channels: 3 } })
    .resize(2, 2, { kernel: 'nearest' }).timeout({ seconds: 5 }).raw().toBuffer({ resolveWithObject: true });
  assert.equal(pixels.info.width, 2); assert.equal(pixels.info.height, 2); assert.equal(pixels.info.channels, 3);
  assert.deepEqual(pixels.data, Buffer.from([17, 31, 47, 17, 31, 47, 17, 31, 47, 17, 31, 47]));
  const selected = Object.keys(require.cache).filter(file => file.endsWith('.node') && contained(expectedRoot, fs.realpathSync(file)));
  assert.equal(selected.length, 1, 'one actual Sharp musl binding required');
  const binding = assertActiveBinding(selected[0], { root });
  assert.equal(binding.owner.root, expectedRoot); assert.equal(binding.owner.name, expectedName);
  assert.equal(binding.owner.version, metadata.version);
  return { relation: 'RETAINED_STORE_SHARP_OWNER', manifest, entry, version: metadata.version, bindingManifest, pixel: [...pixels.data], binding };
}
module.exports = { assertDumbInitVersion, classifyNativeArtifact, assertActiveBinding, assertOptionalInactive };
const report = { status: 'STARTED', packages: [], native: [], activeBindings: [] };
function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, files);
    else if (entry.isFile()) files.push(file);
  }
  return files;
}
async function fetchWithWget(url, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('wget', [...extra, '-qO-', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let data = '', errors = '';
    child.stdout.on('data', chunk => data += chunk);
    child.stderr.on('data', chunk => errors += chunk);
    const timer = setTimeout(() => { child.kill(); reject(new Error('wget fixture timeout')); }, 10000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(data) : reject(new Error(`wget failed ${code}: ${errors}`)); });
  });
}
async function fixture(server, protocol, extra = []) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { assert.equal(await fetchWithWget(`${protocol}://127.0.0.1:${server.address().port}/health`, extra), 'qualification-health'); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
async function signalProbe() {
  await new Promise((resolve, reject) => {
    const child = spawn('dumb-init', ['--', process.execPath, '-e',
      'process.on("SIGTERM",()=>{console.log("TERM_FORWARDED");process.exit(0)});console.log("READY");setInterval(()=>{},1000)'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', sent = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('signal fixture timeout')); }, 10000);
    child.on('error', reject);
    child.stdout.on('data', data => { output += data; if (!sent && output.includes('READY')) { sent = true; child.kill('SIGTERM'); } });
    child.on('close', code => { clearTimeout(timer); code === 0 && output.includes('TERM_FORWARDED') ? resolve() : reject(new Error('dumb-init did not forward SIGTERM')); });
  });
}
async function main() {
  const appRequire = createRequire('/app/apps/api/package.json');
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'arm64');
  assert.equal(process.version, 'v22.23.3'); assert.equal(process.getuid(), 1001); assert.equal(process.getgid(), 1001);
  assert(fs.existsSync('/lib/ld-musl-aarch64.so.1'), 'musl loader missing');
  assert(!process.report.getReport().header.glibcVersionRuntime, 'glibc runtime detected');
  assert.match(run('openssl', ['version']), /^OpenSSL 3\./);
  assert.match(run('wget', ['--version']), /GNU Wget/, 'GNU wget required');
  assertDumbInitVersion();
  const blocks = fs.readFileSync('/lib/apk/db/installed', 'utf8').split('\n\n');
  report.packages = blocks.filter(Boolean).map(block => Object.fromEntries(block.split('\n').filter(line => /^[PVo]:/.test(line)).map(line => [line[0], line.slice(2)])));
  assert(!report.packages.some(p => ['perl', 'util-linux'].includes(p.o || p.P)), 'Perl/util-linux origin unexpectedly installed');
  const zlib = report.packages.find(p => p.P === 'zlib'); assert(zlib, 'zlib absent');
  assert(['=', '>'].includes(run('apk', ['version', '-t', zlib.V, '1.3.2-r1']).trim()), 'zlib vendor fix missing');
  assert(fs.readFileSync('/app/apps/api/prisma/schema.prisma', 'utf8').includes('linux-musl-arm64-openssl-3.0.x'));
  const files = walk('/app/node_modules/.pnpm');
  const deployedManifests = files.filter(file => path.basename(file) === 'package.json');
  for (const parent of ['/app/apps/api/package.json', '/app/packages/shared/package.json', '/app/packages/meriv2-core/package.json', '/app/packages/defense-contracts/package.json', '/app/packages/defense-domain/package.json']) {
    if (fs.existsSync(parent)) deployedManifests.push(parent);
  }
  assert(deployedManifests.length <= 30000, 'bounded deployed package set required');
  const dependencyParents = new Map();
  for (const manifest of deployedManifests) {
    const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    for (const name of new Set([...Object.keys(metadata.dependencies || {}), ...Object.keys(metadata.optionalDependencies || {})])) {
      if (!dependencyParents.has(name)) dependencyParents.set(name, []);
      dependencyParents.get(name).push(manifest);
    }
  }
  const engines = files.filter(file => /(?:libquery_engine|schema-engine).*linux-musl-arm64-openssl-3\.0\.x/.test(path.basename(file)));
  assert(engines.some(file => file.endsWith('.so.node')), 'musl query engine absent');
  assert(engines.some(file => path.basename(file).startsWith('schema-engine')), 'musl migration engine absent');
  assert(!files.some(file => /(?:libquery_engine|schema-engine).*linux-arm64-openssl-3\.0\.x/.test(path.basename(file))), 'glibc Prisma engine retained');
  for (const file of engines.filter(file => path.basename(file).startsWith('schema-engine'))) assert.match(run(file, ['--version']), /schema-engine/);
  const cli = fs.realpathSync('/app/apps/api/node_modules/prisma/build/index.js');
  assert.match(run(process.execPath, [cli, '--version']), /5\.22\.0/);
  for (const verb of ['status', 'deploy']) assert.match(run(process.execPath, [cli, 'migrate', verb, '--help']), /migrate/);
  // Inventory actual owners and ELF evidence before loading compatible raw addons.
  for (const file of files.filter(file => file.endsWith('.node'))) {
    const receipt = classifyNativeArtifact(file);
    report.native.push({ file: receipt.file, sha256: receipt.sha256, bytes: receipt.bytes, state: 'NOT_LOADED', classification: receipt });
    if (receipt.state === 'INCOMPATIBLE') {
      report.native[report.native.length - 1].optionalEvidence = assertOptionalInactive(receipt, dependencyParents.get(receipt.owner.name) || []);
      report.native[report.native.length - 1].state = 'INACTIVE_INCOMPATIBLE_OPTIONAL'; continue;
    }
    assert.equal(receipt.state, 'COMPATIBLE', `native libc is unestablished: ${receipt.owner.name}`);
    run(process.execPath, ['-e', 'require(process.argv[1])', file]);
    report.native[report.native.length - 1].state = 'LOADED';
  }
  // Exercise real application dispatchers, not only raw binding files.
  const pdfRequire = createRequire(appRequire.resolve('pdf-parse'));
  const canvas = pdfRequire('@napi-rs/canvas');
  assert.equal(canvas.createCanvas(2, 2).width, 2);
  const tsxRequire = createRequire(appRequire.resolve('tsx'));
  assert(tsxRequire('esbuild').transformSync('const value: number = 1', { loader: 'ts' }).code);
  const sharpOwners = files.filter(file => path.basename(file) === 'package.json' && path.basename(path.dirname(file)) === 'sharp');
  assert(sharpOwners.length > 0 && sharpOwners.length <= 8, 'bounded deployed Sharp owner set required');
  report.sharp = [];
  for (const manifest of sharpOwners) report.sharp.push(await sharpDispatcherProbe(manifest));
  appRequire('sanitize-html'); appRequire('./dist/meri/meri-tools.service.js'); appRequire('./dist/memory/memory-candidate.service.js');
  run(process.execPath, ['--no-enable-source-maps', '--check', '/app/apps/api/dist/main.js']);
  report.activeBindings = Object.keys(require.cache).filter(file => file.endsWith('.node')).map(file => assertActiveBinding(file));
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'core-alpine-probe-'));
  try {
    fs.writeFileSync(path.join(scratch, 'writable'), 'ok');
    // Confirm unchanged entrypoint dispatch without executing the API or a database command.
    const stubDir = '/qualification/dispatch-fixture';
    const dispatch = execFileSync('/usr/local/bin/entrypoint.sh', ['serve'], {
      encoding: 'utf8', timeout: 10000,
      env: { PATH: `${stubDir}:${process.env.PATH}`, TMPDIR: scratch, NODE_ENV: 'test',
        DB_HOST: '127.0.0.1', DB_PORT: '9', DB_USER: 'qualification', DB_PASSWORD: 'fixture-only', DB_NAME: 'qualification' },
    });
    assert.match(dispatch, /QUALIFICATION_SERVE_DISPATCH/);
    report.startup = 'ENTRYPOINT_DISPATCH_ONLY; full API readiness requires isolated fixture qualification';
    if (!process.argv.includes('--static')) {
      const ownedRoot = fs.statSync('/app/tmp');
      assert.equal(ownedRoot.uid, 1001); assert(ownedRoot.mode & 0o200, 'probe needs a normally writable owned directory');
      assert.throws(() => fs.writeFileSync('/app/tmp/.qualification-rootfs-write', 'must fail'),
        error => error.code === 'EROFS', 'run with read-only rootfs; EACCES is not proof');
      await fixture(http.createServer((req, res) => res.end('qualification-health')), 'http');
      const key = path.join(scratch, 'fixture.key'), cert = path.join(scratch, 'fixture.crt');
      run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert]);
      await fixture(https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => res.end('qualification-health')), 'https', ['--ca-certificate', cert]);
      await signalProbe(); report.signal = 'SIGTERM_FORWARDED';
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  report.status = 'PASS'; report.mode = process.argv.includes('--static') ? 'STATIC_NATIVE' : 'OFFLINE_RUNTIME';
  console.log(JSON.stringify(report, null, 2));
}
if (require.main === module) main().catch(error => { report.status = 'FAIL'; report.error = error.message; console.error(JSON.stringify(report, null, 2)); process.exitCode = 1; });
