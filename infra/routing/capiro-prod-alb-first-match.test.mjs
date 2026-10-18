import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  compactCorePreviewRules,
  corePreviewPacketRules,
  addMeriRule,
  firstMatch,
  movePriority,
  readCoreRoutes,
  readListenerFixture,
  readPriorityRegistry,
  setMeriAction,
} from './capiro-prod-alb-first-match.mjs';

const snapshot = readListenerFixture();
const registry = readPriorityRegistry();
const live = snapshot.rules;
const coreHost = registry.hostReservations.core;
const meriHost = registry.hostReservations.meri;
const validClient = '12345678-abcd-4def-8abc-123456789abc';

const hosts = [
  coreHost, coreHost.toUpperCase(), meriHost, meriHost.toUpperCase(),
  'app.capiro.ai', 'onboarding.capiro.ai', 'capiro.ai', 'www.capiro.ai',
  'os.capiro.ai', 'other.capiro.ai',
];
const paths = [
  '/', '/health', '/api', '/api/', '/api/health', '/api/me', '/api/me/',
  '/api/me?source=preview', '/api/clients', '/api/clients/',
  `/api/clients/${validClient}`, `/api/clients/${validClient}/history`,
  '/api/clients/not-a-uuid', '/api/%63lients', '/API/me',
  '/api/clio/conversations/bootstrap', '/api/clio/application-authority/identity',
  '/api/clio/application-authority/context', '/api/clio/application-authority/membership',
  '/api/engagement/integrations/microsoft/callback',
  '/api/engagement/integrations/microsoft/notifications',
  '/api/engagement/integrations/google/callback',
  '/api/engagement/x', '/api/engagement/', '/api/engagement', '/api/engagementish/x',
  '/webhooks/recall', '/webhooks/recall/', '/webhooks/recall/event',
  '/webhooks/recallish', '/webhooks/x', '/webhooks',
  '/onboard-api/public/config', '/onboard-api/', '/onboard-api', '/onboard-apiish/config',
  '/strategy-api/x', '/workspace-api/x', '/meri-api/x', '/intel-api/x',
  '/first-chat-preview', '//api/me',
];
const methods = ['GET', 'POST', 'PUT', 'HEAD', 'OPTIONS', 'post'];
const headers = [
  {},
  { 'X-Capiro-Engagement-Preview': 'v3' },
  { 'x-capiro-engagement-preview': 'V3' },
  { 'X-Capiro-Engagement-Preview': 'v2' },
];

function* requests(forHosts = hosts) {
  for (const host of forHosts) {
    for (const path of paths) {
      for (const method of methods) {
        for (const header of headers) {
          yield { host, path, method, headers: header };
        }
      }
    }
  }
}

function resultIdentity(result) {
  return { id: result.id, action: result.action };
}

function assertRoutingEqual(before, after, forHosts = hosts) {
  for (const request of requests(forHosts)) {
    assert.deepEqual(resultIdentity(firstMatch(after, request)), resultIdentity(firstMatch(before, request)),
      `first-match changed for ${JSON.stringify(request)}`);
  }
}

function assertUniquePriorities(rules) {
  assert.equal(new Set(rules.map((rule) => rule.priority)).size, rules.length);
  assert.equal(rules.filter((rule) => rule.priority === 'default').length, 1);
}

function assertOverlapOrder(rules) {
  const at = (id) => rules.find((rule) => rule.id === id).priority;
  assert.ok(at('engagement-preview') < at('prod-api'));
  assert.ok(at('recall-webhook') < at('prod-webhooks'));
  assert.ok(at('onboard-host') < at('onboard-path'));
  assert.ok(at('onboard-host') < at('prod-api'));
  assert.ok(at('core-guard') < at('prod-api'));
}

