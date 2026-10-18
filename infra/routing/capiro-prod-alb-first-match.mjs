import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const here = new URL('.', import.meta.url);
const meriConditions = { hosts: ['meri-preview.capiro.ai'] };
const meriDenyAction = {
  type: 'fixed-response', statusCode: 404, contentType: 'application/json',
  body: '{"error":"MERI_PREVIEW_ROUTE_NOT_FOUND"}',
};
const meriForwardAction = { type: 'forward', target: 'meri-preview-control' };

export function readListenerFixture() {
  return JSON.parse(readFileSync(new URL('capiro-prod-alb-snapshot.json', here), 'utf8'));
}

export function readPriorityRegistry() {
  return JSON.parse(readFileSync(new URL('capiro-prod-alb-priorities.json', here), 'utf8'));
}

/** Core listener patterns shared with infra/cdk/lib/preview/first-chat-core.ts. */
export function readCoreRoutes() {
  return JSON.parse(readFileSync(new URL('../cdk/lib/preview/first-chat-core-routes.json', here), 'utf8'));
}

function registryPriority(id) {
  return readPriorityRegistry().candidateRules.find((rule) => rule.id === id).candidatePriority;
}

export function cloneRules(rules) {
  return structuredClone(rules);
}

function globMatches(pattern, value, flags = '') {
  const escaped = [...pattern].map((character) => {
    if (character === '*') return '.*';
    if (character === '?') return '.';
    return character.replace(/[|\\{}()[\]^$+.]/g, '\\$&');
  }).join('');
  return new RegExp(`^${escaped}$`, flags).test(value);
}

function matchesCondition(rule, request) {
  const conditions = rule.conditions;
  const path = request.path.split('?', 1)[0];
  const host = request.host.toLowerCase();
  if (conditions.hosts && !conditions.hosts.some((item) => globMatches(item, host, 'i'))) return false;
  if (conditions.methods && !conditions.methods.includes(request.method)) return false;
  if (conditions.paths && !conditions.paths.some((item) => globMatches(item, path))) return false;
  if (conditions.pathRegexes && !conditions.pathRegexes.some((item) => new RegExp(item).test(path))) return false;
  for (const [name, values] of Object.entries(conditions.headers ?? {})) {
    const received = Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (!received || !values.some((item) => globMatches(item, String(received[1]), 'i'))) return false;
  }
  return true;
}

/**
 * Offline precedence model over the frozen conditions. `request.path` is the
 * path presented to rule matching; real ALB URI normalization is not modeled.
 * Confirm encoded-path behavior with separate live negative probes before use.
 */
export function firstMatch(rules, request) {
  const ordered = [...rules].sort((a, b) =>
    (a.priority === 'default' ? Number.POSITIVE_INFINITY : a.priority) -
    (b.priority === 'default' ? Number.POSITIVE_INFINITY : b.priority),
  );
  for (const rule of ordered) {
    if (matchesCondition(rule, request)) {
      return { id: rule.id, priority: rule.priority, action: structuredClone(rule.action) };
    }
  }
  throw new Error('Snapshot is missing its default rule');
}

export function movePriority(rules, id, from, to) {
  const next = cloneRules(rules);
  const current = next.find((rule) => rule.id === id);
  if (!current || current.priority !== from) throw new Error(`${id} is not at ${from}`);
  if (next.some((rule) => rule.priority === to)) throw new Error(`priority ${to} is occupied`);
  current.priority = to;
  return next;
}

export function addMeriRule(rules, action = 'deny', priority = registryPriority('meri-preview')) {
  if (!['deny', 'forward'].includes(action)) throw new Error('Unknown Meri action');
  const next = cloneRules(rules);
  if (next.some((rule) => rule.priority === priority || rule.id === 'meri-preview')) {
    throw new Error('Meri priority or rule is already occupied');
  }
  next.push({
    id: 'meri-preview',
    priority,
    conditions: structuredClone(meriConditions),
    action: action === 'deny'
      ? structuredClone(meriDenyAction)
      : structuredClone(meriForwardAction),
  });
  return next;
}

export function setMeriAction(rules, action) {
  if (!['deny', 'forward'].includes(action)) throw new Error('Unknown Meri action');
  const next = cloneRules(rules);
  const rule = next.find((item) => item.id === 'meri-preview');
  if (!rule || rule.priority !== registryPriority('meri-preview')) throw new Error('Stable Meri rule at its reserved priority required');
  if (!isDeepStrictEqual(rule.conditions, meriConditions) ||
      ![meriDenyAction, meriForwardAction].some((expected) => isDeepStrictEqual(rule.action, expected))) {
    throw new Error('Exact Meri host and previous action required');
  }
  rule.action = action === 'deny'
    ? structuredClone(meriDenyAction)
    : structuredClone(meriForwardAction);
  return next;
}

