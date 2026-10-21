import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readCurrentBackendInputs, buildBackendRouteCatalog, verifyBackendPreviewBoundary,
  verifyOwnedHistoricalInputs, ROUTE_INPUTS,
} from './engagement-phase3-backend-contract.mjs';
import { buildPatterns, EXCLUSIONS } from './engagement-phase3-preview-route-patterns.mjs';
import { classifyRequest, heuristicClassify, HEURISTIC_EXEMPTIONS } from './engagement-phase3-ui-inventory.mjs';

const input = readCurrentBackendInputs();
const current = buildBackendRouteCatalog(input);
const clone = () => ({ manifests: JSON.parse(JSON.stringify(input.manifests)),
  sourceEvidence: new Map(input.sourceEvidence), runtimeActions: new Map(input.runtimeActions) });
const reject = (mutate, matcher) => {
  const copy = clone(); mutate(copy);
  const baseline = new Map();
  for (const issue of current.issues) baseline.set(issue, (baseline.get(issue) ?? 0) + 1);
  const introduced = buildBackendRouteCatalog(copy).issues.filter(issue => {
    const count = baseline.get(issue) ?? 0;
    if (!count) return true;
    baseline.set(issue, count - 1); return false;
  });
  assert(introduced.some(issue => matcher.test(issue)), `missing new ${matcher}: ${introduced.join('\n')}`);
};
const built = () => buildPatterns({ routes: current.routes });
const rejectBoundary = (mutate, matcher) => {
  const candidate = built(); mutate(candidate);
  assert(verifyBackendPreviewBoundary(current, candidate).issues.some(issue => matcher.test(issue)));
};