test('snapshot and registry cover every live rule with exact precedence-bearing predicates', () => {
  assert.equal(snapshot.rules.length, 17);
  assert.equal(registry.candidateRules.length, 18);
  assert.match(registry.status, /reported but current AWS template is unverified/);
  assert.equal(snapshot.listenerArn, registry.listenerArn);
  assertUniquePriorities(live);
  assert.equal(Object.keys(snapshot.ruleArnSuffixes).length, 17);
  assert.equal(new Set(Object.values(snapshot.ruleArnSuffixes)).size, 17);
  for (const rule of live) {
    assert.match(snapshot.ruleArnSuffixes[rule.id], /^[0-9a-f]{16}$/);
    if (rule.action.type === 'forward') {
      assert.match(snapshot.targetGroupArns[rule.action.target], /^arn:aws:elasticloadbalancing:/);
    } else {
      assert.equal(rule.action.statusCode, 404);
    }
  }
  assert.deepEqual(live.map(({ id, priority }) => [id, priority]), [
    ['core-post', 1], ['core-membership', 2], ['core-guard', 3],
    ['engagement-callbacks', 5], ['engagement-preview', 6], ['recall-webhook', 7],
    ['onboard-host', 8], ['onboard-path', 9], ['prod-api', 10], ['prod-strategy', 11],
    ['prod-workspace', 12], ['prod-meriv2', 13], ['dev-intel', 14],
    ['prod-webhooks', 15], ['marketing-host', 20], ['os-host', 50], ['default', 'default'],
  ]);
  assert.deepEqual(live.find((rule) => rule.id === 'engagement-preview').conditions, {
    headers: { 'X-Capiro-Engagement-Preview': ['v3'] }, paths: ['/api/engagement/*'],
  });
  assert.deepEqual(live.find((rule) => rule.id === 'recall-webhook').conditions.paths,
    ['/webhooks/recall', '/webhooks/recall/*']);
  assert.deepEqual(live.find((rule) => rule.id === 'onboard-path').conditions.paths, ['/onboard-api/*']);
  assert.deepEqual(live.find((rule) => rule.id === 'prod-api').conditions.paths, ['/api/*']);
  assert.deepEqual(live.find((rule) => rule.id === 'prod-webhooks').conditions.paths, ['/webhooks/*']);
});

