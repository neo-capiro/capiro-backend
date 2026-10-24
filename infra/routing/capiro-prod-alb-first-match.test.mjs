import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  corePreviewPacketRules,
  firstMatch,
  readCoreRoutes,
  readListenerFixture,
  addMeriRule,
  setMeriAction,
  movePriority,
} from './capiro-prod-alb-first-match.mjs';
const observed = JSON.parse(
  readFileSync(new URL('./capiro-prod-alb-core-20261024.json', import.meta.url), 'utf8'),
).rules;
const routes = readCoreRoutes(),
  host = routes.host;
const after = corePreviewPacketRules(observed);
const match = (rules, path, method = 'POST', h = host) =>
  firstMatch(rules, { host: h, path, method, headers: {} });
test('current packet changes only existing P1 conditions; every other rule/action is identical', () => {
  assert.equal(after.length, observed.length);
  assert.equal(new Set(after.map((r) => r.priority)).size, after.length);
  for (const r of observed) {
    const n = after.find((x) => x.id === r.id);
    if (r.id !== 'core-post') assert.deepEqual(n, r);
    else {
      assert.equal(n.priority, r.priority);
      assert.deepEqual(n.action, r.action);
    }
  }
  assert.equal(observed.find((r) => r.id === 'core-guard').priority, 7);
  assert.deepEqual(observed.find((r) => r.id === 'core-post').conditions.pathRegexes, [
    '^/api/clio/(application-authority/(identity|context|membership|current)|conversations/bootstrap)$',
  ]);
});
test('existing bootstrap/current and actual read tools/reference/mode POSTs reach Core', () => {
  for (const p of [
    '/api/clio/conversations/bootstrap',
    ...['identity', 'context', 'membership', 'current', 'read-mode-observation'].map(
      (n) => `/api/clio/application-authority/${n}`,
    ),
    '/api/clio/clients/check-ref',
    '/api/clio/tools/find_contacts',
    '/api/clio/tools/actions.query',
    '/api/clio/tools/mail.list_messages',
    '/api/clio/tools/search_memory_eligibility',
    '/api/clio/tools/get_florida_budget_project',
  ])
    assert.equal(match(after, p).id, 'core-post', p);
  assert.equal(match(observed, '/api/clio/tools/find_contacts').id, 'core-guard');
});
test('unallocated mutations, malformed tool names and non-POST do not gain admission', () => {
  for (const p of [
    '/api/clio/tools/x',
    '/api/clio/tools/UPPER',
    '/api/clio/tools/a/b',
    '/api/clio/tools/get_file/',
    '/api/clio/tools/' + 'a'.repeat(65),
    '/api/clio/application-authority/artifact',
    '/api/clio/approvals/native/record',
    '/api/clio/application-authority/read-delegations',
    '/api/clients',
    '/api/clio/emails/send',
    '//api/clio/tools/get_file',
  ])
    assert.equal(match(after, p).id, 'core-guard', p);
  for (const m of ['PUT', 'PATCH', 'DELETE', 'OPTIONS', 'post'])
    assert.equal(match(after, '/api/clio/tools/get_file', m).id, 'core-guard');
});
test('existing GET/HEAD and Strategy/Workspace/Intel routes retain actual targets', () => {
  for (const m of ['GET', 'HEAD'])
    for (const p of [
      '/api/me',
      '/api/clio/conversations/example',
      '/strategy-api/x',
      '/workspace-api/x',
      '/intel-api/x',
    ])
      assert.deepEqual(match(after, p, m), match(observed, p, m));
  assert.equal(match(after, '/strategy-api/x', 'GET').id, 'preview-strategy');
});
test('all captured non-preview hosts retain first-match results across method/path matrix', () => {
  const hosts = new Set([
    'app.capiro.ai',
    'os.capiro.ai',
    'meri-preview.capiro.ai',
    'unknown.example.invalid',
  ]);
  for (const r of observed)
    for (const h of r.conditions.hosts ?? []) if (!h.includes('*') && h !== host) hosts.add(h);
  for (const h of hosts)
    for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'])
      for (const p of [
        '/',
        '/health',
        '/api/me',
        '/api/clio/tools/find_contacts',
        '/api/clio/application-authority/current',
        '/strategy-api/x',
        '/workspace-api/x',
        '/intel-api/x',
        '/meri-api/x',
        '/webhooks/recall',
        '/onboard-api/x',
      ])
        assert.deepEqual(match(after, p, m, h), match(observed, p, m, h));
});
test('unexpected current guard/target/method/priority drift refuses before transformation', () => {
  const edits = [
    (r) => (r.find((x) => x.id === 'core-guard').priority = 4),
    (r) => (r.find((x) => x.id === 'core-guard').conditions = {}),
    (r) => (r.find((x) => x.id === 'core-membership').conditions.methods = ['POST']),
    (r) => (r.find((x) => x.id === 'core-membership').action.target = 'foreign'),
    (r) => r.push(structuredClone(r[0])),
    (r) => (r.find((x) => x.id === 'core-post').conditions.hosts = ['*']),
  ];
  for (const edit of edits) {
    const copy = structuredClone(observed);
    edit(copy);
    assert.throws(() => corePreviewPacketRules(copy), /Exact current/);
  }
});
test('ALB path and match bounds stay below documented limits', () => {
  assert.equal(routes.post.length, 2);
  assert.ok(routes.post.every((p) => p.length <= 128 && p.startsWith('^') && p.endsWith('$')));
  assert.ok(routes.post.length + 2 <= 5);
  assert.throws(() =>
    corePreviewPacketRules(observed, { ...routes, post: ['x'.repeat(129), '^x$'] }),
  );
});
test('historical Meri deny/forward model retains host isolation and ambiguous-slot refusal', () => {
  const historical = readListenerFixture().rules;
  const shifted = movePriority(historical, 'engagement-preview', 6, 4);
  const deny = addMeriRule(shifted),
    forward = setMeriAction(deny, 'forward'),
    rollback = setMeriAction(forward, 'deny');
  assert.deepEqual(rollback, deny);
  assert.equal(
    match(forward, '/', 'GET', 'meri-preview.capiro.ai').action.target,
    'meri-preview-control',
  );
  assert.equal(match(deny, '/', 'GET', 'meri-preview.capiro.ai').action.statusCode, 404);
  assert.throws(() => addMeriRule(historical));
  assert.throws(() => setMeriAction(deny, 'invalid'));
  assert.throws(() => movePriority(historical, 'engagement-preview', 6, 5));
});
