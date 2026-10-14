const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const ts = require(require.resolve('typescript', { paths: [path.join(root, 'apps/api')] }));
const base = 'afff08b0342985e3a8050a5fb4cd843741a720a5';
const oldPath = 'apps/api/src/meri/meri-prospect-scope.helpers.ts';
const domainPath = 'apps/api/src/business-development/bizdev-meri-scope.authorization.ts';
const controllerPath = 'apps/api/src/auth/application-authority.controller.ts';
const source = (ref, name) => cp.execFileSync('git', ['show', `${ref}:${name}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 }).toString();
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const syntax = (value, name) => ts.createSourceFile(name, value, ts.ScriptTarget.Latest, true);
const functions = (file) => new Map(file.statements.filter(ts.isFunctionDeclaration).map((node) => [node.name.text, node.getText(file)]));
const before = functions(syntax(source(base, oldPath), oldPath));
const current = functions(syntax(source('HEAD', oldPath), oldPath));
const domainSource = source('HEAD', domainPath);
const domain = syntax(domainSource, domainPath);
const moved = functions(domain);
assert.equal(moved.get('authorizeMeriProspectScope'), before.get('authorizeMeriProspectScope'));
assert.equal(moved.size, 1);
assert.equal(current.has('authorizeMeriProspectScope'), false);
for (const name of ['prospectScopeDirective', 'prospectTurnScopeReceipt']) assert.equal(current.get(name), before.get(name));
const imports = domain.statements.filter(ts.isImportDeclaration).map((node) => node.moduleSpecifier.text);
assert.deepEqual(imports, ['@capiro/shared', './bizdev-meri-scope.service.js']);
const compatibility = syntax(source('HEAD', oldPath), oldPath).statements.filter(ts.isExportDeclaration);
assert.equal(compatibility.length, 1);
assert.equal(compatibility[0].moduleSpecifier.text, '../business-development/bizdev-meri-scope.authorization.js');
assert.equal(compatibility[0].exportClause.elements[0].name.text, 'authorizeMeriProspectScope');
assert.equal(source('HEAD', controllerPath), source(base, controllerPath).replace("from '../meri/meri-prospect-scope.helpers.js'", "from '../business-development/bizdev-meri-scope.authorization.js'"));
const protectedUnchanged = [
  'apps/api/src/business-development/bizdev-meri-scope.service.ts',
  'apps/api/src/auth/application-authority.ts',
  'apps/api/src/tenant/tenant-context.middleware.ts',
  'apps/api/src/auth/roles.guard.ts',
];
const rows = protectedUnchanged.map((name) => {
  const oldBlob = cp.execFileSync('git', ['rev-parse', `${base}:${name}`], { cwd: root }).toString().trim();
  const newBlob = cp.execFileSync('git', ['rev-parse', `HEAD:${name}`], { cwd: root }).toString().trim();
  assert.equal(newBlob, oldBlob);
  return { path: name, blob: newBlob };
});
console.log(JSON.stringify({ result: 'pass', base,
  head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  tree: cp.execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root }).toString().trim(),
  exactFunctionSignatureAndBodySha256: sha(moved.get('authorizeMeriProspectScope')),
  exactRetainedFunctions: [...current.keys()], canonicalImports: imports,
  controllerDelta: 'one import path only', unchangedCanonicalOwnerAndAuthBlobs: rows,
  scope: 'exact committed source AST text and blob preservation, no native/runtime acceptance',
}, null, 2));