/**
 * Source-only transform from the frozen historical snapshot to the reported
 * compact layout. The old priority-2 rule identity is retained but changes
 * from membership POST to the three exact GETs. This does not prove the
 * current AWS template or perform an ALB mutation.
 */
export function compactCorePreviewRules(rules) {
  const next = cloneRules(rules);
  const post = next.filter((rule) => rule.id === 'core-post');
  const second = next.filter((rule) => rule.id === 'core-membership');
  const guard = next.filter((rule) => rule.id === 'core-guard');
  if (post.length !== 1 || second.length !== 1 || guard.length !== 1 ||
      next.some((rule) => rule.id === 'core-get') ||
      post[0].priority !== 1 || second[0].priority !== 2 || guard[0].priority !== 3 ||
      !isDeepStrictEqual(post[0].conditions, {
        methods: ['POST'], hosts: ['first-chat-preview.app-dev.capiro.ai'],
        paths: ['/api/clio/application-authority/identity', '/api/clio/conversations/bootstrap',
          '/api/clio/application-authority/context'],
      }) ||
      !isDeepStrictEqual(second[0].conditions, {
        methods: ['POST'], hosts: ['first-chat-preview.app-dev.capiro.ai'],
        paths: ['/api/clio/application-authority/membership'],
      }) ||
      !isDeepStrictEqual(guard[0].conditions, { hosts: ['first-chat-preview.app-dev.capiro.ai'] }) ||
      !isDeepStrictEqual(post[0].action, { type: 'forward', target: 'core-preview' }) ||
      !isDeepStrictEqual(second[0].action, post[0].action) ||
      !isDeepStrictEqual(guard[0].action, {
        type: 'fixed-response', statusCode: 404, contentType: 'application/json',
        body: '{"error":"PREVIEW_ROUTE_NOT_FOUND"}',
      })) {
    throw new Error('Exact historical Core priority-1/2 rules and priority-3 guard required');
  }
  post[0].conditions = {
    hosts: ['first-chat-preview.app-dev.capiro.ai'], methods: ['POST'],
    pathRegexes: ['^/api/clio/(conversations/bootstrap|application-authority/(identity|context|membership))$'],
  };
  second[0].conditions = {
    hosts: ['first-chat-preview.app-dev.capiro.ai'], methods: ['GET'],
    pathRegexes: [
      '^/api/me$',
      '^/api/clients$',
      '^/api/clients/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    ],
  };
  return next;
}

/**
 * Source-only transform from the compact layout (after the registry relocation
 * and the held Meri rule) to the enumerated Core layout: rule 1 carries the
 * non-tool POSTs, rule 2 the native GETs, and new rules at the reserved
 * priorities carry the exact Meri tool names, all before the moved guard.
 */
export function enumeratedCorePreviewRules(rules, routes = readCoreRoutes()) {
  const next = cloneRules(rules);
  const host = 'first-chat-preview.app-dev.capiro.ai';
  const forward = { type: 'forward', target: 'core-preview' };
  const post = next.filter((rule) => rule.id === 'core-post');
  const second = next.filter((rule) => rule.id === 'core-membership');
  const guard = next.filter((rule) => rule.id === 'core-guard');
  if (post.length !== 1 || second.length !== 1 || guard.length !== 1 ||
      next.some((rule) => rule.id.startsWith('core-tools-')) ||
      post[0].priority !== routes.priorities.post || second[0].priority !== routes.priorities.get ||
      guard[0].priority !== routes.priorities.guard ||
      !isDeepStrictEqual(post[0].conditions, {
        hosts: [host], methods: ['POST'],
        pathRegexes: ['^/api/clio/(conversations/bootstrap|application-authority/(identity|context|membership))$'],
      }) ||
      second[0].conditions.methods?.[0] !== 'GET' ||
      !isDeepStrictEqual(post[0].action, forward) || !isDeepStrictEqual(second[0].action, forward)) {
    throw new Error('Exact compact Core rules and relocated guard required');
  }
  if (routes.tools.length !== routes.priorities.tools.length ||
      routes.priorities.tools.some((priority) => next.some((rule) => rule.priority === priority))) {
    throw new Error('Reserved Core tool priorities must be vacant');
  }
  post[0].conditions = { hosts: [host], methods: ['POST'], pathRegexes: [...routes.post] };
  second[0].conditions = { hosts: [host], methods: ['GET'], pathRegexes: [...routes.get] };
  routes.tools.forEach((group, index) => {
    next.push({
      id: `core-tools-${index + 1}`,
      priority: routes.priorities.tools[index],
      conditions: { hosts: [host], methods: ['POST'], pathRegexes: [...group] },
      action: structuredClone(forward),
    });
  });
  return next;
}
