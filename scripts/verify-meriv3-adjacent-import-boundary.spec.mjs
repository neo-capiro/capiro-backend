import test from 'node:test';
import assert from 'node:assert/strict';
import { adjacentImportProblems } from './verify-meriv3-adjacent-import-boundary.mjs';
for (const source of [
  "import {x} from '../meri/meriv3/runtime';",
  "import type {x} from '../meri/meriv3/types';",
  "export {x} from '../meri/MeriV3/runtime';",
  "export * from '../meri/meriv3/runtime';",
  "const x = require('../meri/meriv3/runtime');",
  "const x = import('../meri/meriv3/runtime');",
  "import x = require('../meri/meriv3/runtime');",
  'const x = import(`../meri/meriv3/runtime`);',
  'const x = import(moduleName);',
  'const x = require(moduleName);',
  'const x = import(`../${name}/runtime`);',
  'import {',
])
  test(`rejects actual or indeterminate module imports: ${source}`, () =>
    assert.ok(adjacentImportProblems(source).length));
for (const source of [
  "// Existing MeriV3 HTTP reasoning gateway\nconst key='MERIV3_ORCHESTRATOR_URL';",
  "const message='MeriV3 is configured';",
  "import {x} from '@capiro/shared'; export {y} from '@capiro/auth';",
  "const x=require('@nestjs/common'); const y=import('./safe-runtime');",
  "import x = require('./safe-runtime');",
  'const view=<div>Configured MeriV3 HTTP gateway</div>;',
])
  test(`preserves data/comments and independent modules: ${source}`, () =>
    assert.deepEqual(
      adjacentImportProblems(source, source.includes('<div>') ? 'fixture.tsx' : 'fixture.ts'),
      [],
    ));
