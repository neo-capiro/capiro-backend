import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as planner from '../../../scripts/outreach-v3-qualification-plan.mjs';
const testURL = new URL('../../../scripts/outreach-v3-qualification-plan.spec.mjs', import.meta.url);
const text = readFileSync(testURL, 'utf8');
const prefix = text.slice(0, text.indexOf("test('scope requires"))
  .replace(/^import\s+[\s\S]*?;\s*$/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(testURL.href));
const context = vm.createContext({ readFileSync, path, vm, URL, ...planner });
new vm.Script(prefix + '\nglobalThis.inspect = inspectWrapper;').runInContext(context);
const rows = [];
for (const phase of ['phase1', 'phase3', 'phase4']) for (const scope of ['backend-only', 'frontend-only']) {
  const args = ['--run', `--${scope}`];
  const original = context.inspect(phase, args, { original: true });
  const candidate = context.inspect(phase, args);
  assert.equal(original.status, 2);
  assert.equal(original.commands.length, 0);
  assert.equal(original.reads.length, 0);
  assert.equal(candidate.status, 0, candidate.unhandled);
  rows.push({ phase, scope, original, candidate });
}
writeFileSync(new URL('before-after-scoped-traces.json', import.meta.url), JSON.stringify({
  sourceHead: '4060915ebfa55db4a8fb805c1e25281359c46a5d',
  sourceTree: '1fee6de079b59ecc3947109bb897f31d963a235b',
  baseHead: '5470c6df029c9553dd49e531229c3c91b26275ef',
  result: 'PASS six inert before/new scope pairs: original explicit-run guards refuse scopes, candidate deliberately accepts scopes',
  scope: 'Actual wrapper text via VM/fake ports only, no real verifier/process/provider/file fixture/native execution',
  rows,
}, null, 2) + '\n');
console.log('PASS six inert before/new scope pairs; original scope refusal and exact new fake traces retained.');
