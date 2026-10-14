/* Offline qualification only. No database clients, migration execution or secrets. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 30000 });
function assertDumbInitVersion(file = 'dumb-init', args = ['--version'], { timeout = 30000 } = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'dumb-init version command must exit successfully');
  assert.match(result.stdout + result.stderr, /dumb-init v?1\.2\.5/);
}
module.exports = { assertDumbInitVersion };
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
  const engines = files.filter(file => /(?:libquery_engine|schema-engine).*linux-musl-arm64-openssl-3\.0\.x/.test(path.basename(file)));
  assert(engines.some(file => file.endsWith('.so.node')), 'musl query engine absent');
  assert(engines.some(file => path.basename(file).startsWith('schema-engine')), 'musl migration engine absent');
  assert(!files.some(file => /(?:libquery_engine|schema-engine).*linux-arm64-openssl-3\.0\.x/.test(path.basename(file))), 'glibc Prisma engine retained');
  for (const file of engines.filter(file => path.basename(file).startsWith('schema-engine'))) assert.match(run(file, ['--version']), /schema-engine/);
  const cli = fs.realpathSync('/app/apps/api/node_modules/prisma/build/index.js');
  assert.match(run(process.execPath, [cli, '--version']), /5\.22\.0/);
  for (const verb of ['status', 'deploy']) assert.match(run(process.execPath, [cli, 'migrate', verb, '--help']), /migrate/);
  // Load every active native addon in its own offline process; inventory GNU optionals.
  for (const file of files.filter(file => file.endsWith('.node'))) {
    if (/-gnu(?:@|\/|_)/.test(file)) { report.native.push({ file, state: 'INACTIVE_GNU_OPTIONAL' }); continue; }
    const header = fs.readFileSync(file).subarray(0, 20);
    assert.equal(header.subarray(0, 4).toString('hex'), '7f454c46', `not ELF: ${file}`);
    assert.equal(header.readUInt16LE(18), 183, `not ARM64: ${file}`);
    run(process.execPath, ['-e', 'require(process.argv[1])', file]);
    report.native.push({ file, state: 'LOADED' });
  }
  // Exercise real application dispatchers, not only raw binding files.
  const pdfRequire = createRequire(appRequire.resolve('pdf-parse'));
  const canvas = pdfRequire('@napi-rs/canvas');
  assert.equal(canvas.createCanvas(2, 2).width, 2);
  const tsxRequire = createRequire(appRequire.resolve('tsx'));
  assert(tsxRequire('esbuild').transformSync('const value: number = 1', { loader: 'ts' }).code);
  appRequire('sanitize-html'); appRequire('./dist/meri/meri-tools.service.js'); appRequire('./dist/memory/memory-candidate.service.js');
  run(process.execPath, ['--no-enable-source-maps', '--check', '/app/apps/api/dist/main.js']);
  report.activeBindings = Object.keys(require.cache).filter(file => file.endsWith('.node'));
  assert(report.activeBindings.every(file => !/-gnu(?:@|\/|_)/.test(file)), 'dispatcher selected GNU binding');
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
