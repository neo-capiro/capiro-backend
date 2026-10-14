const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const base = '917fed9be648dc4abfd6770e0e391ce2e3fe3928';
const source = '85d582c35a9971538a709225ebaf0e0a762073c6';
const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trimEnd();
const read = (ref, file) => cp.execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const canonicalImport = "import { authorizeMeriProspectScope } from '../business-development/bizdev-meri-scope.authorization.js';";
const rows = [];
for (const file of ['apps/api/src/meri/meri.service.ts', 'apps/api/src/meri/meriv3-proxy.service.ts', 'apps/api/src/meri/meri-prospect-scope.helpers.spec.ts']) {
  const before = read(base, file);
  const anchor = "} from './meri-prospect-scope.helpers.js';";
  assert.equal(before.split(anchor).length, 2);
  const expected = before.replace('  authorizeMeriProspectScope,\n', '').replace(anchor, `${anchor}\n${canonicalImport}`);
  assert.equal(read(source, file), expected, `${file}: only the selected named import moves`);
  rows.push({ path: file, delta: 'one named import moved; all other bytes exact', blob: git('rev-parse', `${source}:${file}`) });
}
const tools = 'apps/api/src/meri/meri-bizdev-tools.service.ts';
assert.equal(read(source, tools), read(base, tools).replace("import { authorizeMeriProspectScope } from './meri-prospect-scope.helpers.js';", canonicalImport));
rows.push({ path: tools, delta: 'import path only', blob: git('rev-parse', `${source}:${tools}`) });
const helper = 'apps/api/src/meri/meri-prospect-scope.helpers.ts';
assert.equal(read(source, helper), read(base, helper)
  .replace(' * The existing authorization re-check is owned by Business Development and\n * re-exported here for the legacy loop, MeriV2 full-chat proxy and MeriV3.\n',
    ' * The authorization re-check is imported directly from Business Development\n * by each runtime caller.\n')
  .replace("export { authorizeMeriProspectScope } from '../business-development/bizdev-meri-scope.authorization.js';\n", ''));
rows.push({ path: helper, delta: 'one unused reexport and its comment retired; both function bodies exact', blob: git('rev-parse', `${source}:${helper}`) });
const specs = 'apps/api/src/business-development/bizdev-meri-scope.authorization.spec.ts';
const changed = git('diff', '--name-only', base, source).split('\n').sort();
assert.deepEqual(changed, [...rows.map((r) => r.path), specs].sort());
const unchanged = ['apps/api/src/business-development/bizdev-meri-scope.authorization.ts',
  'apps/api/src/business-development/bizdev-meri-scope.service.ts', 'apps/api/src/business-development/bizdev-meri-scope.module.ts',
  'apps/api/src/auth/application-authority.controller.ts', 'apps/api/src/auth/application-authority.ts',
  'apps/api/src/auth/roles.guard.ts', 'apps/api/src/tenant/tenant-context.middleware.ts',
  'apps/api/src/meri/meri.module.ts', 'apps/api/src/app.module.ts', 'apps/api/src/engagement/engagement.service.ts'];
const preserved = unchanged.map((file) => {
  const blob = git('rev-parse', `${base}:${file}`);
  assert.equal(git('rev-parse', `${source}:${file}`), blob);
  return { path: file, blob };
});
const canonical = read(source, unchanged[0]);
console.log(JSON.stringify({ result: 'pass', base, source, sourceTree: git('rev-parse', `${source}^{tree}`),
  paths: rows, changedSpec: specs, preserved, canonicalAuthorizationSha256: crypto.createHash('sha256').update(canonical).digest('hex'),
  qualification: 'Exact source-byte and blob preservation; one named shim export retired. No runtime/module/store/auth-policy retirement or native/live claim.' }, null, 2));
