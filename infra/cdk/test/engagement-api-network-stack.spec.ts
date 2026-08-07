/**
 * engagement-api network stack — imported bindings and the empty target group.
 *
 * Run: pnpm --dir infra/cdk exec ts-node --prefer-ts-exts test/engagement-api-network-stack.spec.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Template } from 'aws-cdk-lib/assertions';

import { type EngagementApiInfraConfig } from '../lib/engagement-api/engagement-api-config';
import { EngagementApiNetworkStack } from '../lib/engagement-api/engagement-api-network-stack';

const CDK_ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(CDK_ROOT, 'fixtures/engagement-api.test.json');

const base = (): EngagementApiInfraConfig =>
  JSON.parse(readFileSync(FIXTURE, 'utf8')) as EngagementApiInfraConfig;

/**
 * Construct the stack WITHOUT synthesizing. CDK refuses to synthesize twice
 * when the tree changed in between, so the negative controls must mutate a
 * fresh, unsynthesized stack and render it exactly once.
 */
function buildRaw(cfg: EngagementApiInfraConfig = base()) {
  const app = new cdk.App();
  return new EngagementApiNetworkStack(app, 'Capiro-dev-EngagementApiNetwork', {
    cfg,
    env: { account: cfg.accountId, region: cfg.region },
  });
}

function build(cfg: EngagementApiInfraConfig = base()) {
  const stack = buildRaw(cfg);
  return { stack, template: Template.fromStack(stack) };
}

const synth = (cfg?: EngagementApiInfraConfig) => build(cfg).template;

/** The single target group, asserted to exist so tests never read undefined. */
function onlyTargetGroup(template: Template): { Properties: Record<string, any> } {
  const found = Object.values(
    template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'),
  );
  assert.equal(found.length, 1, 'expected exactly one target group');
  const group = found[0];
  assert.ok(group);
  return group as { Properties: Record<string, any> };
}

// ───────────────────────────────────────────────────────────── target group

test('creates exactly one target group with the exact name', () => {
  const template = synth();
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    Name: 'capiro-dev-engagement-api',
  });
});

test('the target group name stays inside the 32-character AWS limit', () => {
  for (const environment of ['dev', 'staging', 'prod'] as const) {
    const cfg = base();
    cfg.environment = environment;
    cfg.imageRepositoryName = `capiro/${environment}/engagement-api`;
    const name = onlyTargetGroup(synth(cfg)).Properties.Name as string;
    assert.ok(name.length <= 32, `${name} is ${name.length} characters`);
    assert.equal(name, `capiro-${environment}-engagement-api`);
  }
});

test('the target type is IP, as Fargate awsvpc tasks require', () => {
  synth().hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    TargetType: 'ip',
  });
});

test('the port is 4500 over HTTP in the imported VPC', () => {
  synth().hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    Port: 4500,
    Protocol: 'HTTP',
    VpcId: base().vpcId,
  });
});

test('the health check matches the Phase 2 contract exactly', () => {
  synth().hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    HealthCheckPath: '/health',
    HealthCheckPort: 'traffic-port',
    HealthCheckProtocol: 'HTTP',
    HealthCheckIntervalSeconds: 30,
    HealthCheckTimeoutSeconds: 5,
    HealthyThresholdCount: 2,
    UnhealthyThresholdCount: 3,
    Matcher: { HttpCode: '200' },
  });
});

test('deregistration delay is 30 seconds', () => {
  const attributes = onlyTargetGroup(synth()).Properties.TargetGroupAttributes as Array<{
    Key: string;
    Value: string;
  }>;
  const delay = attributes.find((a) => a.Key === 'deregistration_delay.timeout_seconds');
  assert.ok(delay, 'no deregistration delay attribute');
  assert.equal(delay.Value, '30');
});

test('the target group registers no targets', () => {
  const properties = onlyTargetGroup(synth()).Properties;
  assert.equal(properties.Targets, undefined, 'the target group must deploy empty');
});

test('the target group is retained so a rule can never outlive it', () => {
  synth().hasResource('AWS::ElasticLoadBalancingV2::TargetGroup', {
    DeletionPolicy: 'Retain',
  });
});

