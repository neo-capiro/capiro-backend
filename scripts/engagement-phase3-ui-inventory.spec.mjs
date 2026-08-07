#!/usr/bin/env node
/**
 * Tests for the Phase 3 current-UI surface and API consumer inventory (3.1).
 *
 * The committed fixture is the artifact under test. Negative controls mutate a
 * deep copy and assert the verifier REJECTS it, so each invariant is proven to
 * bite rather than merely to exist.
 *
 * Run: node scripts/engagement-phase3-ui-inventory.spec.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  ROOT,
  SURFACES,
  HEURISTIC_EXEMPTIONS,
  buildUiInventory,
  verifyUiInventory,
  classifyRequest,
  heuristicClassify,
  matchRoute,
  normalizePath,
  resolveFirstArgPath,
  collectStringConstants,
  collectRuntimeActions,
} from './engagement-phase3-ui-inventory.mjs';

const MANIFEST_PATH = path.join(
  ROOT,
  'apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json',
);
const ROUTE_MANIFEST = JSON.parse(
  readFileSync(
    path.join(ROOT, 'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json'),
    'utf8',
  ),
);

const committed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const rejects = (mutate, matcher) => {
  const copy = clone(committed);
  mutate(copy);
  const problems = verifyUiInventory(copy, ROUTE_MANIFEST);
  assert.ok(problems.length > 0, 'expected the verifier to reject this manifest');
  if (matcher) {
    assert.ok(
      problems.some((p) => matcher.test(p)),
      `expected a problem matching ${matcher}, got:\n  ${problems.join('\n  ')}`,
    );
  }
};

// ───────────────────────────────────────────────────────────── committed state

test('the committed manifest is exactly what the builder generates', () => {
  assert.deepEqual(buildUiInventory({ routeManifest: ROUTE_MANIFEST }), committed);
});

test('the committed manifest passes every invariant', () => {
  assert.deepEqual(verifyUiInventory(committed, ROUTE_MANIFEST), []);
});

test('output is deterministic across repeated builds', () => {
  const first = buildUiInventory({ routeManifest: ROUTE_MANIFEST });
  const second = buildUiInventory({ routeManifest: ROUTE_MANIFEST });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second), 'key order must be stable too');
});

test('the inventory is non-trivial', () => {
  assert.ok(committed.requests.length >= 100, 'expected the real consumer set, not a stub');
  assert.ok(committed.consumerFiles.length >= 20);
  assert.equal(committed.surfaces.length, SURFACES.length);
});

// ───────────────────────────────────────────── every request maps to a route

test('every request maps to a Phase 0 route manifest entry', () => {
  const keys = new Set(ROUTE_MANIFEST.routes.map((r) => `${r.method} ${r.path}`));
  for (const entry of committed.requests) {
    assert.ok(entry.routeManifestKey, `${entry.consumerFile} ${entry.requestPath} is unmapped`);
    assert.ok(keys.has(entry.routeManifestKey), `unknown route ${entry.routeManifestKey}`);
  }
});

test('every request belongs to a declared surface', () => {
  const ids = new Set(SURFACES.map((s) => s.id));
  for (const entry of committed.requests) {
    assert.ok(ids.has(entry.surface), `${entry.consumerFile} has surface "${entry.surface}"`);
  }
});

test('every user-facing route is either consumed or explicitly api_only', () => {
  const covered = new Map(committed.routeCoverage.map((r) => [r.routeManifestKey, r.status]));
  for (const route of ROUTE_MANIFEST.routes) {
    const status = covered.get(`${route.method} ${route.path}`);
    assert.ok(
      status === 'consumed' || status === 'api_only',
      `${route.method} ${route.path} has no coverage entry`,
    );
  }
  assert.equal(
    committed.totals.routesConsumed + committed.totals.routesApiOnly,
    ROUTE_MANIFEST.routes.length,
  );
});

// ─────────────────────────────────────────────────────────────── classification

test('classification is driven by @EngagementRuntimeAction, not by URL shape', () => {
  for (const entry of committed.requests) {
    if (entry.classification === 'external_action') {
      assert.ok(
        entry.runtimeAction,
        `${entry.routeManifestKey} is external but declares no runtime action`,
      );
    } else {
      assert.equal(
        entry.runtimeAction,
        null,
        `${entry.routeManifestKey} declares a runtime action but is not external`,
      );
    }
  }
});

test('the decorator scan finds the real runtime actions', () => {
  const actions = collectRuntimeActions();
  assert.ok(actions.size >= 25, `expected the full decorator set, found ${actions.size}`);
  assert.ok([...actions.values()].includes('outreach_send'));
  assert.ok([...actions.values()].includes('notetaker_dispatch'));
});

test('every send endpoint is external, including send-batch and jobs/send', () => {
  const sendRoutes = committed.routeCoverage.filter((r) =>
    /\/send(-|$)/.test(r.routeManifestKey.split(' ')[1]),
  );
  const exempt = new Set(HEURISTIC_EXEMPTIONS.map((e) => e.route));
  assert.ok(sendRoutes.length >= 4, 'expected several send routes in the manifest');
  for (const route of sendRoutes) {
    // A GET reads status; the two exemptions are proven database-local.
    if (route.routeManifestKey.startsWith('GET ')) continue;
    if (exempt.has(route.routeManifestKey)) continue;
    assert.ok(
      route.runtimeAction,
      `${route.routeManifestKey} is a send route with no runtime action`,
    );
  }
  // The exemptions must not have quietly swallowed the real send routes.
  const realSends = sendRoutes.filter(
    (r) => !r.routeManifestKey.startsWith('GET ') && !exempt.has(r.routeManifestKey),
  );
  assert.ok(realSends.length >= 3, 'exemptions must not absorb every send route');
  assert.ok(
    realSends.some((r) => r.routeManifestKey.includes('send-batch')),
    'send-batch must remain a checked send route',
  );
});

test('a GET is never classified as a local write', () => {
  for (const entry of committed.requests) {
    if (entry.method === 'GET') {
      assert.notEqual(entry.classification, 'safe_local_write', entry.routeManifestKey);
    }
  }
});

test('every heuristic exemption cites evidence and names a live route', () => {
  const present = new Set(committed.requests.map((e) => e.routeManifestKey));
  for (const exemption of HEURISTIC_EXEMPTIONS) {
    assert.ok(exemption.reason.length > 30, `${exemption.route} needs a real reason`);
    assert.match(exemption.evidence, /\.ts:\d+/, `${exemption.route} needs a source citation`);
    assert.ok(present.has(exemption.route), `${exemption.route} is stale`);
  }
});

// ───────────────────────────────────────────── Outreach v2 is the sole wizard

test('Outreach v2 is the sole production wizard and OutreachView is inventoried', () => {
  assert.ok(committed.consumerFiles.includes('apps/web/src/pages/engagement/OutreachView.tsx'));
  assert.ok(
    committed.consumerFiles.some((f) => f.includes('outreach/v2/NewOutreachWizard.tsx')),
    'the v2 wizard must be inventoried',
  );
});

test('no Outreach V3 route or component exists', () => {
  for (const file of committed.consumerFiles) {
    assert.doesNotMatch(file, /outreach\/v3|outreach-v3/i, `V3 consumer: ${file}`);
  }
  for (const entry of committed.requests) {
    assert.doesNotMatch(entry.requestPath, /\/outreach\/v3(\/|$)|campaign-spec|checkpoints/i);
  }
});

test('every surface declares loading, empty, error and permission states', () => {
  for (const surface of committed.surfaces) {
    for (const state of ['loading', 'empty', 'error', 'permission_denied']) {
      assert.ok(surface.requiredStates.includes(state), `${surface.id} missing ${state}`);
    }
  }
});

// ──────────────────────────────────────────────────────── required negative controls

test('NEGATIVE CONTROL: a fake missing route is rejected', () => {
  rejects((m) => {
    m.requests[0].routeManifestKey = 'GET /api/engagement/this-route-does-not-exist';
  }, /unknown route key/);
});

test('NEGATIVE CONTROL: an unmapped request is rejected', () => {
  rejects((m) => {
    m.requests[0].routeManifestKey = null;
  }, /does not map to any Phase 0 route manifest entry/);
});

test('NEGATIVE CONTROL: a send endpoint classified read is rejected', () => {
  const index = committed.requests.findIndex((e) => /\/send-campaign$/.test(e.requestPath));
  assert.ok(index >= 0, 'fixture must contain a send-campaign request to mutate');
  rejects((m) => {
    m.requests[index].classification = 'read';
    m.requests[index].runtimeAction = null;
    m.totals.read += 1;
    m.totals.externalAction -= 1;
  }, /must be external_action|looks like an external action/);
});

test('NEGATIVE CONTROL: omitting OutreachView is rejected', () => {
  rejects((m) => {
    m.consumerFiles = m.consumerFiles.filter(
      (f) => f !== 'apps/web/src/pages/engagement/OutreachView.tsx',
    );
  }, /OutreachView\.tsx is missing/);
});

test('NEGATIVE CONTROL: a request with no surface is rejected', () => {
  rejects((m) => {
    m.requests[0].surface = null;
  }, /has no surface/);
});

test('NEGATIVE CONTROL: an undecorated external route is rejected', () => {
  const index = committed.requests.findIndex((e) => /\/generate-batch$/.test(e.requestPath));
  assert.ok(index >= 0, 'fixture must contain a generate-batch request to mutate');
  rejects((m) => {
    m.requests[index].runtimeAction = null;
    m.requests[index].classification = 'safe_local_write';
    m.totals.externalAction -= 1;
    m.totals.safeLocalWrite += 1;
  }, /carries no @EngagementRuntimeAction/);
});

test('NEGATIVE CONTROL: a V3 consumer is rejected', () => {
  rejects((m) => {
    m.requests.push({
      ...m.requests[0],
      consumerFile: 'apps/web/src/pages/engagement/outreach/v3/V3Wizard.tsx',
    });
    m.totals.requests += 1;
    m.totals[
      m.requests[0].classification === 'read'
        ? 'read'
        : m.requests[0].classification === 'safe_local_write'
          ? 'safeLocalWrite'
          : 'externalAction'
    ] += 1;
  }, /Outreach V3 consumer found/);
});

test('NEGATIVE CONTROL: a missing route-coverage entry is rejected', () => {
  rejects((m) => {
    m.routeCoverage = m.routeCoverage.slice(1);
  }, /has no coverage entry/);
});

test('NEGATIVE CONTROL: a surface missing a required state is rejected', () => {
  rejects((m) => {
    m.surfaces[0].requiredStates = m.surfaces[0].requiredStates.filter((s) => s !== 'error');
  }, /missing required state "error"/);
});

test('NEGATIVE CONTROL: tampered totals are rejected', () => {
  rejects((m) => {
    m.totals.requests = m.totals.requests + 7;
  }, /totals\.requests says/);
});

test('NEGATIVE CONTROL: an unresolved scanner finding is rejected', () => {
  rejects((m) => {
    m.findings.push({
      kind: 'unresolvable_request_url',
      consumerFile: 'apps/web/src/pages/engagement/Fake.tsx',
      line: 1,
      detail: 'could not resolve',
    });
  }, /unresolvable_request_url/);
});

test('NEGATIVE CONTROL: a consumed route with no consumers is rejected', () => {
  rejects((m) => {
    const consumed = m.routeCoverage.find((r) => r.status === 'consumed');
    consumed.consumers = [];
  }, /marked consumed with no consumers/);
});

// ──────────────────────────────────────────────────────────────── unit helpers

test('normalizePath collapses dynamic segments and drops query strings', () => {
  assert.equal(normalizePath('/api/engagement/meetings/:param/notes'), '/api/engagement/meetings/:param/notes');
  assert.equal(normalizePath('/api/engagement/outreach?limit=25'), '/api/engagement/outreach');
});

test('template literals resolve through module constants', () => {
  const constants = collectStringConstants("const BASE = '/api/engagement';");
  const resolved = resolveFirstArgPath('`${BASE}/meetings/${id}`', constants);
  assert.equal(resolved.path, '/api/engagement/meetings/:param');
});

test('matchRoute prefers a literal segment over a parameter segment', () => {
  const routes = [
    { method: 'GET', path: '/api/engagement/meetings/:meetingId' },
    { method: 'GET', path: '/api/engagement/meetings/library' },
  ];
  assert.equal(
    matchRoute(routes, 'GET', '/api/engagement/meetings/library').path,
    '/api/engagement/meetings/library',
  );
  assert.equal(
    matchRoute(routes, 'GET', '/api/engagement/meetings/:param').path,
    '/api/engagement/meetings/:meetingId',
  );
});

test('classifyRequest defers to the decorator over the method', () => {
  assert.equal(classifyRequest('POST', '/api/engagement/outreach', null).classification, 'safe_local_write');
  assert.equal(classifyRequest('GET', '/api/engagement/outreach', null).classification, 'read');
  assert.equal(
    classifyRequest('POST', '/api/engagement/outreach', 'outreach_send').classification,
    'external_action',
  );
});

test('the heuristic still recognises send-batch, which an anchored /send$/ would miss', () => {
  assert.equal(
    heuristicClassify('POST', '/api/engagement/outreach/send-batch').classification,
    'external_action',
  );
});
