#!/usr/bin/env node
'use strict';

// Offline packaging qualification only. Never constructs an application or DB pool.
// Usage: node alpine-service-probe.cjs <intel-api|api-strategy|workspace|engagement-api>
// Exit 0: checks passed; 1: failed check; 64: unsupported/missing service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const service = process.argv[2];
if (process.argv.length !== 3 || !['intel-api', 'api-strategy', 'workspace', 'engagement-api'].includes(service)) {
  console.error('Usage: node alpine-service-probe.cjs <intel-api|api-strategy|workspace|engagement-api>');
  process.exit(64);
}
const local = createRequire(path.join(process.cwd(), 'package.json'));
const run = (file, args) => execFileSync(file, args, {
  encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 1001, 'runtime must run as capiro');
const musl = process.arch === 'x64' ? 'linux-musl-openssl-3.0.x'
  : process.arch === 'arm64' ? 'linux-musl-arm64-openssl-3.0.x' : null;
assert(musl, 'unsupported architecture');
assert(fs.existsSync(process.arch === 'x64' ? '/lib/ld-musl-x86_64.so.1' : '/lib/ld-musl-aarch64.so.1'));
assert(fs.existsSync('/usr/bin/dumb-init'));
assert.match(run('openssl', ['version']), /^OpenSSL 3\./);
for (const manager of ['npm', 'corepack']) {
  assert(!fs.existsSync(`/usr/local/lib/node_modules/${manager}`), `${manager} must not ship`);
  assert(!fs.existsSync(`/usr/local/bin/${manager}`), `${manager} command must not ship`);
}
if (service !== 'engagement-api') {
  // The unchanged migrate verbs need the local CLI, never global npm/npx.
  assert.match(run(process.execPath, [local.resolve('prisma/build/index.js'), '--help']), /migrate/);
}
for (const match of fs.readFileSync('/usr/local/bin/entrypoint.sh', 'utf8').matchAll(/\bnode (dist\/[^\s"'$;]+)/g)) {
  run(process.execPath, ['--check', local.resolve(`./${match[1]}`)]);
}

const clientPath = service === 'engagement-api'
  ? local.resolve('.prisma/client/default', { paths: [path.dirname(local.resolve('@prisma/client'))] })
  : local.resolve('./generated/prisma-client');
const clientRoot = path.dirname(clientPath);
const client = local(clientPath);
assert.equal(typeof client.PrismaClient, 'function');
const enginePath = path.join(clientRoot, `libquery_engine-${musl}.so.node`);
assert(fs.existsSync(enginePath), 'exact musl/OpenSSL3 Prisma engine required');
assert.equal(typeof local(enginePath).QueryEngine, 'function', 'native engine must load');
for (const name of fs.readdirSync(clientRoot)) {
  assert(!/libquery_engine-(?:debian|linux-arm64-openssl)/.test(name), 'glibc engine leaked into runtime');
}

if (service === 'workspace' || service === 'engagement-api') {
  const sanitize = local('sanitize-html');
  assert.equal(sanitize('<strong>safe</strong><script>unsafe</script>'), '<strong>safe</strong>');
}
if (service === 'workspace') {
  local('sharp');
  local('./dist/versions/versions.service.js');
} else if (service === 'api-strategy') {
  local('@capiro/auth');
  local('@capiro/strategy-verifier');
  local('playwright-core');
  assert.match(run(process.env.STRATEGY_PDF_CHROMIUM_PATH || '/usr/bin/chromium', ['--version']), /Chromium 155\./);
} else if (service === 'engagement-api') {
  // engagement-main.ts compiles at dist/ and imports the sibling app module.
  // Loading that module validates real production config at import time; use
  // explicit nonsecret shadow fixtures without constructing Nest or a DB pool.
  Object.assign(process.env, {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
    CLERK_SECRET_KEY: 'synthetic-packaging-probe-not-a-credential',
    CLERK_JWT_ISSUER: 'https://synthetic.invalid',
    CAPIRO_SERVICE_NAME: 'engagement-api',
    ENGAGEMENT_PROCESS_MODE: 'shadow',
    ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
    ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
    ENGAGEMENT_CALLBACKS_ENABLED: 'false',
    ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
  });
  const entrypoint = local.resolve('./dist/engagement-main.js');
  run(process.execPath, ['--check', entrypoint]);
  assert.match(fs.readFileSync(entrypoint, 'utf8'), /require\(["']\.\/engagement-api\.app\.module\.js["']\)/);
  const { EngagementApiAppModule } = local('./dist/engagement-api.app.module.js');
  assert.equal(typeof EngagementApiAppModule, 'function');
  local('./dist/bootstrap/configure-api-http-app.js');
  const { assertEngagementRuntimeEnvironment } = local('./dist/engagement/runtime/engagement-runtime-env.js');
  assert.equal(assertEngagementRuntimeEnvironment(process.env).serviceName, 'engagement-api');
} else {
  local('./dist/hearing/capture/ffmpeg-audio-command.js');
  assert.match(run('ffmpeg', ['-version']), /^ffmpeg version 8\.1\.2/);
  assert.match(run('ffprobe', ['-version']), /^ffprobe version 8\.1\.2/);
  const protocols = run('ffmpeg', ['-hide_banner', '-protocols']);
  for (const protocol of ['https', 'tls', 'tcp', 'crypto', 'pipe']) {
    assert(new RegExp(`^\\s*${protocol}\\s*$`, 'm').test(protocols), `missing ${protocol} protocol`);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'alpine-hearing-'));
  try {
    const input = path.join(scratch, 'synthetic.webm');
    const output = path.join(scratch, 'playable.webm');
    run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:a', 'libopus', '-f', 'webm', input]);
    // The recording assembler's copy/remux, full decode, and duration probes.
    run('ffmpeg', ['-nostdin', '-v', 'error', '-i', input, '-map', '0:a:0', '-vn',
      '-c:a', 'copy', '-cues_to_front', '1', '-f', 'webm', output]);
    run('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', output, '-map', '0:a:0', '-f', 'null', '-']);
    const duration = Number(JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'json', output])).format.duration);
    assert(duration >= 1 && duration < 1.2, 'synthetic recording duration');
    const pcm = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', input, '-map', '0:a:0?',
      '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-f', 's16le', 'pipe:1'],
    { timeout: 20_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    assert(pcm.length >= 30_000 && pcm.length <= 34_000, '16kHz mono PCM decode');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ service, architecture: process.arch, prismaTarget: musl, offlinePackaging: 'PASS' }));
