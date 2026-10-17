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
  if (!rule || rule.priority !== 6) throw new Error('Stable Meri rule at priority 6 required');
  if (!isDeepStrictEqual(rule.conditions, meriConditions) ||
      ![meriDenyAction, meriForwardAction].some((expected) => isDeepStrictEqual(rule.action, expected))) {
    throw new Error('Exact Meri host and previous action required');
  }
  rule.action = action === 'deny'
    ? structuredClone(meriDenyAction)
    : structuredClone(meriForwardAction);
  return next;
}

export function addCoreGetRule(rules) {
  const next = cloneRules(rules);
  if (next.some((rule) => rule.priority === 3 || rule.id === 'core-get')) {
    throw new Error('Core GET priority or rule is already occupied');
  }
  next.push({
    id: 'core-get',
    priority: 3,
    conditions: {
      hosts: ['first-chat-preview.app-dev.capiro.ai'],
      methods: ['GET'],
      pathRegexes: [
        '^/api/me$',
        '^/api/clients$',
        '^/api/clients/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      ],
    },
    action: { type: 'forward', target: 'core-preview' },
  });
  return next;
}
