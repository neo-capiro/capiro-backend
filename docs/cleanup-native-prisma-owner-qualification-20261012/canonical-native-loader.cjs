'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const apiRequire = createRequire(path.join(ROOT, 'apps/api/package.json'));
const CORE_CLIENT = '/tmp/capirov2-local-native-prerequisite-20261012/core-client';
const SOURCE_FILES = [
  'packages/shared/src/client-objective-destination.ts',
  'packages/shared/src/workspace-saved-revision.ts',
  'packages/shared/src/client-memory-wall.ts',
  'apps/api/src/outreach-v3/services/outreach-command-engine.service.ts',
  'apps/api/src/outreach-v3/persistence/outreach-state.repository.ts',
  'apps/api/src/outreach-v3/state/outreach-campaign-spec.v1.ts',
  'apps/api/src/outreach-v3/state/outreach-command.contract.ts',
  'apps/api/src/outreach-v3/state/outreach-command-normalization.ts',
  'apps/api/src/outreach-v3/state/outreach-command-reducer.ts',
  'apps/api/src/outreach-v3/state/outreach-command-errors.ts',
  'apps/api/src/outreach-v3/state/outreach-style-sample.contract.ts',
  'apps/api/src/outreach-v3/context/outreach-context-sponsor-policy.ts',
  'apps/api/src/capabilities/targets/outreach-target.contract.ts',
  'apps/api/src/capabilities/context/outreach-context.contract.ts',
  'apps/api/src/capabilities/capability-authorization.service.ts',
  'apps/api/src/capabilities/capability-errors.ts',
  'apps/api/src/memory/memory-wall.helpers.ts',
  'apps/api/src/federal-register/federal-register.service.ts',
  'apps/api/src/federal-register/effective-date-evidence.ts',
  'apps/api/src/prisma/prisma.service.ts',
];

function verifyBindings() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'source-bindings.json'), 'utf8'));
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  for (const name of SOURCE_FILES) {
    const entry = byPath.get(name);
    if (!entry) throw new Error(`Unbound canonical source: ${name}`);
  }
  for (const [name, entry] of byPath) {
    const bytes = fs.readFileSync(path.join(ROOT, name));
    if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
      throw new Error(`Canonical source changed: ${name}`);
  }
  return manifest;
}

function loadCanonical() {
  verifyBindings();
  const ts = apiRequire('typescript');
  const permitted = new Set(SOURCE_FILES.map((name) => path.join(ROOT, name)));
  const cache = new Map();
  let shared;
  const targetFile = path.join(ROOT, 'apps/api/src/capabilities/targets/outreach-target-reference.service.ts');
  const timeoutMatches = [...fs.readFileSync(targetFile, 'utf8').matchAll(/export const OUTREACH_REFERENCE_TX_TIMEOUT_MS = ([\d_]+);/g)];
  if (timeoutMatches.length !== 1) throw new Error('Target timeout declaration is not uniquely bounded');
  const targetSeam = { OUTREACH_REFERENCE_TX_TIMEOUT_MS: Number(timeoutMatches[0][1].replaceAll('_', '')) };
  function load(filename) {
    if (!permitted.has(filename)) throw new Error(`Runtime import refused: ${filename}`);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const emitted = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true, emitDecoratorMetadata: false,
        esModuleInterop: true,
      },
      reportDiagnostics: true,
    });
    const errors = (emitted.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: () => ROOT, getCanonicalFileName: (f) => f, getNewLine: () => '\n',
    }));
    function restrictedRequire(specifier) {
      if (specifier === 'node:crypto') return require(specifier);
      if (specifier === 'zod') return apiRequire(specifier);
      // Real cached exception classes/decorators; no Nest module/bootstrap.
      if (specifier === '@nestjs/common') return apiRequire(specifier);
      if (specifier === '@capiro/shared') {
        shared ??= Object.assign({},
          load(path.join(ROOT, SOURCE_FILES[2])),
          load(path.join(ROOT, SOURCE_FILES[1])),
          load(path.join(ROOT, SOURCE_FILES[0])));
        return shared;
      }
      // Actual cached Prisma namespace/client; no enum or ORM query substitute.
      if (specifier === '@prisma/client') return apiRequire(CORE_CLIENT);
      if (!specifier.startsWith('.')) throw new Error(`External runtime import refused: ${specifier}`);
      const resolved = path.resolve(path.dirname(filename), specifier.replace(/\.js$/, '.ts'));
      if (resolved === targetFile) return targetSeam;
      return load(resolved);
    }
    vm.runInThisContext(`(function(exports,require,module){${emitted.outputText}\n})`, { filename })(module.exports, restrictedRequire, module);
    return module.exports;
  }
  return {
    nativePrismaService: load(path.join(ROOT, SOURCE_FILES[19])).PrismaService,
    objective: load(path.join(ROOT, SOURCE_FILES[0])),
    workspace: load(path.join(ROOT, SOURCE_FILES[1])),
    engine: load(path.join(ROOT, SOURCE_FILES[3])).OutreachCommandEngineService,
    repository: load(path.join(ROOT, SOURCE_FILES[4])).OutreachStateRepository,
    campaign: load(path.join(ROOT, SOURCE_FILES[5])),
    authorization: load(path.join(ROOT, SOURCE_FILES[14])).CapabilityAuthorizationService,
    calendar: load(path.join(ROOT, SOURCE_FILES[17])).FederalRegisterService,
    evidence: load(path.join(ROOT, SOURCE_FILES[18])),
    loadedFiles: [...cache.keys()].map((name) => path.relative(ROOT, name)),
  };
}

module.exports = { ROOT, SOURCE_FILES, CORE_CLIENT, apiRequire, verifyBindings, loadCanonical };
