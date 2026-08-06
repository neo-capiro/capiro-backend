/**
 * engagement-api observability — alarms, events, dashboard, and the guarantee
 * that none of them can carry campaign content.
 *
 * Run: pnpm --dir infra/cdk exec ts-node --prefer-ts-exts test/engagement-api-observability.spec.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import {
  ENGAGEMENT_API_FORBIDDEN_LOG_FIELDS,
  ENGAGEMENT_API_LOG_FIELDS,
  ENGAGEMENT_API_ROUTE_FAMILIES,
  loadBalancerFullNameFromListenerArn,
  targetGroupFullNameFromArn,
} from '../lib/engagement-api/engagement-api-alarms';
import { type EngagementApiInfraConfig } from '../lib/engagement-api/engagement-api-config';
import { EngagementApiServiceStack } from '../lib/engagement-api/engagement-api-service-stack';

const CDK_ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(CDK_ROOT, 'fixtures/engagement-api.test.json');
const TARGET_GROUP_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/capiro-dev-engagement-api/4444';

const base = (): EngagementApiInfraConfig => {
  const cfg = JSON.parse(readFileSync(FIXTURE, 'utf8')) as EngagementApiInfraConfig;
  cfg.imageDigest = `sha256:${'ab'.repeat(32)}`;
  cfg.releaseSha = 'c'.repeat(40);
  return cfg;
};

function synth(cfg: EngagementApiInfraConfig = base()): Template {
  const app = new cdk.App();
  return Template.fromStack(
    new EngagementApiServiceStack(app, 'Capiro-dev-EngagementApiService', {
      cfg,
      env: { account: cfg.accountId, region: cfg.region },
      targetGroupArn: TARGET_GROUP_ARN,
    }),
  );
}

const alarmNames = (template: Template): string[] =>
  Object.values(template.findResources('AWS::CloudWatch::Alarm'))
    .map((r) => (r as { Properties: Record<string, any> }).Properties.AlarmName as string)
    .sort();

// ──────────────────────────────────────────────────────── derivation helpers

test('ALB and target group full names are derived from ARNs', () => {
  assert.equal(
    loadBalancerFullNameFromListenerArn(base().httpsListenerArn),
    'app/capiro-test-alb/0000000000000000',
  );
  assert.equal(
    targetGroupFullNameFromArn(TARGET_GROUP_ARN),
    'targetgroup/capiro-dev-engagement-api/4444',
  );
  assert.throws(() => loadBalancerFullNameFromListenerArn('nonsense'), /cannot derive/);
  assert.throws(() => targetGroupFullNameFromArn('nonsense'), /cannot derive/);
});

// ─────────────────────────────────────────────────────────────────── alarms

test('every required alarm exists', () => {
  const names = alarmNames(synth());
  for (const suffix of [
    'HealthyHosts',
    'Target5xx',
    'LatencyP95',
    'Cpu',
    'Memory',
    'FatalBootstrap',
    'InvalidShadowPosture',
    'DatabaseConnections',
  ]) {
    assert.ok(
      names.includes(`capiro-dev-engagement-api-${suffix}`),
      `missing alarm ${suffix}; have ${names.join(', ')}`,
    );
  }
  assert.equal(names.length, 8);
});

test('NC-2.8-C removing the RDS connection alarm would be detectable', () => {
  const template = synth();
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    Namespace: 'AWS/RDS',
    MetricName: 'DatabaseConnections',
    Dimensions: [{ Name: 'DBClusterIdentifier', Value: base().auroraClusterIdentifier }],
    Threshold: base().dbConnectionBudget.alarmThreshold,
  });
  assert.ok(alarmNames(template).includes('capiro-dev-engagement-api-DatabaseConnections'));
});

test('the healthy-host alarm breaches below one host over three periods', () => {
  synth().hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'capiro-dev-engagement-api-HealthyHosts',
    ComparisonOperator: 'LessThanThreshold',
    Threshold: 1,
    EvaluationPeriods: 3,
    DatapointsToAlarm: 3,
    TreatMissingData: 'notBreaching',
  });
});

test('the 5xx and latency alarms treat missing data as not breaching', () => {
  const template = synth();
  for (const name of ['Target5xx', 'LatencyP95']) {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: `capiro-dev-engagement-api-${name}`,
      TreatMissingData: 'notBreaching',
    });
  }
});

test('alarm dimensions are exact and reference the derived ALB names', () => {
  synth().hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'capiro-dev-engagement-api-Target5xx',
    Namespace: 'AWS/ApplicationELB',
    MetricName: 'HTTPCode_Target_5XX_Count',
    Dimensions: Match.arrayWith([
      { Name: 'LoadBalancer', Value: 'app/capiro-test-alb/0000000000000000' },
      { Name: 'TargetGroup', Value: 'targetgroup/capiro-dev-engagement-api/4444' },
    ]),
  });
});

test('posture alarms fire on a single event', () => {
  const template = synth();
  for (const name of ['FatalBootstrap', 'InvalidShadowPosture']) {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: `capiro-dev-engagement-api-${name}`,
      Threshold: 0,
      EvaluationPeriods: 1,
    });
  }
});

test('every alarm notifies the configured topic', () => {
  const alarms = Object.values(synth().findResources('AWS::CloudWatch::Alarm'));
  for (const resource of alarms) {
    const properties = (resource as { Properties: Record<string, any> }).Properties;
    assert.deepEqual(properties.AlarmActions, [base().alarmTopicArn]);
  }
});

// ──────────────────────────────────────────────────────── metric filters

test('log metric filters exist for fatal boot and armed posture', () => {
  const template = synth();
  template.resourceCountIs('AWS::Logs::MetricFilter', 2);
  template.hasResourceProperties('AWS::Logs::MetricFilter', {
    FilterPattern: '"Fatal engagement-api bootstrap error"',
  });
  template.hasResourceProperties('AWS::Logs::MetricFilter', {
    FilterPattern: '"engagement runtime policy rejected"',
  });
});

// ───────────────────────────────────────────────────────────────── events

test('deployment failure and unexpected task stop are routed', () => {
  const template = synth();
  template.resourceCountIs('AWS::Events::Rule', 2);
  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: Match.objectLike({
      source: ['aws.ecs'],
      'detail-type': ['ECS Deployment State Change'],
    }),
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: Match.objectLike({
      'detail-type': ['ECS Task State Change'],
    }),
  });
});

test('a planned scaling drain does not page', () => {
  const rules = Object.values(synth().findResources('AWS::Events::Rule'));
  const stopped = rules.find((r) =>
    JSON.stringify((r as { Properties: Record<string, any> }).Properties).includes(
      'ECS Task State Change',
    ),
  );
  assert.ok(stopped);
  const rendered = JSON.stringify((stopped as { Properties: Record<string, any> }).Properties);
  assert.match(rendered, /anything-but/);
  assert.match(rendered, /Scaling activity initiated by/);
});

// ────────────────────────────────────────────────────────────── dashboard

test('a compact dashboard exists', () => {
  synth().hasResourceProperties('AWS::CloudWatch::Dashboard', {
    DashboardName: 'capiro-dev-engagement-api',
  });
});

// ────────────────────────────────────────── the content-safety guarantee

test('NC-2.8-A no alarm, filter or dashboard references a forbidden field', () => {
  const rendered = JSON.stringify(synth().toJSON()).toLowerCase();
  for (const field of ENGAGEMENT_API_FORBIDDEN_LOG_FIELDS) {
    assert.ok(
      !rendered.includes(field.toLowerCase()),
      `observability references the forbidden field ${field}`,
    );
  }
});

test('NC-2.8-B no dimension carries a recipient, target or client value', () => {
  const template = synth();
  for (const resource of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
    const dimensions = ((resource as { Properties: Record<string, any> }).Properties.Dimensions ??
      []) as Array<{ Name: string; Value: unknown }>;
    for (const dimension of dimensions) {
      assert.ok(
        /^(LoadBalancer|TargetGroup|ClusterName|ServiceName|DBClusterIdentifier)$/.test(
          dimension.Name,
        ),
        `unexpected metric dimension ${dimension.Name}`,
      );
    }
  }
  const rendered = JSON.stringify(template.toJSON());
  assert.doesNotMatch(rendered, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
});

test('the log field contract carries only route family and status class', () => {
  // TypeScript already proves these two literal unions are disjoint — this
  // comparison needs a widening cast to compile at all. Kept as a runtime
  // check so the guarantee survives a future change to `string[]`.
  const forbidden = ENGAGEMENT_API_FORBIDDEN_LOG_FIELDS as readonly string[];
  for (const field of ENGAGEMENT_API_LOG_FIELDS as readonly string[]) {
    assert.ok(!forbidden.includes(field), `${field} is both allowed and forbidden`);
  }
  assert.deepEqual([...ENGAGEMENT_API_LOG_FIELDS], [
    'service',
    'release_sha',
    'route_family',
    'http_method',
    'status_class',
    'latency_bucket',
    'shadow_denial_action',
    'ui_contract_sha',
  ]);
  assert.equal(ENGAGEMENT_API_ROUTE_FAMILIES.length, 11);
});

test('every capability-manifest observability family is a known route family', () => {
  const manifest = JSON.parse(
    readFileSync(
      path.resolve(
        CDK_ROOT,
        '../../apps/api/src/engagement/__fixtures__/outreach-v3-ui-api-capability-manifest.v1.json',
      ),
      'utf8',
    ),
  ) as { entries: Array<{ observabilityFamily: string }> };

  const known = new Set<string>(ENGAGEMENT_API_ROUTE_FAMILIES);
  const used = new Set(manifest.entries.map((entry) => entry.observabilityFamily));
  for (const family of used) {
    assert.ok(known.has(family), `capability manifest uses unknown route family ${family}`);
  }
});

test('the ui contract hash appears only as nonsecret task metadata', () => {
  const rendered = JSON.stringify(synth().toJSON());
  // Present as an environment value and a tag, never as an alarm dimension.
  assert.match(rendered, /OUTREACH_V3_UI_CONTRACT_SHA256/);
  for (const resource of Object.values(synth().findResources('AWS::CloudWatch::Alarm'))) {
    const dimensions = JSON.stringify(
      (resource as { Properties: Record<string, any> }).Properties.Dimensions ?? [],
    );
    assert.doesNotMatch(dimensions, /ui.contract/i);
  }
});
