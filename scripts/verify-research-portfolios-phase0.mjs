#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

console.error('Usage: node scripts/verify-research-portfolios-phase0.mjs (no arguments runs the existing verifier)');
const root = process.cwd();
const artifactRoot = join(root, 'docs/defense-budget/research-portfolios/phase-0');

async function readJson(name) {
  return JSON.parse(await readFile(join(artifactRoot, name), 'utf8'));
}

const [baseline, requirements, actions, liveInventory] = await Promise.all([
  readJson('baseline-ledger.json'),
  readJson('requirement-registry.json'),
  readJson('route-action-registry.json'),
  readJson('live-release-inventory.json'),
]);

const expectedRequirementIds = [
  ...Array.from({ length: 10 }, (_, index) => `RP-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 11 }, (_, index) => `DI-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 3 }, (_, index) => `MX-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `OP-${String(index + 1).padStart(2, '0')}`),
];
const requirementIds = requirements.requirements.map(({ id }) => id);
assert.equal(requirements.schemaVersion, 1);
assert.equal(requirements.status, 'registered');
assert.equal(new Set(requirementIds).size, requirementIds.length, 'requirement IDs must be unique');
assert.deepEqual([...requirementIds].sort(), [...expectedRequirementIds].sort());
assert.equal(requirementIds.includes('OP-5'), false);
assert.ok(requirements.requirements.every(({ targetPhases }) => Array.isArray(targetPhases) && targetPhases.length));

const importActions = ['preview', 'apply', 'pause', 'resume', 'cancel', 'retry', 'reconcile', 'compensate'];
const expectedRouteKeys = [
  'GET /', 'POST /', 'GET /{id}', 'PATCH /{id}',
  'POST /{id}/archive', 'POST /{id}/restore',
  'GET /{id}/grants', 'PUT /{id}/grants/{principalId}', 'DELETE /{id}/grants/{principalId}',
  'GET /{id}/client-links', 'POST /{id}/client-links', 'DELETE /{id}/client-links/{clientId}',
  'GET /{id}/members', 'POST /{id}/members', 'POST /{id}/members/decisions',
  'POST /{id}/members/{memberId}/resolve',
  'GET /{id}/bookmarks', 'POST /{id}/bookmarks', 'PATCH /{id}/bookmarks/{bookmarkId}',
  'DELETE /{id}/bookmarks/{bookmarkId}',
  'GET /{id}/rules', 'POST /{id}/rules/preview', 'POST /{id}/rules',
  'GET /templates', 'POST /templates', 'GET /templates/{templateId}/versions/{versionId}', 'GET /taxonomy',
  'GET /{id}/fit', 'POST /{id}/fit/refresh',
  'GET /{id}/reviews', 'POST /{id}/reviews/{reviewId}/assign',
  'POST /{id}/reviews/{reviewId}/decision', 'POST /{id}/reviews/{reviewId}/notes',
  'POST /{id}/reviews/bulk',
  'GET /{id}/annual-review', 'POST /{id}/annual-review/reopen',
  'POST /{id}/imports', 'GET /{id}/imports/{jobId}',
  ...importActions.map((action) => `POST /{id}/imports/{jobId}/${action}`),
  'GET /{id}/changes', 'PATCH /{id}/changes/{eventId}/state',
  'GET /{id}/subscriptions', 'POST /{id}/subscriptions',
  'PATCH /{id}/subscriptions/{subscriptionId}',
  'POST /{id}/watch-conversion/preview', 'POST /{id}/watch-conversion/apply',
  'GET /{id}/analytics', 'GET /{id}/snapshots', 'POST /{id}/snapshots',
  'GET /{id}/snapshots/{snapshotId}',
  'GET /{id}/operations/{operationId}', 'POST /{id}/operations/{operationId}/reconcile',
];
const routeKeys = actions.routes.map(({ method, relativePath }) => `${method} ${relativePath}`);
const actionIds = actions.routes.map(({ actionId }) => actionId);
assert.equal(actions.schemaVersion, 1);
assert.equal(actions.apiBase, '/api/research-portfolios');
assert.equal(actions.status, 'proposed_not_activated');
assert.deepEqual(actions.staticRoutePrecedence, ['/templates', '/taxonomy', '/:id']);
assert.equal(new Set(actionIds).size, actionIds.length, 'action IDs must be unique');
assert.equal(new Set(routeKeys).size, routeKeys.length, 'method/path keys must be unique');
assert.deepEqual([...routeKeys].sort(), [...expectedRouteKeys].sort());
assert.ok(actions.routes.every(({ status }) => status === 'proposed_not_activated'));
assert.ok(actions.routes.filter(({ mutation }) => mutation).every(({ idempotencyRequired }) => idempotencyRequired));
const firstDynamic = actions.routes.findIndex(({ relativePath }) => relativePath.startsWith('/{id}'));
for (const staticPath of ['/templates', '/taxonomy']) {
  assert.ok(actions.routes.findIndex(({ relativePath }) => relativePath === staticPath) < firstDynamic);
}

assert.equal(baseline.schemaVersion, 1);
assert.equal(baseline.auditedSha, '6be92e45693de9d18b02559e174eace76d396f1c');
assert.equal(baseline.baseHeadSha, '114b96b8ad6ae701d3cc5c6a40d062408223ee28');
assert.equal(baseline.apiBase, '/api/research-portfolios');
assert.equal(baseline.owner, 'apps/api main Nest API');
assert.equal(baseline.status, 'proposed_not_activated');
assert.equal(baseline.expectedMirrorCount, 721);
assert.equal(baseline.verifiedMirrorCount, 721);
assert.equal(baseline.sourceActivationAllowed, false);
assert.equal(baseline.arbitraryReplayAllowed, false);
assert.equal(baseline.currentDeployment.verificationStatus, 'captured_read_only');
assert.equal(
  baseline.currentDeployment.evidenceFile,
  'docs/defense-budget/research-portfolios/phase-0/live-release-inventory.json',
);
const unknownDeploymentFields = [
  'buildId', 'flags', 'migrations', 'databaseLogin', 'snapshotManifest', 'queueSchedule',
];
assert.ok(unknownDeploymentFields.every((field) => baseline.currentDeployment[field] === null));
assert.ok(baseline.historicalCheckpoints.every(({ note }) => note === 'historical/not current live inventory'));
assert.deepEqual(baseline.boundedBacklogPhases.map(({ phase }) => phase), [1, 2, 3, 4]);
assert.ok(baseline.boundedBacklogPhases.every(({ rollbackBoundary }) => rollbackBoundary));

assert.equal(liveInventory.schemaVersion, 1);
assert.equal(liveInventory.verificationStatus, 'captured_read_only');
assert.equal(liveInventory.aws.account, '967807252336');
assert.equal(liveInventory.aws.region, 'us-east-1');
assert.equal(liveInventory.localBaseline.headSha, baseline.baseHeadSha);
assert.deepEqual(liveInventory.clusters.map(({ name }) => name).sort(), [
  'capiro-dev',
  'capiro-prod-os-capiro',
  'capiro-staging',
]);
const liveServices = liveInventory.clusters.flatMap(({ services }) => services);
assert.ok(liveServices.length >= 13);
assert.ok(
  liveServices.every(
    ({ desired, running, pending, rolloutState }) =>
      running === desired && pending === 0 && rolloutState === 'COMPLETED',
  ),
);
assert.ok(Object.values(liveInventory.explicitUnknowns).every((value) => value === 'unknown_not_queried'));

console.log(
  `PASS research-portfolios Phase 0 contracts: ${requirementIds.length} requirements, ` +
    `${routeKeys.length} method/path actions, phases 1-4 ledgered, ${liveServices.length} live services inventoried.`,
);
