#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeIssues } from './verify-engagement-phase3-scope.mjs';

const greenCounts = { openP0: 0, openP1: 0, blockingP2: 0 };

test('accepts additive Phase 3 web/test/docs work with shadow runtime unchanged', () => {
  assert.deepEqual(
    scopeIssues({
      changed: ['apps/web/src/lib/engagement-preview-cache.ts', 'scripts/run-engagement-phase3-local.mjs'],
      addedSource: "ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled'",
      counts: greenCounts,
    }),
    [],
  );
});

test('negative control: migration fails', () => {
  assert.match(
    scopeIssues({ changed: ['apps/api/prisma/migrations/20990101000000_bad/migration.sql'], addedSource: '', counts: greenCounts }).join('\n'),
    /migration/,
  );
});

test('negative control: infrastructure mutation fails', () => {
  assert.match(
    scopeIssues({ changed: ['infra/cdk/lib/compute-stack.ts'], addedSource: '', counts: greenCounts }).join('\n'),
    /infrastructure|Compute/,
  );
});

test.each([
  "ENGAGEMENT_EXTERNAL_ACTIONS='enabled'",
  "ENGAGEMENT_CALLBACKS_ENABLED=true",
  "ENGAGEMENT_RECALL_WEBHOOK_ENABLED='true'",
  "ENGAGEMENT_BACKGROUND_OWNER='engagement-api'",
])('negative control: runtime enablement %s fails', (addedSource) => {
  assert.equal(scopeIssues({ changed: [], addedSource, counts: greenCounts }).length > 0, true);
});

test('negative control: open P1 finding fails closeout', () => {
  assert.match(
    scopeIssues({ changed: [], addedSource: '', counts: { openP0: 0, openP1: 1, blockingP2: 0 } }).join('\n'),
    /open P1/,
  );
});

test('negative control: blocking P2 finding fails closeout', () => {
  assert.match(
    scopeIssues({ changed: [], addedSource: '', counts: { openP0: 0, openP1: 0, blockingP2: 1 } }).join('\n'),
    /blocking P2/,
  );
});
