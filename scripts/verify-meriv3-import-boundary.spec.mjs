#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectSource, verifyRepository } from './verify-meriv3-import-boundary.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_FILE = 'apps/workspace/src/import-boundary.fixture.ts';
const RUNTIME_MODULE = '../../../meriv2-orchestrator/src/meri/meriv3/status-provenance-runtime.js';

function violationsFor(source, options = {}) {
  return inspectSource(source, FIXTURE_FILE, {
    repositoryRoot: REPOSITORY_ROOT,
    ...options,
  });
}

function assertRejected(source, expectedKind, options = {}) {
  const violations = violationsFor(source, options);
  assert.ok(
    violations.some((violation) => violation.reason.includes(expectedKind)),
    JSON.stringify(violations),
  );
}

test('rejects a static MeriV3 implementation import', () => {
  assertRejected(`import { status } from '${RUNTIME_MODULE}';`, 'import');
});

test('rejects a MeriV3 implementation re-export', () => {
  assertRejected(`export { status } from '${RUNTIME_MODULE}';`, 're-export');
});

test('rejects type-only MeriV3 implementation references', () => {
  assertRejected(`import type { RuntimeStatus } from '${RUNTIME_MODULE}';`, 'import');
  assertRejected(`type RuntimeStatus = import('${RUNTIME_MODULE}').RuntimeStatus;`, 'type import');
});

test('rejects a dynamic MeriV3 implementation import assembled from constants', () => {
  assertRejected(
    `
      const root = '../../../meriv2-orchestrator/src/meri/';
      const version = 'meri' + 'v3';
      const modulePath = \`${'${root}${version}'}/status-provenance-runtime.js\`;
      export const loadRuntime = () => import(modulePath);
    `,
    'dynamic import',
  );
});

test('rejects a MeriV3 implementation require', () => {
  assertRejected(`const runtime = require('${RUNTIME_MODULE}');`, 'require');
});

test('rejects transparent wrappers around a MeriV3 implementation require callee', () => {
  assertRejected(`const runtime = (require)('${RUNTIME_MODULE}');`, 'require');
  assertRejected(`const runtime = (require as NodeRequire)('${RUNTIME_MODULE}');`, 'require');
  assertRejected(`const runtime = (require!)('${RUNTIME_MODULE}');`, 'require');
  assertRejected(
    `const runtime = (require satisfies NodeRequire)('${RUNTIME_MODULE}');`,
    'require',
  );
});

test('fails closed when a safe const name is shadowed or cannot be bound safely', () => {
  assertRejected(
    `const path = './safe.js'; function load(path: string) { return import(path); }`,
    'unsupported computed dynamic import',
  );
  assertRejected(
    `const path = './safe.js'; { const path = getPath(); void import(path); }`,
    'unsupported computed dynamic import',
  );
  assertRejected(
    `const path = './safe.js'; try { run(); } catch (path) { void import(path); }`,
    'unsupported computed dynamic import',
  );
  assertRejected(
    `const path = './safe.js'; function load({ path }: { path: string }) { return import(path); }`,
    'unsupported computed dynamic import',
  );
  assertRejected(
    `const first = second; const second = first; void import(first);`,
    'unsupported computed dynamic import',
  );
});

test('allows a known harmless module path folded through lexical const aliases', () => {
  const source = `
    const directory = './';
    const stem = 'safe' + '-module';
    const modulePath = \`${'${directory}${stem}'}.js\`;
    export const load = () => import(modulePath);
  `;
  assert.deepEqual(violationsFor(source), []);
});

test('rejects a MeriV3 implementation import-equals declaration', () => {
  assertRejected(`import runtime = require('${RUNTIME_MODULE}');`, 'import equals');
});

test('resolves a TS path alias whose name disguises the MeriV3 runtime target', () => {
  assertRejected(
    `import { status } from '@reasoning-runtime/status-provenance-runtime';`,
    'import',
    {
      compilerOptions: {
        baseUrl: REPOSITORY_ROOT,
        paths: {
          '@reasoning-runtime/*': ['apps/meriv2-orchestrator/src/meri/meriv3/*'],
        },
      },
    },
  );
});

test('normalizes a disguised relative path into the MeriV3 runtime', () => {
  assertRejected(
    `import { status } from '../../../meriv2-orchestrator/src/meri/chat/../meriv3/status-provenance-runtime.js';`,
    'import',
  );
});

test('rejects direct API-side MeriV3 implementation imports', () => {
  assertRejected(
    `import { Meriv3RuntimeProxy } from '../../../api/src/meri/meriv3-runtime.proxy.js';`,
    'import',
  );
});

test('fails closed on an unsupported computed module load', () => {
  const violations = violationsFor(`export const load = (name: string) => import(name);`);
  assert.ok(
    violations.some((violation) =>
      violation.reason.includes('unsupported computed dynamic import'),
    ),
    JSON.stringify(violations),
  );
});

test('fails closed on TypeScript syntax errors', () => {
  const violations = violationsFor(`import { broken from './module.js';`);
  assert.ok(
    violations.some((violation) => violation.reason.includes('syntax error')),
    JSON.stringify(violations),
  );
});

test('allows comments, descriptions, configuration strings, and non-module strings', () => {
  const source = `
    // MeriV3 implementation import examples belong in architecture comments.
    /* import { Runtime } from '../../../meriv2-orchestrator/src/meri/meriv3/runtime'; */
    export const metadata = {
      description: 'MeriV3 runtime is reached only through the approved HTTP gateway',
      example: "import('../../../meriv2-orchestrator/src/meri/meriv3/runtime')",
    };
    export const baseUrl = config.get<string>('MERIV3_ORCHESTRATOR_URL') ?? '';
  `;
  assert.deepEqual(violationsFor(source), []);
});

test('allows the approved narrow Workspace HTTP gateway', () => {
  const file = 'apps/workspace/src/workspace-reasoning/workspace-reasoning.gateway.ts';
  assert.deepEqual(
    inspectSource(readFileSync(resolve(REPOSITORY_ROOT, file), 'utf8'), file, {
      repositoryRoot: REPOSITORY_ROOT,
    }),
    [],
  );
});

test('the production Workspace, Strategy, and Intel trees satisfy the guard', () => {
  const result = verifyRepository(REPOSITORY_ROOT);
  assert.ok(result.files.length > 0);
  assert.deepEqual(result.violations, []);
});