test('Core, Meri and manual-script candidate priorities agree with the shared registry', () => {
  const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const core = source('infra/cdk/lib/preview/first-chat-core.ts');
  const meri = source('infra/cdk/lib/preview/first-chat-meri-ingress.ts');
  const engagement = source('scripts/engagement-api-alb-rules.sh');
  const onboard = source('scripts/onboard-alb-rules.sh');
  const at = (id) => registry.candidateRules.find((item) => item.id === id).candidatePriority;
  assert.match(core, new RegExp(`FIRST_CHAT_CORE_COMPACT_GUARD_PRIORITY\\s*=\\s*${at('core-guard')};`));
  assert.match(core, /FirstChatPostsOnly'[\s\S]*?priority: 1,/);
  assert.match(core, /FirstChatMembershipPostOnly'[\s\S]*?priority: 2,/);
  assert.equal(registry.candidateRules.some((item) => item.id === 'core-get'), false);
  assert.match(meri, new RegExp(`FIRST_CHAT_MERI_INGRESS_PRIORITY\\s*=\\s*${at('meri-preview')};`));
  assert.match(meri, /FIRST_CHAT_MERI_HOST = 'meri-preview\.capiro\.ai'/);
  assert.ok(engagement.includes(`PREVIEW_RULE_PRIORITY="${'${PREVIEW_RULE_PRIORITY:-' + at('engagement-preview') + '}'}"`));
  assert.ok(onboard.includes(`HOST_PRIORITY="${'${HOST_PRIORITY:-' + at('onboard-host') + '}'}"`));
  assert.ok(onboard.includes(`PATH_PRIORITY="${'${PATH_PRIORITY:-' + at('onboard-path') + '}'}"`));
});

test('each individual relocation preserves first match across the sampled boundary matrix', () => {
  // The only path rule that crosses priorities 10–15 is /onboard-api/*.
  // All crossed rules have a distinct anchored prefix, so normalization
  // cannot make both match the same presented path.
  const onboardPrefix = '/onboard-api/';
  for (const rule of live.filter((item) => Number.isInteger(item.priority) && item.priority >= 10 && item.priority <= 15)) {
    for (const pattern of rule.conditions.paths) {
      const prefix = pattern.slice(0, -1);
      assert.ok(!prefix.startsWith(onboardPrefix) && !onboardPrefix.startsWith(prefix),
        `${rule.id} overlaps the moved onboard path rule`);
    }
  }
  let previous = live;
  assertOverlapOrder(previous);
  for (const move of registry.relocationOrder) {
    const next = movePriority(previous, move.id, move.from, move.to);
    assertUniquePriorities(next);
    assertOverlapOrder(next);
    assertRoutingEqual(previous, next);
    const priorRule = previous.find((rule) => rule.id === move.id);
    const nextRule = next.find((rule) => rule.id === move.id);
    assert.deepEqual({ ...nextRule, priority: move.from }, priorRule,
      `${move.id} must retain its identity, conditions and target`);
    previous = next;
  }
  for (const rule of previous) {
    const expected = registry.candidateRules.find((entry) => entry.id === rule.id);
    assert.equal(rule.priority, expected.candidatePriority);
  }
});

test('the proposed Meri deny is host-only and intercepts all paths before production and header routes', () => {
  let relocated = live;
  for (const move of registry.relocationOrder) {
    relocated = movePriority(relocated, move.id, move.from, move.to);
  }
  const held = addMeriRule(relocated);
  const meriSource = readFileSync(new URL('../../infra/cdk/lib/preview/first-chat-meri-ingress.ts', import.meta.url), 'utf8');
  const sourceDenyBody = meriSource.match(/messageBody:\s*'([^']+)'/)?.[1];
  assert.equal(held.find((rule) => rule.id === 'meri-preview').action.body, sourceDenyBody);
  assertUniquePriorities(held);
  assertRoutingEqual(relocated, held, hosts.filter((host) => host.toLowerCase() !== meriHost));
  for (const request of requests([meriHost, meriHost.toUpperCase()])) {
    const result = firstMatch(held, request);
    assert.equal(result.id, 'meri-preview', JSON.stringify(request));
    assert.equal(result.action.type, 'fixed-response');
    assert.equal(result.action.statusCode, 404);
  }
  assert.equal(firstMatch(held, {
    host: 'app.capiro.ai', path: '/api/engagement/x', method: 'GET',
    headers: { 'X-Capiro-Engagement-Preview': 'v3' },
  }).id, 'engagement-preview');
  assert.equal(firstMatch(held, {
    host: 'app.capiro.ai', path: '/webhooks/recall', method: 'POST', headers: {},
  }).id, 'recall-webhook');
  assert.equal(firstMatch(held, {
    host: 'app.capiro.ai', path: '/onboard-api/public/config', method: 'GET', headers: {},
  }).id, 'onboard-path');
});

test('reported compact Core layout preserves snapshot IDs for four POSTs and three GETs', () => {
  let relocated = live;
  for (const move of registry.relocationOrder) {
    relocated = movePriority(relocated, move.id, move.from, move.to);
  }
  const held = addMeriRule(relocated);
  const compact = compactCorePreviewRules(held);
  assertUniquePriorities(compact);
  assert.equal(compact.length, held.length);
  assert.deepEqual(compact.map(({ id }) => id), held.map(({ id }) => id));
  assertRoutingEqual(held, compact, hosts.filter((host) => host.toLowerCase() !== coreHost));
  for (const before of held.filter((rule) => !['core-post', 'core-membership'].includes(rule.id))) {
    assert.deepEqual(compact.find((rule) => rule.id === before.id), before,
      `${before.id} must retain its exact conditions, action and priority`);
  }
  const postPaths = new Set([
    '/api/clio/conversations/bootstrap',
    '/api/clio/application-authority/identity',
    '/api/clio/application-authority/context',
    '/api/clio/application-authority/membership',
  ]);
  const getPaths = new Set(['/api/me', '/api/clients', `/api/clients/${validClient}`]);
  for (const request of requests([coreHost, coreHost.toUpperCase()])) {
    const path = request.path.split('?')[0];
    const after = firstMatch(compact, request);
    if (request.method === 'POST' && postPaths.has(path)) {
      assert.equal(after.id, 'core-post', JSON.stringify(request));
      assert.deepEqual(after.action, { type: 'forward', target: 'core-preview' });
    } else if (request.method === 'GET' && getPaths.has(path)) {
      assert.equal(after.id, 'core-membership', JSON.stringify(request));
      assert.deepEqual(after.action, { type: 'forward', target: 'core-preview' });
    } else {
      assert.equal(after.id, 'core-guard', JSON.stringify(request));
      assert.equal(after.action.statusCode, 404);
    }
  }
  assert.equal(firstMatch(compact, {
    host: coreHost, path: '/health', method: 'GET', headers: {},
  }).id, 'core-guard');
  assert.equal(firstMatch(compact, {
    host: coreHost, path: `/api/clients/${validClient}/history`, method: 'GET', headers: {},
  }).id, 'core-guard');
  assert.equal(firstMatch(compact, {
    host: coreHost, path: '/api/me', method: 'POST', headers: {},
  }).id, 'core-guard');
});

test('Core preview packet adds the P3 native-operations rule, moves only the guard, and routes every packet path', () => {
  const routes = readCoreRoutes();
  const meriTools = JSON.parse(readFileSync(new URL('../cdk/lib/preview/first-chat-core-meri-tools.json', import.meta.url), 'utf8')).tools;
  const source = readFileSync(new URL('../../infra/cdk/lib/preview/first-chat-core.ts', import.meta.url), 'utf8');
  assert.match(source, /import routes from '\.\/first-chat-core-routes\.json';/);
  let relocated = live;
  for (const move of registry.relocationOrder) relocated = movePriority(relocated, move.id, move.from, move.to);
  const compact = compactCorePreviewRules(addMeriRule(relocated));
  assert.throws(() => corePreviewPacketRules(compact, routes), /Readback-verified/);
  const packet = corePreviewPacketRules(compact, routes, { guardPriority: 4 });
  assertUniquePriorities(packet);
  const priorities = (rules) => Object.fromEntries(rules.map(({ id, priority }) => [id, priority]));
  assert.deepEqual(priorities(packet), { ...priorities(compact), 'core-guard': 4, 'core-native-ops': routes.packet.nativeOps });
  assertRoutingEqual(compact, packet, hosts.filter((host) => host.toLowerCase() !== coreHost));
  for (const rule of packet.filter((item) => ['core-post', 'core-membership', 'core-native-ops'].includes(item.id))) {
    assert.ok(rule.conditions.pathRegexes.length <= 3);
    for (const regex of rule.conditions.pathRegexes) assert.ok(regex.length <= 128, regex);
  }
  const at = (method, path) => firstMatch(packet, { host: coreHost, path, method, headers: {} });
  for (const path of [
    '/api/clio/conversations/bootstrap', '/api/clio/clients/check-ref',
    '/api/clio/application-authority/identity', '/api/clio/application-authority/context',
    '/api/clio/application-authority/membership', '/api/clio/application-authority/read-mode-observation',
    '/api/clio/application-authority/retained-research-portfolio',
    '/api/clio/application-authority/retained-research-portfolio-changes',
    '/api/clio/application-authority/retained-florida-budget',
    '/api/clio/application-authority/retained-research-portfolio-principal',
    '/api/clio/application-authority/retained-research-portfolio-changes-principal',
    '/api/clio/application-authority/retained-florida-principal',
    '/api/clio/application-authority/retained-florida-current',
    '/api/clio/application-authority/retained-florida-native-current',
    '/api/clio/retained-reads/research-portfolio', '/api/clio/retained-reads/research-portfolio-changes',
    ...meriTools.map((name) => `/api/clio/tools/${name}`),
  ]) assert.equal(at('POST', path).id, 'core-post', path);
  for (const path of [
    '/api/me', '/api/clients', `/api/clients/${validClient}`,
    `/api/research-portfolios/${validClient}`, `/api/research-portfolios/${validClient}/changes`,
    `/api/research-portfolios/${validClient}/reviews`, `/api/research-portfolios/${validClient}/annual-review`,
    `/api/research-portfolios/${validClient}/snapshots/${validClient}`,
  ]) assert.equal(at('GET', path).id, 'core-membership', path);
  for (const path of [
    '/api/clio/approvals/native/record', '/api/clio/approvals/native/decision',
    '/api/clio/memory/review/submit', '/api/clio/memory/review/status',
    '/api/clio/memory/read_target', '/api/clio/memory/find_by_key',
  ]) {
    assert.equal(at('POST', path).id, 'core-native-ops', path);
    assert.equal(at('GET', path).id, 'core-guard', `GET ${path}`);
  }
  // Recorded perimeter tradeoff: a syntactically valid unlisted tool reaches Core,
  // which refuses it after authentication through the mandatory preview allowlist.
  assert.equal(at('POST', '/api/clio/tools/send_email').id, 'core-post');
  for (const [method, path] of [
    ['POST', '/api/clio/tools/'], ['POST', '/api/clio/tools/Send'], ['POST', '/api/clio/tools/a/b'],
    ['GET', '/api/clio/tools/search_federal_grants'], ['POST', '/api/clio/approvals/check'],
    ['GET', `/api/research-portfolios/${validClient}/analytics`], ['GET', '/health'], ['POST', '/webhooks/recall'],
    ['POST', '/api/clio/approvals/native/read'], ['POST', '/api/clio/memory/recent'],
    ['POST', '/api/clio/memory/review/submit/x'], ['POST', '/api/clio/memory/read_target/'],
  ]) assert.equal(at(method, path).id, 'core-guard', `${method} ${path}`);
  assert.throws(() => corePreviewPacketRules(packet, routes, { guardPriority: 4 }), /Exact compact Core/);
});

test('the Core guard slot comes from the listener readback and is never assumed', () => {
  const routes = readCoreRoutes();
  let relocated = live;
  for (const move of registry.relocationOrder) relocated = movePriority(relocated, move.id, move.from, move.to);
  const compact = compactCorePreviewRules(addMeriRule(relocated));
  // 3 is the native-operations slot; 5 and 6 are occupied; 7 is the first
  // shared rule that can match the Core host (the header route), so 7 or later
  // would let it precede the guard.
  for (const guardPriority of [undefined, null, '4', 4.5, 2, 3, 5, 6, 7, 8, 50001]) {
    assert.throws(() => corePreviewPacketRules(compact, routes, { guardPriority }), /Readback-verified/, String(guardPriority));
  }
  // Earlier live reports placed Meri's public rule at 4. On such a readback
  // 4 is refused and the slot Meri left qualifies instead.
  const meriAtFour = movePriority(compact, 'meri-preview', 6, 4);
  assert.throws(() => corePreviewPacketRules(meriAtFour, routes, { guardPriority: 4 }), /Readback-verified/);
  const packet = corePreviewPacketRules(meriAtFour, routes, { guardPriority: 6 });
  assertUniquePriorities(packet);
  assertRoutingEqual(meriAtFour, packet, hosts.filter((host) => host.toLowerCase() !== coreHost));
  assert.equal(firstMatch(packet, {
    host: coreHost, path: '/api/engagement/x', method: 'GET', headers: { 'X-Capiro-Engagement-Preview': 'v3' },
  }).id, 'core-guard');
});

test('one stable Meri rule performs deny, forward, deny without any production fallthrough', () => {
  let candidate = live;
  for (const move of registry.relocationOrder) {
    candidate = movePriority(candidate, move.id, move.from, move.to);
  }
  candidate = addMeriRule(candidate);
  candidate = compactCorePreviewRules(candidate);
  const forwarded = setMeriAction(candidate, 'forward');
  const deniedAgain = setMeriAction(forwarded, 'deny');
  assertUniquePriorities(candidate);
  assertUniquePriorities(forwarded);
  assertUniquePriorities(deniedAgain);
  assert.deepEqual(deniedAgain, candidate);
  for (const request of requests([meriHost, meriHost.toUpperCase()])) {
    for (const [rules, type] of [[candidate, 'fixed-response'], [forwarded, 'forward'], [deniedAgain, 'fixed-response']]) {
      const result = firstMatch(rules, request);
      assert.equal(result.id, 'meri-preview', JSON.stringify(request));
      assert.equal(result.action.type, type, JSON.stringify(request));
      assert.notEqual(result.action.target, 'prod-api');
      assert.notEqual(result.action.target, 'prod-web');
    }
  }
  assertRoutingEqual(candidate, forwarded, hosts.filter((host) => host.toLowerCase() !== meriHost));
  assertRoutingEqual(candidate, deniedAgain);
  assert.deepEqual(candidate.map(({ id, priority }) => [id, priority]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    registry.candidateRules.map(({ id, candidatePriority }) => [id, candidatePriority]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
});

test('vacancy and unknown action checks refuse an ambiguous rollout', () => {
  assert.throws(() => movePriority(live, 'onboard-path', 9, 10), /occupied/);
  assert.throws(() => movePriority(live, 'onboard-host', 9, 16), /not at/);
  assert.throws(() => addMeriRule(live), /occupied/);
  assert.throws(() => addMeriRule([], 'prod-api'), /Unknown Meri action/);
  const driftedCore = structuredClone(live);
  driftedCore.find((rule) => rule.id === 'core-membership').conditions.paths = ['/api/clio/application-authority/other'];
  assert.throws(() => compactCorePreviewRules(driftedCore), /Exact historical Core/);
  assert.throws(() => compactCorePreviewRules(compactCorePreviewRules(live)), /Exact historical Core/);
  assert.throws(() => setMeriAction(live, 'forward'), /Stable Meri rule/);
  assert.throws(() => setMeriAction(live, 'prod-api'), /Unknown Meri action/);
  let relocated = live;
  for (const move of registry.relocationOrder) {
    relocated = movePriority(relocated, move.id, move.from, move.to);
  }
  const drifted = addMeriRule(relocated);
  drifted.find((rule) => rule.id === 'meri-preview').conditions.hosts = ['app.capiro.ai'];
  assert.throws(() => setMeriAction(drifted, 'forward'), /Exact Meri host/);
});
