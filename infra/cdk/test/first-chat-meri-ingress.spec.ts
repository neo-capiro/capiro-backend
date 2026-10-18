import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  FIRST_CHAT_MERI_HOST,
  FIRST_CHAT_MERI_INGRESS_PRIORITY,
  FIRST_CHAT_MERI_INGRESS_RULE_EXPORT,
  FIRST_CHAT_MERI_INGRESS_STACK_NAME,
  FirstChatMeriIngressStack,
  firstChatMeriIngressAction,
} from '../lib/preview/first-chat-meri-ingress';

const targetGroupArn =
  'arn:aws:elasticloadbalancing:us-east-1:967807252336:targetgroup/meri-product-preview-control/1234567890abcdef';
const deny = { schemaVersion: 1, state: 'DENY' };
const forward = { schemaVersion: 1, state: 'FORWARD', targetGroupArn };

function synthesized(input?: unknown): any {
  const app = new cdk.App();
  const stack = new FirstChatMeriIngressStack(
    app,
    FIRST_CHAT_MERI_INGRESS_STACK_NAME,
    input,
  );
  return Template.fromStack(stack).toJSON();
}

test('defaults to one retained exact-host deny with no target, service, DNS, or security resource', () => {
  const template = synthesized();
  assert.deepEqual(Object.keys(template.Resources), ['MeriPreviewHostIngress']);
  const rule = template.Resources.MeriPreviewHostIngress;
  assert.equal(rule.Type, 'AWS::ElasticLoadBalancingV2::ListenerRule');
  assert.equal(rule.DeletionPolicy, 'Retain');
  assert.equal(rule.UpdateReplacePolicy, 'Retain');
  assert.equal(rule.Properties.ListenerArn,
    'arn:aws:elasticloadbalancing:us-east-1:967807252336:listener/app/capiro-prod-alb/7a4acb332b261724/e2d19b3dd47fc440');
  assert.equal(rule.Properties.Priority, FIRST_CHAT_MERI_INGRESS_PRIORITY);
  assert.equal(rule.Properties.Priority, 6);
  assert.deepEqual(rule.Properties.Conditions, [
    { Field: 'host-header', HostHeaderConfig: { Values: [FIRST_CHAT_MERI_HOST] } },
  ]);
  assert.deepEqual(rule.Properties.Actions, [{
    Type: 'fixed-response',
    FixedResponseConfig: {
      StatusCode: '404',
      ContentType: 'application/json',
      MessageBody: '{"error":"MERI_PREVIEW_ROUTE_NOT_FOUND"}',
    },
  }]);
  assert.deepEqual(template.Outputs.MeriPreviewHostIngressRuleArn, {
    Value: { Ref: 'MeriPreviewHostIngress' },
    Export: { Name: FIRST_CHAT_MERI_INGRESS_RULE_EXPORT },
  });
});

test('DENY to reviewed FORWARD and back to DENY changes only the same rule action', () => {
  const before = synthesized(deny);
  const during = synthesized(forward);
  const after = synthesized(deny);
  assert.deepEqual(after, before);
  const rule = during.Resources.MeriPreviewHostIngress;
  assert.deepEqual(rule.Properties.Actions, [
    { Type: 'forward', TargetGroupArn: targetGroupArn },
  ]);
  const withoutAction = structuredClone(during);
  withoutAction.Resources.MeriPreviewHostIngress.Properties.Actions =
    before.Resources.MeriPreviewHostIngress.Properties.Actions;
  assert.deepEqual(withoutAction, before);
});

test('forward action requires a closed dedicated Meri control target binding', () => {
  assert.deepEqual(firstChatMeriIngressAction(deny), deny);
  assert.deepEqual(firstChatMeriIngressAction(forward), forward);
  for (const invalid of [
    null,
    [],
    {},
    { ...deny, state: 'FORWARD' },
    { ...deny, targetGroupArn },
    { ...deny, schemaVersion: 2 },
    { ...forward, qualification: 'unreviewed' },
    { ...forward, targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:967807252336:targetgroup/capiro-prod-api-tg/3343fe60b1395f62' },
    { ...forward, targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-2:967807252336:targetgroup/meri-product-preview-control/1234567890abcdef' },
    { ...forward, targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/meri-product-preview-control/1234567890abcdef' },
    { ...forward, targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:967807252336:targetgroup/meri-product-preview-control/not-a-target-id' },
  ]) {
    assert.throws(() => firstChatMeriIngressAction(invalid));
    assert.throws(() => synthesized(invalid));
  }
});