test('current backend manifests and controller declarations validate without UI coverage assumptions', () => {
  assert.deepEqual(current.issues, []);
  assert.equal(current.summary.manifests, ROUTE_INPUTS.length);
  assert.equal(new Set(current.routes.map(row => row.key)).size, current.routes.length);
  assert(current.routes.every(row => row.kind !== 'primary' || input.sourceEvidence.has(row.sourceFile)));
});
test('current backend external and read classifications come from retained controller metadata', () => {
  assert(current.routes.some(row => row.runtimeAction === 'outreach_send' && row.classification === 'external_action'));
  assert(current.routes.some(row => row.kind === 'primary' && row.method === 'GET' && !row.runtimeAction && row.classification === 'read'));
  assert(current.routes.filter(row => row.kind === 'additive').every(row => row.classification === null));
});
test('current route catalog is deterministic and does not mutate source declarations', () => {
  const before = JSON.stringify(input.manifests);
  assert.deepEqual(buildBackendRouteCatalog(input), buildBackendRouteCatalog(input));
  assert.equal(JSON.stringify(input.manifests), before);
});
test('historical byte inputs are preserved only as qualification data identities', () => {
  const identity = verifyOwnedHistoricalInputs();
  assert.equal(identity.purpose, 'immutable-qualification-data-identity-only');
  assert(identity.inventoryRequests > 0 && identity.generatedBytes > 0 && identity.historicalPackageBytes > 0);
  assert.equal(Object.hasOwn(identity, 'frontendParityAccepted'), false);
});
test('a duplicate current backend method and path is rejected', () => reject(copy => {
  copy.manifests[0].manifest.routes.push({ ...copy.manifests[0].manifest.routes[0] });
}, /duplicate backend route key/));
test('a missing admitted route manifest is rejected', () => reject(copy => { copy.manifests.pop(); }, /ownership list/));
test('an unavailable owned controller source is rejected', () => reject(copy => {
  copy.sourceEvidence.delete(copy.manifests[0].manifest.routes[0].sourceFile);
}, /missing owned controller source/));
test('a controller metadata name absent from its source is rejected', () => reject(copy => {
  copy.manifests[0].manifest.routes[0].controller = 'AbsentControllerBoundaryProbe';
}, /declared controller is absent/));
test('a handler metadata name absent from its source is rejected', () => reject(copy => {
  copy.manifests[0].manifest.routes[0].handler = 'absentBoundaryProbe';
}, /declared handler is absent/));
test('an unsupported route method is rejected', () => reject(copy => {
  copy.manifests[0].manifest.routes[0].method = 'EXECUTE';
}, /unsupported route method/));
test('a route path carrying a query or traversal is rejected', () => reject(copy => {
  copy.manifests[0].manifest.routes[0].path = '/api/../engagement?probe=yes';
}, /invalid absolute route path/));
test('an additive manifest with a different runtime declaration is rejected', () => reject(copy => {
  copy.manifests[1].manifest.runtime = 'unowned-probe';
}, /additive runtime declaration/));
test('an additive route cannot escape the existing Engagement prefix', () => reject(copy => {
  copy.manifests[1].manifest.routes[0].path = '/api/another-domain/probe';
}, /additive route escapes/));
test('removing the current send action metadata introduces its own backend diagnostic', () => reject(copy => {
  const send = current.routes.find(row => row.kind === 'primary' && row.method === 'POST' &&
    /\/send-campaign$/.test(row.path) && row.runtimeAction);
  assert(send, 'retained current send contract required for this mutation');
  copy.runtimeActions.delete(`${send.sourceFile}#${send.handler}`);
}, /external-looking handler|send handler must declare/));
test('send-intent status reads remain reads while mutation heuristics remain external', () => {
  const routePath = '/api/engagement/outreach/send-intents/:id';
  assert.equal(classifyRequest('GET', routePath, null).classification, 'read');
  assert.equal(heuristicClassify('GET', routePath).classification, 'read');
  assert.equal(heuristicClassify('POST', '/api/engagement/outreach/send-batch').classification, 'external_action');
});
test('the two documented local exemptions cannot absorb a genuine current send', () => {
  const exempt = new Set(HEURISTIC_EXEMPTIONS.map(row => row.route));
  const sends = current.routes.filter(row => row.kind === 'primary' && row.method !== 'GET' &&
    /\/send(-|$)/.test(row.path) && !exempt.has(row.key));
  assert(sends.length > 0);
  assert(sends.every(row => row.runtimeAction && row.classification === 'external_action'));
});
test('invalid handler identifiers are rejected before source matching', () => reject(copy => {
  copy.manifests[0].manifest.routes[0].handler = 'not.a.handler';
}, /invalid handler declaration/));
test('a stale heuristic exemption is rejected against current backend declarations', () => reject(copy => {
  const route = HEURISTIC_EXEMPTIONS[0].route;
  copy.manifests[0].manifest.routes = copy.manifests[0].manifest.routes.filter(row => `${row.method} ${row.path}` !== route);
}, /stale or undocumented heuristic exemption/));
test('current preview patterns exclude every non-preview backend catalog path', () => {
  const boundary = verifyBackendPreviewBoundary(current);
  assert.deepEqual(boundary.issues, []);
  const outside = [...new Set(current.routes.map(row => row.path))].filter(value => !value.startsWith('/api/engagement/')).sort();
  assert.deepEqual(boundary.nonPreviewPaths, outside);
  assert(outside.some(value => value.startsWith('/api/clio/krisp-notetaker')));
  assert(outside.includes('/webhooks/recall'));
  assert(outside.includes('/api/internal/ai-credentials/resolve'));
});
test('a broad prefix pattern is rejected even if route coverage is unchanged', () => rejectBoundary(candidate => {
  candidate.patterns[0] = '^/api/.*$';
}, /differ from exact|includes non-preview/));
test('an unanchored pattern is rejected', () => rejectBoundary(candidate => {
  candidate.patterns[0] = candidate.patterns[0].slice(1, -1);
}, /Unanchored preview pattern/));
test('dropping an in-prefix route cannot shrink the checked preview boundary', () => rejectBoundary(candidate => {
  candidate.coveredPaths.pop(); candidate.patterns.pop();
}, /differ from exact/));
test('the current backend check cannot broaden the reviewed preview prefix', () => {
  assert(verifyBackendPreviewBoundary(current, built(), { prefix: '/api', exclusions: EXCLUSIONS }).issues
    .includes('Reviewed preview prefix/exclusion policy changed'));
});
test('the current backend check cannot add a Krisp exclusion to the historical policy', () => {
  assert(verifyBackendPreviewBoundary(current, built(), { prefix: '/api/engagement',
    exclusions: [...EXCLUSIONS, { path: '/api/clio/krisp-notetaker' }] }).issues
    .includes('Reviewed preview prefix/exclusion policy changed'));
});
test('additive global and controller prefix metadata mutations introduce their own diagnostics', () => {
  for (const change of [
    manifest => { manifest.globalPrefix = '/unowned'; },
    manifest => { manifest.controllerPrefix = '/unowned'; },
    manifest => { delete manifest.globalPrefix; },
    manifest => { manifest.controllerPrefix += '/'; },
  ]) reject(copy => change(copy.manifests[1].manifest), /global\/controller prefix metadata/);
  reject(copy => {
    delete copy.manifests[3].manifest.schemaVersion;
    copy.manifests[3].manifest.version = 1;
  }, /expected schemaVersion schema metadata/);
});
test('an additive route cannot move into a sibling Engagement or V3 family owner', () => {
  reject(copy => { copy.manifests[1].manifest.routes[0].path = '/api/engagement/other-owner/probe'; },
    /outside its composed declared owner prefix/);
  reject(copy => { copy.manifests[3].manifest.routes[0].path = '/api/engagement/outreach-v3/sessions/:sessionId/send/probe'; },
    /outside its composed declared owner prefix/);
});
test('legitimate future routes under each admitted additive owner need no historical UI update', () => {
  const copy = clone();
  for (const [index, row] of copy.manifests.slice(1).entries()) {
    const owned = current.routes.find(route => route.input === row.input);
    row.manifest.routes.push({ method: 'GET', path: `${owned.ownerPath}/future-boundary-probe-${index}`, handler: 'futureBoundaryProbe' });
  }
  assert.deepEqual(buildBackendRouteCatalog(copy).issues, current.issues);
});
