import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_PLAN_PATTERN_SOURCES,
  PROPOSED_PLAN_ROUTES,
  matchesProposedCorePlanOperation as match,
} from './plan-preview-candidate.mjs';

const P = '10000000-0000-4000-8000-0000000000ab';
const W = '20000000-0000-4000-8000-0000000000cd';
const ROOT = '/api/engagement/plans';
const materialize = (path) => path.replace(':planId', P).replace(':waveId', W);

test('all nine exact fixed-operation/method/path tuples match the preserved Core manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json', import.meta.url), 'utf8'));
  const actual = manifest.routes.filter((r) => r.controller === 'EngagementPlansController');
  assert.equal(actual.length, 9);
  assert.equal(PROPOSED_PLAN_ROUTES.length, 9);
  for (const candidate of PROPOSED_PLAN_ROUTES) {
    assert.equal(match(candidate.operationKey, candidate.method, materialize(candidate.path)), true);
    const source = actual.find((r) => r.path === candidate.path && r.method === candidate.method);
    assert.ok(source, `Missing preserved Core tuple ${candidate.method} ${candidate.path}`);
    assert.equal(source.handler, candidate.handler);
    assert.deepEqual(source.controllerGuards, ['RolesGuard']);
    assert.deepEqual(source.controllerRoles, ['standard_user']);
  }
});

test('operation identity cannot be selected from another operation sharing a pathname', () => {
  for (const expected of PROPOSED_PLAN_ROUTES) {
    for (const supplied of PROPOSED_PLAN_ROUTES) {
      assert.equal(match(expected.operationKey, supplied.method, materialize(supplied.path)), expected === supplied);
    }
  }
});

test('wrong methods, case aliases and framework verbs never gain candidate eligibility', () => {
  for (const row of PROPOSED_PLAN_ROUTES) {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', row.method.toLowerCase(), ` ${row.method}`, `${row.method} `]) {
      assert.equal(match(row.operationKey, method, materialize(row.path)), method === row.method);
    }
  }
});

test('all unallocated operation siblings remain absent', () => {
  for (const key of ['engagement.plans.delete', 'engagement.plans.recommendations', 'engagement.plans.windows', 'engagement.plans.availability', 'engagement.plans.assignments', 'engagement.plans.wave.execute', 'engagement.plans.wave.send', 'engagement.plans.list.extra', '__proto__', 'constructor', 'ENGAGEMENT.PLANS.LIST']) {
    for (const row of PROPOSED_PLAN_ROUTES) assert.equal(match(key, row.method, materialize(row.path)), false);
  }
});

test('generic legacy regex overlap does not admit reorder or recommendations as IDs', () => {
  assert.equal(new RegExp(LEGACY_PLAN_PATTERN_SOURCES[5]).test(`${ROOT}/${P}/waves/reorder`), true);
  assert.equal(new RegExp(LEGACY_PLAN_PATTERN_SOURCES[1]).test(`${ROOT}/recommendations`), true);
  assert.equal(match('engagement.plans.wave.update', 'PATCH', `${ROOT}/${P}/waves/reorder`), false);
  assert.equal(match('engagement.plans.wave.reorder', 'PATCH', `${ROOT}/${P}/waves/reorder`), false);
  assert.equal(match('engagement.plans.wave.reorder', 'POST', `${ROOT}/${P}/waves/${W}`), false);
  assert.equal(match('engagement.plans.detail', 'GET', `${ROOT}/recommendations`), false);
});

test('sibling, broader, parent, nested and noncanonical path forms all fail closed', () => {
  const bad = [
    '/api/engagement', '/api/engagement/plans-extra', '/api/engagement/plans2',
    '/api/engagement/outreach-v3/plans', '/api/backend/core/engagement/plans',
    '/engagement/plans', '/api/capiro/engagement.plans.list', `${ROOT}/`,
    `${ROOT}//${P}`, `${ROOT}/${P}/history/extra`, `${ROOT}/${P}/waves/${W}/execute`,
    `${ROOT}/${P}/availability`, `${ROOT}/${P}/windows`, `${ROOT}/${P}/recommendations`,
    `${ROOT}/${P}/wave/${W}`, `${ROOT}/${P}/waves/reorders`,
    `${ROOT}/${P}/waves/${W}/`, `/API/engagement/plans`,
    `/api/engagement/./plans`, `/api/engagement/x/../plans`,
    `https://core.example.invalid${ROOT}`, `//core.example.invalid${ROOT}`,
    `${ROOT}?clientId=${P}`, `${ROOT}#fragment`, `${ROOT}\n`, `${ROOT}\r`,
    `${ROOT}/${P.toUpperCase()}`, `${ROOT}/${P.replace('-', '%2d')}`,
    `${ROOT}/%2e%2e`, `${ROOT}/%2F${P}`, `${ROOT}/${P}%00`,
    `${ROOT}/${P}/waves%2f${W}`, `${ROOT}/${P}\\waves\\${W}`,
  ];
  for (const pathname of bad) for (const row of PROPOSED_PLAN_ROUTES) {
    assert.equal(match(row.operationKey, row.method, pathname), false, pathname);
  }
});

test('query, fragment, slash or encoding variants of every valid tuple are rejected', () => {
  for (const row of PROPOSED_PLAN_ROUTES) {
    const pathname = materialize(row.path);
    for (const mutated of [pathname + '/', pathname + '/extra', pathname + '?tenantId=other', pathname + '#x', pathname + '\u2028', pathname.replace('/api/', '/api//'), pathname.replace('/plans', '/%70lans')]) {
      assert.equal(match(row.operationKey, row.method, mutated), false, mutated);
    }
  }
});

test('unknown or object-like input cannot be coerced into an operation', () => {
  for (const value of [null, undefined, 0, true, {}, [], new String('engagement.plans.list')]) {
    assert.equal(match(value, 'GET', ROOT), false);
    assert.equal(match('engagement.plans.list', value, ROOT), false);
    assert.equal(match('engagement.plans.list', 'GET', value), false);
  }
});

test('the exact seven legacy patterns are derived from the nine paths without adding scope', () => {
  const derived = [...new Set(PROPOSED_PLAN_ROUTES.map((r) => r.path))].sort()
    .map((p) => '^' + p.replace(':planId', '[^/]+').replace(':waveId', '[^/]+') + '$');
  assert.deepEqual(derived, LEGACY_PLAN_PATTERN_SOURCES);
});

test('candidate source has no ambient HTTP/DB/header/activation dependencies', () => {
  const source = readFileSync(new URL('./plan-preview-candidate.mjs', import.meta.url), 'utf8');
  assert.equal(/\bimport\s|\bfetch\s*\(|process\.env|sessionStorage|localStorage|X-Capiro|setHeader\s*\(|Prisma|new URL\s*\(/.test(source), false);
  assert.ok(fileURLToPath(import.meta.url).includes('docs'));
});
