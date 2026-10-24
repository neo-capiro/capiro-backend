const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const repo = path.resolve(__dirname, '../../../..');
const cache = new Map();
class ForbiddenException extends Error {}
class BadRequestException extends Error {}
// Only framework exception constructors are doubled. Validation, codecs,
// selectors and normalized operation owners below execute production source.
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file,
  }).outputText;
  function localRequire(name) {
    if (name === '@nestjs/common') return { ForbiddenException, BadRequestException };
    if (name === '@capiro/shared/core-retained-jcs') return load(path.join(repo, 'packages/shared/src/core-retained-jcs.ts'));
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name.replace(/\.js$/, '.ts')));
    return require(name);
  }
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`, { filename: file })(localRequire, module, module.exports);
  return module.exports;
}
const base = path.join(repo, 'apps/api/src/meri');
const context = load(path.join(base, 'retained-read-context.ts'));
const admission = load(path.join(base, 'retained-source-v02/admission.ts'));
const actions = load(path.join(base, 'meri-action-query-alias.ts'));
const { canonicalizeCoreRetainedJson: canonical } = load(path.join(repo, 'packages/shared/src/core-retained-jcs.ts'));
const ids = Array.from({ length: 8 }, (_, i) => `${String(i + 1).repeat(8)}-${String(i + 1).repeat(4)}-4${String(i + 1).repeat(3)}-8${String(i + 1).repeat(3)}-${String(i + 1).repeat(12)}`);
const [tenantId, actorId, clientId, conversationId, runId, attemptId, workerId, foreign] = ids;
const ctx = { tenantId, userId: actorId };
const policyRevision = 'a'.repeat(64);
function fixture() {
  return {
    binding: { tenantId, actorId, conversationId, runId, attemptId, workerId, writerFence: 1 },
    subject: { kind: 'client', entityType: 'client', entityIds: [clientId], tenantId, actorId, policyRevision,
      scopes: [{ tenantId, kind: 'client', resourceId: clientId, policyRevision }], rosterVersionId: null },
    policyRevision, normalizationContext: null,
  };
}
const options = { verifiedServiceIdentity: true, nowMs: 1000, deadlineMs: 2000 };
function retained(name = 'get_client_context', input = { clientId }, c = fixture(), opts = options) {
  return admission.assertRetainedSourceV02Admission(ctx, name, { input, metadata: null }, c, opts);
}
test('ordinary retained reads require verified service and authenticated actor, without a grant', () => {
  assert.equal(retained().clientId, clientId);
  assert.equal(retained().operation.version, '0.3.0');
  assert.equal(retained('read_client_documents').operation.version, '0.2.0');
  assert.throws(() => retained(undefined, undefined, undefined, { ...options, verifiedServiceIdentity: false }), ForbiddenException);
  for (const field of ['tenantId', 'actorId']) {
    const c = fixture(); c.binding[field] = foreign;
    assert.throws(() => retained(undefined, undefined, c), ForbiddenException);
  }
});
test('obsolete decision/grant fields cannot be treated as authority', () => {
  const c = fixture(); c.subject.authorizationDecisionId = foreign;
  assert.throws(() => retained(undefined, undefined, c), ForbiddenException);
  assert.throws(() => retained('create_task'), ForbiddenException);
});
test('read header requires ordinary bearer and exact bounded canonical JSON', () => {
  const header = Buffer.from(canonical(fixture())).toString('base64url');
  const headers = { authorization: 'Bearer synthetic-user', 'x-meri-read-correlation': header };
  assert.deepEqual(context.readRetainedReadHeader({ headers }), fixture());
  for (const authorization of [undefined, 'CapiroMeriRead synthetic', 'Bearer '])
    assert.throws(() => context.readRetainedReadHeader({ headers: { ...headers, authorization } }), ForbiddenException);
  for (const value of [header + '=', Buffer.from(JSON.stringify(fixture())).toString('base64url'), 'a'.repeat(11000)])
    assert.throws(() => context.readRetainedReadHeader({ headers: { ...headers, 'x-meri-read-correlation': value } }), ForbiddenException);
});
test('all nested client and conversation selectors stay within declared selection', () => {
  for (const input of [{ clientId: foreign }, { clientId, extra: { clientIds: [clientId, foreign] } },
    { clientId, extra: { conversationId: foreign } }, { clientId, extra: { clientIds: [] } }])
    assert.throws(() => retained(undefined, input), ForbiddenException);
  const accepted = retained('resolve_entity', { query: 'public', conversationId });
  assert.equal(accepted.binding.conversationId, conversationId);
});
test('personal mail selection cannot manufacture client scope or enter client-only readers', () => {
  const c = fixture(); Object.assign(c.subject, { kind: 'personal', entityType: 'user', entityIds: [actorId],
    scopes: [{ tenantId, kind: 'private-user', resourceId: actorId, policyRevision }] });
  assert.equal(retained('mail.list_messages', { subject: { kind: 'personal' } }, c).clientId, null);
  assert.throws(() => retained('read_client_documents', { clientId: null, subject: { kind: 'personal' } }, c), ForbiddenException);
  c.subject.scopes.push({ tenantId, kind: 'client', resourceId: foreign, policyRevision });
  assert.throws(() => retained('mail.list_messages', { subject: { kind: 'personal' } }, c), ForbiddenException);
});
test('expired reads, oversized bodies, accessors and mutable inputs are rejected or snapshotted', () => {
  assert.throws(() => retained(undefined, undefined, undefined, { ...options, deadlineMs: 1000 }), ForbiddenException);
  assert.throws(() => retained(undefined, { clientId, text: 'x'.repeat(16384) }), ForbiddenException);
  const c = fixture(); Object.defineProperty(c.subject, 'kind', { get() { throw new Error('must not execute'); }, enumerable: true });
  assert.throws(() => retained(undefined, undefined, c), ForbiddenException);
  const input = { clientId }; const result = retained(undefined, input); input.clientId = foreign;
  assert.equal(result.input.clientId, clientId);
});
function action(cursor = null) {
  return { input: { mode: 'client_scoped', selection: { clientId, actionItemId: null, status: null,
    sort: 'deadline', page: cursor === null ? 1 : null, limit: 10, cursorApplied: cursor !== null }, cursor }, metadata: null };
}
test('action alias preserves real owner selection and exact continuation semantics', () => {
  const admitted = actions.admitActionQueryAlias(ctx, action('cursor'), true, fixture(), 2000, 1000);
  assert.deepEqual(admitted.ownerBody, { clientId, limit: 10, sort: 'deadline', cursor: 'cursor' });
  for (const mutate of [p => p.input.selection.clientId = foreign, p => p.input.selection.limit = 51,
    p => p.input.selection.page = 2, p => p.input.selection.cursorApplied = true]) {
    const protocol = action(); mutate(protocol);
    assert.throws(() => actions.admitActionQueryAlias(ctx, protocol, true, fixture(), 2000, 1000), ForbiddenException);
  }
  assert.throws(() => actions.assertActionQueryAliasResult({ tool: 'query_action_items', clientId,
    actions: [{ clientId: foreign }], coverage: {} }, clientId), ForbiddenException);
});
test('deadline must be explicit, future and integer', () => {
  assert.equal(context.readRetainedReadDeadline({ headers: { 'x-meri-deadline-at': '2000' } }, 1000), 2000);
  for (const value of [undefined, 'NaN', '999', '1000', '2000.1'])
    assert.throws(() => context.readRetainedReadDeadline({ headers: { 'x-meri-deadline-at': value } }, 1000), ForbiddenException);
});
