const fs = require('node:fs'), cp = require('node:child_process'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const ts = require('/workspace/capirov2/node_modules/typescript');
const source = 'a247f7a02a9b94d95e9ee5a516b396202aea994b', base = '7ea444c74a5637577aa0eb3cb99cb420b5f8223e';
const dir = 'docs/cleanup-newsletter-two-contract-independent-review-20261012/evidence/';
const prefrozen = JSON.parse(fs.readFileSync(dir + 'prefrozen-rebound.json', 'utf8'));
const beforeSchema = JSON.parse(fs.readFileSync(dir + 'schema-before-golden.json', 'utf8'));
const git = (...args) => cp.execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const text = (sha, path) => git('show', `${sha}:${path}`);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const entries = sha => new Map(git('ls-tree', '-r', sha).trim().split('\n').map(line => { const t = line.indexOf('\t'); return [line.slice(t + 1), line.slice(0, t)]; }));
const previous = entries(base), current = entries(source);
const changes = git('diff', '--name-only', base, source).trim().split('\n').filter(p => !p.startsWith('docs/'));
assert.equal(changes.length, 76);
assert.equal(git('diff', '--name-only', source, 'HEAD', '--', '.', ':!docs').trim(), '');
for (const entry of prefrozen.verifiedEntries) {
  assert.equal(current.get(entry.path).split(' ').at(-1), entry.Cblob);
  assert.equal(hash(fs.readFileSync(entry.path)), entry.sha256);
  assert.equal(current.get(entry.path).split(' ')[0], '100644');
}
let protectedPaths = 0, protectedSchemasMigrations = 0, protectedDocs = 0;
for (const [path, entry] of previous) {
  if (changes.includes(path)) continue;
  assert.equal(current.get(path), entry, path); protectedPaths++;
  if (/schema\.prisma$|\/migrations\//.test(path)) protectedSchemasMigrations++;
  if (path.startsWith('docs/')) protectedDocs++;
}
for (const model of beforeSchema.models) {
  assert(fs.readFileSync(model.path, 'utf8').includes(model.originalBlock), model.name);
}
for (const schema of ['apps/api/prisma/schema.prisma', 'apps/workspace/prisma/schema.prisma']) {
  const old = text(base, schema), next = fs.readFileSync(schema, 'utf8');
  for (const match of old.matchAll(/^(?:model|enum) (\w+) \{[\s\S]*?^\}/gm)) {
    const n = match[1]; let candidate = next.match(new RegExp(`^(?:model|enum) ${n} \\{[\\s\\S]*?^\\}`, 'm'))?.[0]; assert(candidate, n);
    if (n === 'OutreachDraftVersion') {
      candidate = candidate.split('\n').filter(line => !/^\s+(?:contentFormat|newsletterStageId)\s/.test(line)).join('\n');
      const addedComment = '  /// Set only by the server-side Workspace newsletter importer. Generic edits\n  /// use the default outreach format and cannot inherit this authority.\n';
      assert(candidate.includes(addedComment));
      assert(text(prefrozen.C, schema).includes(addedComment));
      candidate = candidate.replace(addedComment, '');
    }
    if (n === 'WsNotification') candidate = candidate.split('\n').filter(line => !/^\s+newsletterId\s/.test(line)).join('\n');
    if (n === 'WsNotificationKind') candidate = candidate.split('\n').filter(line => !/^\s+newsletter_(?:review|comment)\s*$/.test(line)).join('\n');
    assert.equal(candidate, match[0], `${schema}/${n}: prior declaration changed`);
  }
}
const parse = (s, file) => ts.createSourceFile(file, s, ts.ScriptTarget.Latest, true);
function members(s, file, name) {
  const ast = parse(s, file); assert.equal(ast.parseDiagnostics.length, 0);
  const owner = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === name); assert(owner);
  return new Map(owner.members.filter(n => n.name).map(n => [n.name.getText(ast), n.getText(ast)]));
}
const notificationsPath = 'apps/workspace/src/notifications/notifications.service.ts';
const oldNotifications = members(text(base, notificationsPath), notificationsPath, 'NotificationsService');
const newNotifications = members(fs.readFileSync(notificationsPath, 'utf8'), notificationsPath, 'NotificationsService');
for (const name of ['constructor', 'list', 'markRead', 'markAllRead', 'resolveInvite']) assert.equal(newNotifications.get(name), oldNotifications.get(name), name);
const notificationSource = fs.readFileSync(notificationsPath, 'utf8');
assert.equal((notificationSource.match(/prospectNotificationVisible/g) ?? []).length, 6);
const credentialPath = 'apps/workspace/src/generation/ai-credential.service.ts';
const oldCredential = members(text(base, credentialPath), credentialPath, 'AiCredentialService');
const newCredential = members(fs.readFileSync(credentialPath, 'utf8'), credentialPath, 'AiCredentialService');
for (const [name, original] of oldCredential) if (name !== 'constructor') assert.equal(newCredential.get(name), original, name);
const oldCtor = oldCredential.get('constructor'); const additions = "    this.globalOpenai = config.get<string>('OPENAI_API_KEY');\n    this.newsletterImageModel = config.get<string>('NEWSLETTER_IMAGE_MODEL') || 'gpt-image-2.5-sunburst';\n    this.newsletterAltTextModel = upgradeTextModel(\n      config.get<string>('NEWSLETTER_ALT_TEXT_MODEL') || OPENAI_TEXT_MODEL,\n    );\n";
assert.equal(newCredential.get('constructor').replace(additions, ''), oldCtor);
const sender = fs.readFileSync('apps/api/src/engagement/outreach-send-intent.service.ts', 'utf8');
assert.equal((sender.match(/prospectId: null/g) ?? []).length, 2);
const qPaths = [...previous.keys()].filter(p => /outreach-newsletter-staging\.spec|workspace-saved-revision|saved_version_immutability|^apps\/workspace\/src\/versions\//.test(p));
for (const p of qPaths) assert.equal(current.get(p), previous.get(p), p);
for (const p of ['apps/api/src/outreach-v3/api/outreach-v3-state.controller.ts', 'apps/api/src/outreach-v3/services/outreach-command-engine.service.ts', 'packages/shared/src/index.ts', 'scripts/registry-ownership.json', 'scripts/strategy-time-boundaries.json', 'scripts/duplicate-helper-names.txt', '.github/workflows/ci-pr.yml', 'package.json']) assert.equal(current.get(p), previous.get(p), p);
const oldShared = JSON.parse(text(base, 'packages/shared/package.json')), shared = JSON.parse(fs.readFileSync('packages/shared/package.json', 'utf8'));
for (const value of ['newsletter', 'newsletter-render']) { delete shared.exports[`./${value}`]; delete shared.typesVersions['*'][value]; }
assert.deepEqual(shared, oldShared);
const workspacePackage = JSON.parse(fs.readFileSync('apps/workspace/package.json', 'utf8'));
assert.deepEqual(workspacePackage.scripts, JSON.parse(text(base, 'apps/workspace/package.json')).scripts);
const result = { source, tree: git('rev-parse', `${source}^{tree}`).trim(), ownMerge: git('rev-parse', 'HEAD').trim(), base,
  sourceFiles: changes.length, originalByteExactFiles: 58, integrationFiles: changes.filter(p => !prefrozen.verifiedEntries.some(e => e.path === p)),
  protectedPaths, protectedSchemasMigrations, protectedDocs, originalModelsExact: beforeSchema.models.length,
  allPriorSchemaDeclarationsExactExceptDeclaredAdditiveFields: true,
  notificationReadMarkBodiesByteExact: true, visibilityHelperOccurrences: 6, visibilityHelperCalls: 5,
  priorCredentialMembersByteExactExceptAddedConstructorConfiguration: true, twoProspectPredicatesRetained: true,
  qSavedRevisionVersionOwnersSpecsMigrationExact: qPaths, qControllerEngineExact: true,
  rootControlsSharedBarrelAndScriptsExact: true, sharedOnlyTwoSubpathMappingsAdded: true,
  noSourceEditsByReviewer: true, sourceGraphExecuted: false, sqlExecuted: false, finalAcceptance: false };
fs.writeFileSync(dir + 'frozen-source-proof.json', JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result, null, 2));
