import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const here = new URL('.', import.meta.url);
const meriConditions = { hosts: ['meri-preview.capiro.ai'] };
const meriDenyAction = {
  type: 'fixed-response',
  statusCode: 404,
  contentType: 'application/json',
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
  return JSON.parse(
    readFileSync(new URL('../cdk/lib/preview/first-chat-core-routes.json', here), 'utf8'),
  );
}

export function cloneRules(rules) {
  return structuredClone(rules);
}

function globMatches(pattern, value, flags = '') {
  const escaped = [...pattern]
    .map((character) => {
      if (character === '*') return '.*';
      if (character === '?') return '.';
      return character.replace(/[|\\{}()[\]^$+.]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${escaped}$`, flags).test(value);
}

function matchesCondition(rule, request) {
  const conditions = rule.conditions;
  const path = request.path.split('?', 1)[0];
  const host = request.host.toLowerCase();
  if (conditions.hosts && !conditions.hosts.some((item) => globMatches(item, host, 'i')))
    return false;
  if (conditions.methods && !conditions.methods.includes(request.method)) return false;
  if (conditions.paths && !conditions.paths.some((item) => globMatches(item, path))) return false;
  if (conditions.pathRegexes && !conditions.pathRegexes.some((item) => new RegExp(item).test(path)))
    return false;
  for (const [name, values] of Object.entries(conditions.headers ?? {})) {
    const received = Object.entries(request.headers ?? {}).find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    );
    if (!received || !values.some((item) => globMatches(item, String(received[1]), 'i')))
      return false;
  }
  return true;
}

/**
 * Offline precedence model over the frozen conditions. `request.path` is the
 * path presented to rule matching; real ALB URI normalization is not modeled.
 * Confirm encoded-path behavior with separate live negative probes before use.
 */
export function firstMatch(rules, request) {
  const ordered = [...rules].sort(
    (a, b) =>
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

export function addMeriRule(rules, action = 'deny') {
  if (!['deny', 'forward'].includes(action)) throw new Error('Unknown Meri action');
  const next = cloneRules(rules);
  if (next.some((rule) => rule.priority === 6 || rule.id === 'meri-preview')) {
    throw new Error('Meri priority or rule is already occupied');
  }
  next.push({
    id: 'meri-preview',
    priority: 6,
    conditions: structuredClone(meriConditions),
    action:
      action === 'deny' ? structuredClone(meriDenyAction) : structuredClone(meriForwardAction),
  });
  return next;
}

export function setMeriAction(rules, action) {
  if (!['deny', 'forward'].includes(action)) throw new Error('Unknown Meri action');
  const next = cloneRules(rules);
  const rule = next.find((item) => item.id === 'meri-preview');
  if (!rule || rule.priority !== 6) throw new Error('Stable Meri rule at priority 6 required');
  if (
    !isDeepStrictEqual(rule.conditions, meriConditions) ||
    ![meriDenyAction, meriForwardAction].some((expected) =>
      isDeepStrictEqual(rule.action, expected),
    )
  ) {
    throw new Error('Exact Meri host and previous action required');
  }
  rule.action =
    action === 'deny' ? structuredClone(meriDenyAction) : structuredClone(meriForwardAction);
  return next;
}

/** Update only the existing Core POST rule from the observed October 24 layout.
 * This is an offline model: no AWS call, guard move, new rule or target change. */
export function corePreviewPacketRules(rules, routes = readCoreRoutes()) {
  const next = cloneRules(rules);
  const one = (id) => next.filter((rule) => rule.id === id);
  const [post] = one('core-post');
  const [reads] = one('core-membership');
  const [guard] = one('core-guard');
  const host = routes.host;
  if (
    new Set(next.map((rule) => rule.priority)).size !== next.length ||
    one('core-post').length !== 1 ||
    one('core-membership').length !== 1 ||
    one('core-guard').length !== 1 ||
    post.priority !== 1 ||
    reads.priority !== 2 ||
    guard.priority !== 7 ||
    !isDeepStrictEqual(post.conditions, {
      hosts: [host],
      methods: ['POST'],
      pathRegexes: [
        '^/api/clio/(application-authority/(identity|context|membership|current)|conversations/bootstrap)$',
      ],
    }) ||
    !isDeepStrictEqual(reads.conditions, {
      hosts: [host],
      methods: ['GET', 'HEAD'],
      paths: ['/api/*'],
    }) ||
    !isDeepStrictEqual(guard.conditions, { hosts: [host] }) ||
    post.action.type !== 'forward' ||
    !isDeepStrictEqual(post.action, reads.action) ||
    !isDeepStrictEqual(guard.action, {
      type: 'fixed-response',
      statusCode: 404,
      contentType: 'application/json',
      body: '{"error":"PREVIEW_ROUTE_NOT_FOUND"}',
    })
  ) {
    throw new Error('Exact current Core rules and retained priority-7 guard required');
  }
  if (
    routes.schemaVersion !== 2 ||
    routes.post.length !== 2 ||
    routes.post.some(
      (pattern) =>
        typeof pattern !== 'string' ||
        pattern.length > 128 ||
        !pattern.startsWith('^') ||
        !pattern.endsWith('$'),
    )
  ) {
    throw new Error('Bounded current Core POST patterns required');
  }
  post.conditions = { hosts: [host], methods: ['POST'], pathRegexes: [...routes.post] };
  return next;
}
