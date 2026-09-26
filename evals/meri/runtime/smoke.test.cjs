'use strict';

// Offline import smoke: never import the audit-writing Meri CLI entrypoint.
// These checks read source paths only; they do not execute eval cases or use DB/model/network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workspace = path.resolve(__dirname, '..', '..', '..');
const runner = fs.readFileSync(path.join(__dirname, 'runner.mjs'), 'utf8');
const executableSource = runner
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/[^\r\n]*$/gm, '');

const allowedModules = new Set([
  'packages/meriv2-core/test/evals/leakage/cross-tenant-leakage.eval.ts',
  'packages/meriv2-core/test/evals/grounding/claim-grounding.eval.ts',
  'packages/meriv2-core/test/evals/compliance/gate-enforcement.eval.ts',
  'packages/meriv2-core/test/evals/entity/entity-grounding.eval.ts',
  'packages/meriv2-core/test/evals/legislation/bill-status.eval.ts',
  'packages/meriv2-core/test/evals/legislation/state-bill-status.eval.ts',
  'packages/meriv2-core/test/evals/legislation/state-rule-status.eval.ts',
  'packages/meriv2-core/test/evals/legislation/committee-roster.eval.ts',
  'packages/meriv2-core/test/evals/legislation/multi-state-comparison.eval.ts',
  'packages/meriv2-core/test/evals/legislation/federal-state-mixed.eval.ts',
  'packages/meriv2-core/test/evals/assurance/government-affairs-assurance.eval.ts',
  'apps/api/src/meri/evals/government-affairs-fixtures.ts',
  'apps/api/src/meri/evals/government-affairs-grader.ts',
  'apps/meriv2-orchestrator/src/meri/retrieval/meri-retrieval-intent.ts',
  'apps/meriv2-orchestrator/src/meri/retrieval/meri-retrieval-plan.ts',
]);

function importedModules() {
  return [...executableSource.matchAll(/\btsUrl\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((match) => match[1]);
}

test('runner never names the audit-writing run-evals entrypoint outside comments', () => {
  assert.doesNotMatch(executableSource, /\brun-evals(?:\.ts)?\b/i);
});

test('runner imports only explicitly approved offline modules', () => {
  assert.deepEqual(importedModules().sort(), [...allowedModules].sort());
});

test('each approved source module resolves inside the worktree', () => {
  for (const relativePath of importedModules()) {
    assert.ok(fs.statSync(path.join(workspace, relativePath)).isFile(), relativePath);
  }
});
