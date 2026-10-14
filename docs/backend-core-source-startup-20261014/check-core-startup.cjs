// Source-only, non-listening Core qualification. Run with no supplied secrets.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const arg = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const sourceHead = arg('source-head', '9b9f98d86aebe79721b3655e5a619b27be9a43e9');
const sourceTree = arg('source-tree', '8e715d78793b5e2642f67cd7bfa8c0f3c373b336');
if (!/^[a-f0-9]{40}$/.test(sourceHead) || !/^[a-f0-9]{40}$/.test(sourceTree) || sourceHead === 'e01e3b72aa0e26f4d2a9ad65533da1d561920aca') throw new Error('INVALID_SOURCE_PIN');
const executeGit = cp.execFileSync.bind(cp);
const git = (...args) => executeGit('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
if (git('rev-parse', `${sourceHead}^{tree}`).toString().trim() !== sourceTree) throw new Error('SOURCE_TREE_MISMATCH');
const manifest = new Map(git('ls-tree', '-rz', '--full-tree', sourceHead).toString().split('\0').filter(Boolean).map((line) => {
  const [metadata, name] = line.split('\t');
  const [mode, kind, blob] = metadata.split(' ');
  return [name, { mode, kind, blob }];
}));
if (manifest.get('apps/api/src/engagement/engagement.service.ts')?.blob !== '6eb8259f7eb77f64c6ab41d403480ac1ea3f1e82') throw new Error('PUBLISHED_ENGAGEMENT_MISMATCH');
const readSource = (name) => {
  const item = manifest.get(name);
  if (!item || item.kind !== 'blob' || item.mode !== '100644') throw new Error(`SOURCE_NOT_BOUND:${name}`);
  return git('cat-file', 'blob', item.blob).toString();
};
const sourceRows = [], events = [], denied = [], asyncErrors = [], externalModules = new Map();
process.on('unhandledRejection', (e) => { asyncErrors.push({ message: e?.message ?? String(e), stack: e?.stack }); });
const ts = require(require.resolve('typescript', { paths: [path.join(root, 'apps/api')] }));
const apiRequire = Module.createRequire(path.join(root, 'apps/api/package.json'));
const configs = new Map();
const parseConfig = (name) => {
  const result = ts.parseConfigFileTextToJson(name, readSource(name));
  if (result.error) throw new Error(`CONFIG_PARSE_FAILED:${name}`);
  return result.config;
};
const baseOptions = parseConfig('tsconfig.base.json').compilerOptions;
const compilerOptions = (name) => {
  const owner = name.startsWith('apps/api/') ? 'apps/api' : name.split('/').slice(0, 2).join('/');
  if (!configs.has(owner)) {
    const raw = { ...baseOptions, ...parseConfig(`${owner}/tsconfig.json`).compilerOptions,
      incremental: false, composite: false, declaration: false, declarationMap: false, sourceMap: false };
    const converted = ts.convertCompilerOptionsFromJson(raw, path.join(root, owner));
    if (converted.errors.length) throw new Error(`COMPILER_OPTIONS_FAILED:${owner}`);
    configs.set(owner, converted.options);
  }
  return configs.get(owner);
};
const packages = new Map();
for (const name of manifest.keys()) if (/^packages\/[^/]+\/package.json$/.test(name)) {
  const pkg = JSON.parse(readSource(name));
  packages.set(pkg.name, { base: path.dirname(name), pkg });
}
// ConfigModule reads cwd/.env by default. Use a new owned empty cwd and deny sensitive reads.
const fixtureCwd = fs.mkdtempSync(path.join(root, '.qualification-cache/core-startup-'));
process.chdir(fixtureCwd);
for (const key of Object.keys(process.env)) delete process.env[key];
const fixtureEnv = Object.freeze({
  NODE_ENV: 'development', DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
  CLERK_SECRET_KEY: 'sk_test_Zml4dHVyZS5pbnZhbGlkJA', CLERK_WEBHOOK_SIGNING_SECRET: 'fixture-unusable',
  CLERK_JWT_ISSUER: 'https://fixture.invalid', CAPIRO_SERVICE_NAME: 'api',
  ENGAGEMENT_PROCESS_MODE: 'shadow', ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
  ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled', ENGAGEMENT_CALLBACKS_ENABLED: 'false',
  ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false', ENGAGEMENT_AUTO_SYNC: 'false',
  OUTREACH_ASYNC_GEN: 'false', OUTREACH_ASYNC_SEND: 'false',
  CLIENT_PROFILE_FILL_WORKER_ENABLED: 'false', CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED: 'false',
  AWS_EC2_METADATA_DISABLED: 'true', DIRECTORY_S3_BUCKET: 'fixture-never-read',
  AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1',
  AWS_CONFIG_FILE: path.join(fixtureCwd, 'absent-sdk-config.ini'),
  AWS_SHARED_CREDENTIALS_FILE: path.join(fixtureCwd, 'absent-sdk-credentials.ini'),
});
Object.assign(process.env, fixtureEnv);
const deny = (edge) => {
  denied.push({ edge, stack: new Error().stack });
  throw new Error(`SOURCE_ONLY_IO_DENIED:${edge}`);
};
for (const name of ['node:http', 'node:https']) for (const method of ['request', 'get']) require(name)[method] = () => deny(`${name}.${method}`);
const net = require('node:net');
net.connect = net.createConnection = net.Socket.prototype.connect = () => deny('socket.connect');
net.Server.prototype.listen = () => deny('server.listen');
require('node:tls').connect = () => deny('tls.connect');
require('node:http2').connect = () => deny('http2.connect');
const dgram = require('node:dgram');
dgram.Socket.prototype.connect = dgram.Socket.prototype.send = () => deny('dgram.send');
const dns = require('node:dns');
for (const key of Object.keys(dns)) if (typeof dns[key] === 'function') dns[key] = () => deny(`dns.${key}`);
for (const key of Object.keys(dns.promises)) dns.promises[key] = async () => deny(`dns.promises.${key}`);
globalThis.fetch = async () => deny('fetch');
for (const method of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) cp[method] = () => deny(`child_process.${method}`);
const activeTimers = new Map();
const originalTimeout = globalThis.setTimeout, originalInterval = globalThis.setInterval;
const originalClearTimeout = globalThis.clearTimeout, originalClearInterval = globalThis.clearInterval;
globalThis.setTimeout = function(callback, ms, ...args) {
  const stack = new Error().stack;
  let id;
  id = originalTimeout((...values) => { activeTimers.delete(id); callback(...values); }, ms, ...args);
  activeTimers.set(id, { kind: 'timeout', ms, stack });
  return id;
};
globalThis.setInterval = function(callback, ms, ...args) {
  const id = originalInterval(callback, ms, ...args);
  activeTimers.set(id, { kind: 'interval', ms, stack: new Error().stack });
  return id;
};
globalThis.clearTimeout = function(id) { activeTimers.delete(id); return originalClearTimeout(id); };
globalThis.clearInterval = function(id) { activeTimers.delete(id); return originalClearInterval(id); };
const protectFileMethod = (owner, method) => {
  const original = owner[method];
  owner[method] = function(file, ...args) {
    const name = typeof file === 'string' ? file : file instanceof URL ? file.pathname : '';
    if (/(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.aws|credentials)(?:[\\/]|$)/.test(name)) return deny('sensitive-file-read');
    return original.call(this, file, ...args);
  };
};
for (const method of ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream']) protectFileMethod(fs, method);
for (const method of ['readFile', 'open']) protectFileMethod(fs.promises, method);
// Preserve the generated Prisma namespace/DMMF/enums; replace only its native connection/query edge.
const realPrisma = apiRequire('@prisma/client');
const prismaEntry = apiRequire.resolve('@prisma/client');
const prismaSchema = path.join(path.dirname(prismaEntry), 'schema.prisma');
if (digest(fs.readFileSync(prismaSchema)) !== '215556bd82b97f0be84d7f97da7f19a5a25bace97dc54b1a550cab2039a740fb') throw new Error('CACHED_CORE_SCHEMA_MISMATCH');
externalModules.set(prismaEntry, true);
class InertPrismaClient {
  constructor() { events.push({ edge: 'PrismaClient.construct' }); }
  async $connect() { events.push({ edge: 'PrismaClient.connect.inert' }); }
  async $disconnect() { events.push({ edge: 'PrismaClient.disconnect.inert' }); }
  $extends() { return this; }
  $transaction() { return deny('PrismaClient.transaction'); }
  $queryRaw() { return deny('PrismaClient.queryRaw'); }
  $queryRawUnsafe() { return deny('PrismaClient.queryRawUnsafe'); }
  $executeRaw() { return deny('PrismaClient.executeRaw'); }
  $executeRawUnsafe() { return deny('PrismaClient.executeRawUnsafe'); }
}
const originalResolve = Module._resolveFilename, originalLoad = Module._load;
const sourceCandidate = (name) => {
  for (const item of [name, name.replace(/\.js$/, '.ts'), `${name}.ts`, `${name}/index.ts`]) if (manifest.has(item)) return path.join(root, item);
  throw new Error(`SOURCE_DEPENDENCY_MISSING:${name}`);
};
Module._resolveFilename = function(request, parent, ...rest) {
  if (path.isAbsolute(request) && request.startsWith(root + path.sep)) {
    const candidate = path.relative(root, request).split(path.sep).join('/');
    if (/^(apps\/api\/src|packages\/[^/]+\/src)\//.test(candidate)) return sourceCandidate(candidate);
  }
  if (request.startsWith('@capiro/')) {
    const [scope, pkgName, ...sub] = request.split('/');
    const entry = packages.get(`${scope}/${pkgName}`);
    if (!entry) throw new Error(`WORKSPACE_PACKAGE_MISSING:${request}`);
    const key = sub.length ? `./${sub.join('/')}` : '.';
    const exp = entry.pkg.exports?.[key];
    const target = typeof exp === 'string' ? exp : exp?.require ?? exp?.default ?? (key === '.' ? entry.pkg.main : undefined);
    if (!target || !target.startsWith('./dist/')) throw new Error(`WORKSPACE_EXPORT_MISSING:${request}`);
    return sourceCandidate(path.posix.join(entry.base, target.replace('./dist/', './src/')));
  }
  if (request.startsWith('.') && parent?.filename?.startsWith(root + path.sep) && !parent.filename.includes('/node_modules/')) {
    const candidate = path.relative(root, path.resolve(path.dirname(parent.filename), request)).split(path.sep).join('/');
    if (/^(apps\/api\/src|packages\/[^/]+\/src)\//.test(candidate)) return sourceCandidate(candidate);
  }
  let resolvingParent = parent;
  if (!request.startsWith('.') && parent?.filename?.startsWith(path.join(root, 'packages') + path.sep)) {
    const packageName = path.relative(path.join(root, 'packages'), parent.filename).split(path.sep)[0];
    const cacheRoot = path.join('/workspace/capirov2/packages', packageName);
    resolvingParent = { ...parent, paths: Module._nodeModulePaths(cacheRoot) };
  }
  const resolved = originalResolve.call(this, request, resolvingParent, ...rest);
  if (typeof resolved === 'string' && resolved.includes('/node_modules/')) externalModules.set(resolved, true);
  return resolved;
};
Module._load = function(request, parent, ...rest) {
  if (request === '@prisma/client') return { ...realPrisma, PrismaClient: InertPrismaClient };
  const result = originalLoad.call(this, request, parent, ...rest);
  if (request === 'undici') for (const method of ['fetch', 'request', 'stream', 'pipeline', 'connect', 'upgrade']) if (typeof result[method] === 'function') result[method] = () => deny(`undici.${method}`);
  if (/^@aws-sdk\/client-/.test(request)) for (const [name, value] of Object.entries(result)) {
    if (name.endsWith('Client') && typeof value === 'function' && value.prototype?.send) value.prototype.send = async function(command) {
      const edge = `${name}.send:${command.constructor.name}`;
      const stack = new Error().stack;
      if (name === 'S3Client' && command.constructor.name === 'GetObjectCommand' && stack.includes('/directory/directory.service.ts:')) {
        events.push({ edge, expectedDenial: true, stack });
        throw new Error('SOURCE_ONLY_DIRECTORY_PREWARM_DENIED');
      }
      return deny(edge);
    };
  }
  return result;
};
Module._extensions['.ts'] = function(module, filename) {
  const name = path.relative(root, filename).split(path.sep).join('/');
  if (!/^(apps\/api\/src|packages\/[^/]+\/src)\//.test(name) || /\.spec\.ts$/.test(name)) throw new Error(`SOURCE_SCOPE_DENIED:${name}`);
  const source = readSource(name);
  const result = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
    compilerOptions: compilerOptions(name) });
  if (result.diagnostics?.length) throw new Error(`TRANSPILE_DIAGNOSTICS:${name}`);
  sourceRows.push({ path: name, ...manifest.get(name), sourceSha256: digest(source), emittedSha256: digest(result.outputText) });
  module._compile(result.outputText, filename);
};
async function run() {
  let app, gateway, rawAi, beforeAiDescriptors, phase = 'import', error, modules = [], routes = [], checks = [];
  const fencedFetch = globalThis.fetch;
  const check = (name, passed) => { checks.push({ name, passed: !!passed }); if (!passed) throw new Error(`CHECK_FAILED:${name}`); };
  try {
    apiRequire('reflect-metadata');
    const policy = require(sourceCandidate('apps/api/src/meri/meri-policy-pack-runtime.ts'));
    policy.disablePersistedMeriPolicyPackEnforcement();
    const env = require(sourceCandidate('apps/api/src/engagement/runtime/engagement-runtime-env.ts'));
    env.assertEngagementRuntimeEnvironment(process.env);
    const { AppModule } = require(sourceCandidate('apps/api/src/app.module.ts'));
    const { MeetingsContextPlaneRuntime } = require(sourceCandidate('apps/api/src/context/meetings-context-plane.runtime.ts'));
    const originalInstall = MeetingsContextPlaneRuntime.prototype.install;
    MeetingsContextPlaneRuntime.prototype.install = function(...args) {
      const result = originalInstall.apply(this, args);
      events.push({ edge: 'MeetingsContextPlaneRuntime.install', ...result });
      return result;
    };
    const { NestFactory } = apiRequire('@nestjs/core');
    phase = 'construct';
    app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], abortOnError: false });
    const { RAW_ENGAGEMENT_AI_SERVICE } = require(sourceCandidate('apps/api/src/engagement/governed-meeting-ai.factory.ts'));
    rawAi = app.get(RAW_ENGAGEMENT_AI_SERVICE);
    beforeAiDescriptors = ['generateMeetingPrep', 'generateMeetingDebrief'].map((name) => Object.getOwnPropertyDescriptor(rawAi, name));
    app.enableShutdownHooks();
    const http = require(sourceCandidate('apps/api/src/bootstrap/configure-api-http-app.ts'));
    http.configureApiHttpApp(app, { includeClerkRawBody: true, includeRecallRawBody: true,
      includeTangoRawBody: true, includeEmailSignatureLargeBody: true, defaultJsonLimit: '1mb' });
    phase = 'init';
    await app.init();
    await new Promise((resolve) => setImmediate(resolve));
    modules = [...app.container.getModules().values()].map((m) => ({ name: m.metatype?.name,
      providers: [...m.providers.values()].map((p) => ({ name: p.metatype?.name, instantiated: p.instance != null })),
      controllers: [...m.controllers.values()].map((p) => p.metatype?.name) }));
    routes = app.getHttpAdapter().getInstance()._router.stack.filter((x) => x.route).map((x) => ({ path: x.route.path, methods: Object.keys(x.route.methods) }));
    for (const name of ['AppModule', 'EngagementModule', 'EngagementWorkersModule', 'MeriModule',
      'MeriMobileModule', 'WorkspaceAssistantModule', 'WorkspaceCollabModule', 'ApplicationAuthorityModule',
      'ClientsModule', 'UsersModule', 'FederalRegisterModule', 'TenantAdminModule']) check(`actual module ${name}`, modules.some((m) => m.name === name));
    for (const [route, method] of [['/api/clio/application-authority/identity', 'post'], ['/api/clio/application-authority/context', 'post'],
      ['/api/clients/:clientId/objectives', 'get'], ['/api/clients/:clientId/account-owners', 'put'], ['/api/federal-register/effective-date-calendar', 'get']])
      check(`actual route ${method} ${route}`, routes.some((r) => r.path === route && r.methods.includes(method)));
    check('staging remains on separate existing Engagement origin', !routes.some((r) => String(r.path).includes('newsletter-staging')));
    const { NewsletterAccountProvider } = require(sourceCandidate('apps/api/src/workspace-collab/newsletter-account-provider.ts'));
    const { TenantAdminService } = require(sourceCandidate('apps/api/src/tenant-admin/tenant-admin.service.ts'));
    check('Newsletter uses existing single TenantAdminService', app.get(NewsletterAccountProvider).team === app.get(TenantAdminService));
    const { EngagementService } = require(sourceCandidate('apps/api/src/engagement/engagement.service.ts'));
    const { RAW_ENGAGEMENT_SERVICE } = require(sourceCandidate('apps/api/src/engagement/governed-engagement.factory.ts'));
    check('published real EngagementService retained', app.get(RAW_ENGAGEMENT_SERVICE) instanceof EngagementService);
    const { MeriService } = require(sourceCandidate('apps/api/src/meri/meri.service.ts'));
    const { RAW_MERI_SERVICE } = require(sourceCandidate('apps/api/src/meri/meriv3-runtime.proxy.ts'));
    check('real MeriService retained', app.get(RAW_MERI_SERVICE) instanceof MeriService);
    const { ContextPlaneGatewayService } = require(sourceCandidate('apps/api/src/context/context-plane-gateway.service.ts'));
    gateway = app.get(ContextPlaneGatewayService);
    check('existing Meetings runtime installed', gateway.meetingsRuntime?.installed === true);
    const install = events.find((e) => e.edge === 'MeetingsContextPlaneRuntime.install');
    check('existing Meetings wrappers installed', install?.aiMethodsPatched === 2 && install?.callersPatched > 0);
    check('existing Meetings fetch wrapper installed', globalThis.fetch !== fencedFetch);
    const { EngagementAiService } = require(sourceCandidate('apps/api/src/engagement/engagement-ai.service.ts'));
    let publicDenied = false, rawDenied = false;
    try { await app.get(EngagementAiService).generateMeetingPrep({ meeting: {}, client: null }); }
    catch(e) {
      events.push({ edge: 'public AI refusal', message: e.message, status: e.getStatus?.() });
      publicDenied = e.message === 'phase24_meeting_context_plane_bundle_required';
    }
    check('public AI retains governed context refusal before I/O', publicDenied);
    try { await rawAi.generateMeetingPrep({ meeting: {}, client: null }); }
    catch(e) {
      events.push({ edge: 'raw AI runtime refusal', message: e.message, status: e.getStatus?.() });
      rawDenied = e.getStatus?.() === 503;
    }
    check('raw alias retains existing disabled runtime refusal before I/O', rawDenied);
    phase = 'close';
  } catch (e) { error = { message: e.message, stack: e.stack }; }
  finally { if (app) { try { await app.close(); } catch(e) { error ??= { message: e.message, stack: e.stack }; } } }
  if (gateway) {
    try { check('existing Meetings runtime restored on close', gateway.meetingsRuntime === null && globalThis.fetch === fencedFetch); }
    catch(e) { error ??= { message: e.message, stack: e.stack }; }
    try { check('existing shared AI method descriptors restored on close', ['generateMeetingPrep', 'generateMeetingDebrief'].every((name, i) =>
      Object.getOwnPropertyDescriptor(rawAi, name)?.value === beforeAiDescriptors[i]?.value &&
      Object.hasOwn(rawAi, name) === (beforeAiDescriptors[i] !== undefined))); }
    catch(e) { error ??= { message: e.message, stack: e.stack }; }
  }
  await new Promise((resolve) => originalTimeout(resolve, 100));
  const remainingTimers = [...activeTimers.values()];
  for (const id of activeTimers.keys()) { originalClearTimeout(id); originalClearInterval(id); }
  const dependencyRows = [...externalModules.keys()].sort().map((name) => ({ path: name, sha256: digest(fs.readFileSync(name)) }));
  const report = { result: 'held', phase, sourceHead, sourceTree,
    qualification: 'Actual source business graph; non-listening synthetic inert I/O fixture. Transpile/runtime only; no full strict types, native database/RLS, provider or image acceptance.',
    fixtureEnv, compilerOptions: Object.fromEntries(configs), sourceLockBlob: manifest.get('pnpm-lock.yaml').blob,
    cachedPrismaSchemaSha256: digest(fs.readFileSync(prismaSchema)), sourceRows, dependencyRows, events, denied, asyncErrors, remainingTimers, checks, modules, routes, error };
  process.once('beforeExit', () => {
    report.result = !error && !asyncErrors.length && !denied.length && !remainingTimers.length && modules.length && checks.every((c) => c.passed) ? 'pass' : 'held';
    process.stdout.write('QUALIFICATION_REPORT\n' + JSON.stringify(report, null, 2) + '\n');
    if (report.result !== 'pass') process.exitCode = 1;
  });
}
run().catch((e) => { process.stderr.write(e.stack + '\n'); process.exitCode = 1; });
