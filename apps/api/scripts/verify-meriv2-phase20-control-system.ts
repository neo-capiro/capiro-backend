#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MERIV2_CONTROL_METRIC_NAMES,
  buildMeriV2ControlMetricEnvelope,
} from '@capiro/meriv2-core';

const ROOT = path.resolve(import.meta.dirname, '../../..');

async function text(relative: string): Promise<string> {
  return readFile(path.join(ROOT, relative), 'utf8');
}

async function main(): Promise<void> {
  const [stack, control, entrypoint, rollout, rollback, backfill, policy, mapping] =
    await Promise.all([
      text('infra/cdk/lib/meriv2-control-stack.ts'),
      text('packages/meriv2-core/src/assurance/control-metrics.ts'),
      text('apps/api/scripts/entrypoint.sh'),
      text('docs/runbooks/meriv2-memory-context-assurance-rollout.md'),
      text('docs/runbooks/meriv2-memory-context-assurance-rollback.md'),
      text('docs/runbooks/meriv2-memory-backfill.md'),
      text('docs/runbooks/meriv2-policy-pack-operations.md'),
      text('docs/security/meriv2-memory-assurance-control-mapping.md'),
    ]);

  for (const name of MERIV2_CONTROL_METRIC_NAMES) {
    assert.match(stack, new RegExp(`metricName:\\s*['\"]${name}['\"]`), `${name} alarm missing`);
    assert.match(control, new RegExp(`['\"]${name}['\"]`), `${name} contract missing`);
  }

  assert.match(stack, /enabled:\s*props\.monitorEnabled/);
  assert.match(stack, /retention:\s*logs\.RetentionDays\.ONE_YEAR/);
  assert.match(stack, /alarm\.addAlarmAction\(action\)/);
  assert.match(stack, /alarm\.addOkAction\(action\)/);
  assert.match(stack, /dashboardName:/);
  assert.match(control, /Dimensions:\s*\[\['Environment'\]\]/);

  const forbiddenDimensions = [
    'TenantId',
    'UserId',
    'ClientId',
    'MemoryItemId',
    'PolicyPackId',
    'PromptVersion',
    'Model',
    'Tool',
  ];
  const sample = buildMeriV2ControlMetricEnvelope(
    { SelfReviewDenials: 1, UnsupportedHighRiskClaimRate: 25 },
    { environment: 'development', timestamp: 0 },
  );
  const serialized = JSON.stringify(sample);
  for (const value of forbiddenDimensions) assert.ok(!serialized.includes(value));
  assert.deepEqual(sample._aws.CloudWatchMetrics[0]?.Dimensions, [['Environment']]);

  assert.match(entrypoint, /emit-meriv2-control-metrics\)/);
  assert.match(entrypoint, /demo-meriv2-control-alarms\)/);

  for (const [name, document] of [
    ['rollout', rollout],
    ['rollback', rollback],
    ['backfill', backfill],
    ['policy', policy],
    ['mapping', mapping],
  ] as const) {
    assert.ok(document.length > 2_000, `${name} runbook/mapping is unexpectedly incomplete`);
  }

  assert.match(rollout, /MEMORY_GOVERNANCE_LIFECYCLE=enforce/);
  assert.match(rollout, /MERIV2_CONTEXT_PACKET_V2=shadow/);
  assert.match(rollback, /--rollback/);
  assert.match(backfill, /--confirm-tenant/);
  assert.match(backfill, /--confirm-job/);
  assert.match(policy, /MERI_POLICY_PACK_SOURCE=shadow/);
  assert.match(policy, /rollback\/<target-pack-row-id>/);
  assert.match(mapping, /Audit confidentiality/);
  assert.doesNotMatch(rollback, /`CONTEXT_PACKET_V2`/);
  assert.doesNotMatch(rollback, /Not yet implementable/);

  console.log(
    JSON.stringify({
      marker: 'MERIV2_PHASE20_CONTROL_SYSTEM_CONTRACT_OK',
      metricCount: MERIV2_CONTROL_METRIC_NAMES.length,
      boundedDimensions: ['Environment'],
      requiredDocuments: 5,
      productionAction: false,
    }),
  );
}

void main();
