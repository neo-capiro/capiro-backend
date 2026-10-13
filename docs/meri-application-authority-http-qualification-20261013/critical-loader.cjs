'use strict';
// Test host only. Whole critical files are evaluated; unrelated imports are
// replaced before any source read. This is not a full application bootstrap.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const vm = require('node:vm');
const API_ROOT = '/workspace/capirov2-meri-http-qualified-20261013/apps/api';
const cacheRequire = Module.createRequire('/workspace/capirov2/apps/api/package.json');
const ts = cacheRequire('typescript');
const common = cacheRequire('@nestjs/common');
const configPackage = cacheRequire('@nestjs/config');
cacheRequire('reflect-metadata');
const SOURCE_HEAD = 'bbb38185058fdc64c204da723943aee055b3dad3';
const CRITICAL = [
  'app.module.ts', 'auth/auth.module.ts', 'auth/clerk.service.ts',
  'auth/application-authority.ts', 'auth/clerk-role.util.ts',
  'auth/roles.guard.ts', 'auth/roles.decorator.ts',
  'tenant/tenant.module.ts', 'tenant/tenant-context.middleware.ts',
  'tenant/tenant-context.store.ts', 'tenant/current-tenant.decorator.ts',
  'prisma/prisma.module.ts', 'prisma/prisma.service.ts',
  'context/context.module.ts', 'context/context-security-scope.service.ts',
  'context/context.types.ts', 'context/context-persistence-boundary.service.ts',
  'context/context-persistence-boundary.interceptor.ts',
  'meri/meri.module.ts', 'meri/meri.controller.ts', 'meri/meri.service.ts',
  'meri/meriv3-runtime.proxy.ts', 'meri/meri-circuit-breaker.ts',
  'meri/meri-prospect-scope.helpers.ts',
  'business-development/bizdev-meri-scope.service.ts', 'common/tenant-flags.ts',
  'research-portfolios/research-portfolio-artifact-authority.ts',
  'research-portfolios/research-portfolio-meri-scope.service.ts',
  'research-portfolios/research-portfolio-access.ts', 'memory/memory-wall.helpers.ts',
  'bootstrap/configure-api-http-app.ts', 'common/prisma-exception.filter.ts',
  'observability/api-latency.middleware.ts',
];
const CLOSED_EXTERNAL = new Set([
  '@nestjs/common', '@nestjs/core', '@nestjs/platform-express',
  '@nestjs/throttler', 'rxjs', 'express', 'class-validator',
]);
const critical = new Set(CRITICAL.map(p => path.join(API_ROOT, 'src', p)));
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
function createHost({ fixtureConfig, sdk, sourceManifest, native = false }) {
  const modules = new Map();
  const tokens = new Map();
  const blocked = [];
  const reads = [];
  const hostCalls = [];
  const config = new configPackage.ConfigService(fixtureConfig);
  class FixtureConfigModule {}
  common.Global()(FixtureConfigModule);
  common.Module({ providers: [{provide: configPackage.ConfigService, useValue: config}], exports: [configPackage.ConfigService] })(FixtureConfigModule);
  function inertObject(label) {
    return new Proxy({}, {
      get(_target, key) {
        if (key === 'then' || key === 'onModuleInit' || key === 'onModuleDestroy' ||
            key === 'onApplicationBootstrap' || key === 'beforeApplicationShutdown' ||
            key === 'onApplicationShutdown') return undefined;
        if (key === 'client' || key === 'clientKb') return inertObject(`${label}.${String(key)}`);
        if (key === 'withCollaborators' || key === 'withCompletion') return () => {
          hostCalls.push(`${label}.${String(key)}:installed-only`);
          return inertObject(label);
        };
        return () => { throw new Error(`Refused unrelated host port: ${label}.${String(key)}`); };
      },
    });
  }
  function token(key, name) {
    const id = `${key}#${name}`;
    if (tokens.has(id)) return tokens.get(id);
    let value;
    if (name === 'RAW_MERI_TOOLS_SERVICE' || name === 'MERI_TURN_MAINTENANCE') value = Symbol(id);
    else if (name === 'createGovernedMeriToolsService' || name === 'createGovernedMeriResearchService') {
      value = (..._args) => { hostCalls.push(`${id}:inert-factory`); return inertObject(id); };
    } else if (/^[A-Z]/.test(name)) {
      value = name.endsWith('Module') || name.endsWith('Controller') ? class FixtureUnrelatedEmptyMetadata {} : class FixtureUnrelatedPort {
        constructor() { return inertObject(id); }
      };
      Object.defineProperty(value, 'name', {value: `Fixture_${name}`});
      if (name.endsWith('Module')) common.Module({})(value);
      else if (name.endsWith('Controller')) common.Controller(`__fixture_closed__/${name}`)(value);
      else common.Injectable()(value);
    } else value = (..._args) => { throw new Error(`Refused unrelated import invocation: ${id}`); };
    tokens.set(id, value);
    return value;
  }
  function closedPort(key) {
    if (modules.has(key)) return modules.get(key).exports;
    blocked.push(key);
    const exports = new Proxy({}, {get(_target, name) {
      if (name === '__esModule') return true;
      if (name === 'then') return undefined;
      if (typeof name !== 'string') return undefined;
      return token(key, name);
    }});
    modules.set(key, {exports});
    return exports;
  }
  function load(file) {
    file = path.normalize(file);
    if (!critical.has(file)) return closedPort(file);
    if (modules.has(file)) return modules.get(file).exports;
    if (file.endsWith('/engagement/engagement.service.ts')) throw new Error('Protected reporting body forbidden');
    const source = fs.readFileSync(file);
    const relative = path.relative(API_ROOT, file).replaceAll(path.sep, '/');
    if (sourceManifest[relative] !== digest(source)) throw new Error(`Unpinned critical source: ${relative}`);
    reads.push({path: relative, sha256: digest(source), bytes: source.length});
    const output = ts.transpileModule(source.toString('utf8'), {
      fileName: file,
      compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true},
      reportDiagnostics: true,
    });
    const errors = (output.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(`Critical source transpile diagnostics: ${relative}`);
    const module = {exports: {}};
    modules.set(file, module);
    function localRequire(specifier) {
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts')));
      if (specifier === '@clerk/backend') return sdk;
      if (specifier === '@nestjs/config') return {
        ...configPackage, ConfigModule: {forRoot: () => {hostCalls.push('ConfigModule.forRoot:fixture-no-env'); return FixtureConfigModule;}},
      };
      if (specifier === '@prisma/client') return require('/tmp/capirov2-local-native-prerequisite-20261012/core-client/index.js');
      if (specifier === '@capiro/shared' || specifier.startsWith('@capiro/shared/')) {
        const sharedRequire = Module.createRequire(path.join(API_ROOT,'package.json'));
        return sharedRequire(specifier);
      }
      if (specifier === '@capiro/meriv2-core') return cacheRequire(specifier);
      if (specifier.startsWith('node:') && ['node:async_hooks','node:crypto','node:util'].includes(specifier)) return require(specifier);
      if (CLOSED_EXTERNAL.has(specifier)) return cacheRequire(specifier);
      return closedPort(`external:${specifier}`);
    }
    const wrapper = vm.runInThisContext(Module.wrap(output.outputText), {filename: file});
    wrapper(module.exports, localRequire, module, file, path.dirname(file));
    return module.exports;
  }
  const AppModule = load(path.join(API_ROOT, 'src/app.module.ts')).AppModule;
  // All named unselected constructor tokens are explicit test-only global
  // ports. Critical classes are never replaced. Metadata remains original.
  const providers = [];
  for (const [key, value] of tokens) {
    if (typeof value === 'function' && /^[A-Z]/.test(key.split('#')[1]) && !key.endsWith('Module')) providers.push(value);
  }
  const criticalExtra = [
    load(path.join(API_ROOT,'src/business-development/bizdev-meri-scope.service.ts')).BizDevMeriScopeService,
    load(path.join(API_ROOT,'src/research-portfolios/research-portfolio-meri-scope.service.ts')).ResearchPortfolioMeriScopeService,
  ];
  class FixturePortsModule {}
  common.Global()(FixturePortsModule);
  common.Module({providers: [...providers, ...criticalExtra], exports: [...providers, ...criticalExtra]})(FixturePortsModule);
  return {AppModule, FixturePortsModule, load, reads, blocked, hostCalls, tokens, config, native,
    API_ROOT, SOURCE_HEAD, CRITICAL};
}
module.exports = {createHost, CRITICAL, SOURCE_HEAD, API_ROOT, digest, cacheRequire};
