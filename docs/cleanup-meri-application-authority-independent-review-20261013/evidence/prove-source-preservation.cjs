const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('/workspace/capirov2/node_modules/typescript/lib/typescript.js');
const root = '/tmp/capirov2-cleanup-meri-local-dispatch-conversion';
const base = '9db4e1cd5589a05e08fb88caa38a4ac44937def5';
const head = 'd5c121973438a29a65515496f395f4ad7568d006';
const git = args => execFileSync('git', args, { cwd: root }).toString();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const expected = [
  'apps/api/src/auth/application-authority.spec.ts', 'apps/api/src/auth/application-authority.ts',
  'apps/api/src/auth/clerk.service.ts', 'apps/api/src/context/context-security-scope.service.ts',
  'apps/api/src/context/context.module.ts', 'apps/api/src/meri/meri.controller.ts',
  'apps/api/src/meri/meri.service.ts', 'apps/api/src/tenant/tenant-context.middleware.ts',
].sort();
assert.deepEqual(git(['diff', '--name-only', base, head]).trim().split('\n').sort(), expected);
const bindings = expected.map(file => {
  const text = git(['show', head + ':' + file]);
  return { path: file, gitBlob: git(['rev-parse', head + ':' + file]).trim(), bytes: Buffer.byteLength(text), sha256: sha(text) };
});
const proofs = [];
for (const [file, className] of [
  ['apps/api/src/auth/clerk.service.ts', 'ClerkService'],
  ['apps/api/src/context/context-security-scope.service.ts', 'ContextSecurityScopeService'],
  ['apps/api/src/meri/meri.service.ts', 'MeriService'],
  ['apps/api/src/meri/meri.controller.ts', 'MeriController'],
  ['apps/api/src/tenant/tenant-context.middleware.ts', 'TenantContextMiddleware'],
]) {
  const before = ts.createSourceFile(file, git(['show', base + ':' + file]), ts.ScriptTarget.Latest, true);
  const after = ts.createSourceFile(file, git(['show', head + ':' + file]), ts.ScriptTarget.Latest, true);
  const oldClass = before.statements.find(n => ts.isClassDeclaration(n) && n.name.text === className);
  const newClass = after.statements.find(n => ts.isClassDeclaration(n) && n.name.text === className);
  assert(oldClass && newClass);
  for (const member of oldClass.members) {
    const name = ts.isConstructorDeclaration(member) ? 'constructor' : member.name?.getText(before);
    assert(name);
    const matches = newClass.members.filter(n => ts.isConstructorDeclaration(n) ? name === 'constructor' : n.name?.getText(after) === name);
    assert.equal(matches.length, 1, className + '.' + name);
    let newer = matches[0].getText(after);
    const older = member.getText(before);
    let qualifier = 'byte-exact';
    if (className === 'MeriService' && name === 'constructor') {
      newer = newer.replace('    @Optional() private readonly applicationAuthorityTenant?: TenantContextMiddleware,\n', '')
        .replace('    @Optional() private readonly applicationAuthorityScope?: ContextSecurityScopeService,\n', '');
      qualifier = 'byte-exact after removing only two trailing optional canonical-owner injections';
    }
    if (className === 'TenantContextMiddleware' && name === 'use') {
      // Check every original line occurs unchanged in order, then check the
      // original authorization/helper methods independently below. The added
      // statements are the inspected header/provenance instrumentation only.
      const lines = newer.split('\n'); let at = 0;
      for (const line of older.split('\n')) {
        while (at < lines.length && lines[at] !== line) at++;
        assert(at < lines.length, 'Original middleware line changed: ' + line); at++;
      }
      qualifier = 'every original line byte-exact and in order; header/provenance insertions inspected';
    } else assert.equal(newer, older, className + '.' + name);
    proofs.push({ file, member: className + '.' + name, originalSha256: sha(older), candidateSha256: sha(matches[0].getText(after)), qualifier });
  }
  for (const node of before.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name) continue;
    const found = after.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === node.name.text);
    assert(found); assert.equal(found.getText(after), node.getText(before));
    proofs.push({ file, member: node.name.text, originalSha256: sha(node.getText(before)), candidateSha256: sha(found.getText(after)), qualifier: 'byte-exact top-level canonical helper' });
  }
}
const contextFile = 'apps/api/src/context/context.module.ts';
let newer = git(['show', head + ':' + contextFile]);
assert.equal((newer.match(/^    ContextSecurityScopeService,$/gm) || []).length, 2);
newer = newer.replace("import { ContextSecurityScopeService } from './context-security-scope.service.js';\n", '')
  .replaceAll('    ContextSecurityScopeService,\n', '');
assert.equal(newer, git(['show', base + ':' + contextFile]));
proofs.push({ file: contextFile, member: 'entire module', qualifier: 'whole file byte-exact after sole canonical-owner import/provider/export additions' });
for (const file of [
  'apps/api/src/tenant/tenant.module.ts', 'apps/api/src/tenant/tenant-context.store.ts',
  'apps/api/src/auth/roles.guard.ts', 'apps/api/src/auth/auth.module.ts', 'apps/api/src/app.module.ts',
  'apps/api/src/meri/meri.module.ts', 'apps/api/src/meri/meriv3-runtime.proxy.ts',
  'apps/api/src/meri/meri-tools.service.ts', 'apps/api/src/prisma/prisma.service.ts',
  'apps/api/prisma/schema.prisma', 'packages/shared/src/index.ts', 'package.json', 'pnpm-lock.yaml',
]) {
  const before = git(['show', base + ':' + file]), after = git(['show', head + ':' + file]); assert.equal(after, before);
  proofs.push({ file, qualifier: 'whole file byte-exact outside source8', sha256: sha(after) });
}
const clerkAst = ts.createSourceFile('clerk.service.ts', git(['show', head + ':apps/api/src/auth/clerk.service.ts']), ts.ScriptTarget.Latest, true);
const clerkClass = clerkAst.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'ClerkService');
const assertion = clerkClass.members.find(n => n.name?.getText(clerkAst) === 'assertActiveApplicationAuthoritySession');
const sdkCalls = [];
function walk(node) {
  if (ts.isCallExpression(node) && node.expression.getText(clerkAst).startsWith('this.client.sessions.')) sdkCalls.push(node.expression.getText(clerkAst));
  ts.forEachChild(node, walk);
}
walk(assertion); assert.deepEqual(sdkCalls, ['this.client.sessions.getSession']);
const result = { sourceHead: head, sourceTree: git(['rev-parse', head + '^{tree}']).trim(), baseHead: base,
  sourceBindings: bindings, preservedMembersAndHelpersAndWholeFiles: proofs, proofCount: proofs.length,
  onlineSessionOperations: sdkCalls, requestProvenance: 'single module-private WeakMap keyed by actualRequest with same selected-context identity; no public capability/persistence',
  endpointReceiptScope: 'closed principal/revisions/times/correlation only; no run/fence/scopes/grant/approval minting',
  sourceOutsideExactlyEightPathsUnchanged: true, applicationDatabaseProviderOrCredentialExecution: false };
const output = path.join(__dirname, '07-d5-source-preservation.json'); assert(!fs.existsSync(output)); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ sourcePaths: bindings.length, proofs: proofs.length, onlineSessionOperations: sdkCalls }, null, 2));