test('outputs expose the target group and the imported security group', () => {
  const outputs = synth().findOutputs('*');
  for (const key of ['TargetGroupArn', 'TargetGroupName', 'ServiceSecurityGroupId']) {
    assert.ok(Object.keys(outputs).includes(key), `missing output ${key}`);
  }
});

// ───────────────────────────────────────────────────────────────── isolation

test('the only resource in the stack is the target group', () => {
  const resources = synth().toJSON().Resources ?? {};
  const types = [...new Set(Object.values(resources).map((r) => (r as { Type: string }).Type))];
  assert.deepEqual(types, ['AWS::ElasticLoadBalancingV2::TargetGroup']);
});

test('no listener rule is created in CDK', () => {
  const template = synth();
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 0);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 0);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
});

test('no security group is created or mutated', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::SecurityGroup', 0);
  template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  template.resourceCountIs('AWS::EC2::SecurityGroupEgress', 0);
});

test('no VPC, subnet, ECS, database, DNS or certificate resource is created', () => {
  const template = synth();
  for (const type of [
    'AWS::EC2::VPC',
    'AWS::EC2::Subnet',
    'AWS::EC2::RouteTable',
    'AWS::EC2::NatGateway',
    'AWS::EC2::InternetGateway',
    'AWS::ECS::Cluster',
    'AWS::ECS::Service',
    'AWS::ECS::TaskDefinition',
    'AWS::RDS::DBCluster',
    'AWS::Route53::RecordSet',
    'AWS::CertificateManager::Certificate',
  ]) {
    template.resourceCountIs(type, 0);
  }
});

test('the stack references no historical Compute stack export', () => {
  assert.doesNotMatch(JSON.stringify(synth().toJSON()), /Capiro-[a-z]+-Compute/);
});

test('the VPC is imported by attributes, never looked up', () => {
  // A lookup would need live credentials at synth time and would cache context.
  const { stack } = build();
  assert.equal(stack.vpc.vpcId, base().vpcId);
  assert.deepEqual(stack.node.tryGetContext('vpc-provider:account=000000000000'), undefined);
});

// ────────────────────────────────────────────────────────── negative controls

test('NC-2.5-A adding a listener rule to this stack is visible to the guard', () => {
  // The real template has none.
  synth().resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 0);

  // Make the mistake this stack exists to prevent, on a fresh stack, and prove
  // the same assertion that guards the real template now fails.
  const stack = buildRaw();
  const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(
    stack,
    'ImportedListener',
    { listenerArn: base().httpsListenerArn, securityGroup: stack.serviceSecurityGroup },
  );
  new elbv2.ApplicationListenerRule(stack, 'RoguePreviewRule', {
    listener,
    priority: 6,
    conditions: [elbv2.ListenerCondition.pathPatterns(['/api/engagement/*'])],
    action: elbv2.ListenerAction.forward([stack.targetGroup]),
  });

  const mutated = Template.fromStack(stack);
  assert.throws(
    () => mutated.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 0),
    /ListenerRule/,
  );
  mutated.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 1);
});

test('NC-2.5-B the imported security group refuses an ingress mutation', () => {
  // `mutable: false` makes this a no-op rather than a template change: CDK
  // will not emit ingress onto an immutable imported group. The property that
  // matters is that the shared security group is still untouched afterwards.
  const stack = buildRaw();
  stack.serviceSecurityGroup.addIngressRule(
    ec2.Peer.anyIpv4(),
    ec2.Port.tcp(4500),
    'rogue ALB ingress',
  );

  const mutated = Template.fromStack(stack);
  mutated.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  mutated.resourceCountIs('AWS::EC2::SecurityGroup', 0);

  // And the stack still contains only the target group.
  const types = [
    ...new Set(
      Object.values(mutated.toJSON().Resources ?? {}).map((r) => (r as { Type: string }).Type),
    ),
  ];
  assert.deepEqual(types, ['AWS::ElasticLoadBalancingV2::TargetGroup']);
});

test('NC-2.5-C a health path other than /health is detectable', () => {
  const template = synth();
  assert.throws(
    () =>
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckPath: '/',
      }),
    /HealthCheckPath/,
  );
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    HealthCheckPath: '/health',
  });
});
