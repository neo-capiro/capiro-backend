import * as cdk from 'aws-cdk-lib';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

// Source-only candidate for the shared listener. Nothing imports this stack
// from a CDK bin or deploy command. Listener moves and the target group have
// separate owners and must be reviewed before this rule can be applied.
export const FIRST_CHAT_MERI_HOST = 'meri-preview.capiro.ai';
export const FIRST_CHAT_MERI_INGRESS_PRIORITY = 6;
export const FIRST_CHAT_MERI_INGRESS_STACK_NAME = 'Capiro-Preview-First-Chat-Meri-Ingress';
export const FIRST_CHAT_MERI_INGRESS_RULE_EXPORT =
  'Capiro-Preview-First-Chat-Meri-Ingress-RuleArn';

const account = '967807252336';
const region = 'us-east-1';
const listenerArn =
  `arn:aws:elasticloadbalancing:${region}:${account}:listener/app/capiro-prod-alb/7a4acb332b261724/e2d19b3dd47fc440`;

// The proposed control target has no physical ARN yet. A later reviewed
// action binding must name this dedicated target, never a production target.
const meriControlTargetArn = new RegExp(
  `^arn:aws:elasticloadbalancing:${region}:${account}:targetgroup/meri-product-preview-control/[0-9a-f]{16}$`,
);

export type FirstChatMeriIngressAction =
  | { schemaVersion: 1; state: 'DENY' }
  | { schemaVersion: 1; state: 'FORWARD'; targetGroupArn: string };

/** Closed source binding; it is not proof of target or image qualification. */
export function firstChatMeriIngressAction(input: unknown): FirstChatMeriIngressAction {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Meri ingress action object required');
  }
  const record = input as Record<string, unknown>;
  const fields = Object.keys(record).sort().join('|');
  if (record.schemaVersion !== 1) {
    throw new Error('Meri ingress action schemaVersion 1 required');
  }
  if (record.state === 'DENY' && fields === 'schemaVersion|state') {
    return { schemaVersion: 1, state: 'DENY' };
  }
  if (
    record.state === 'FORWARD' &&
    fields === 'schemaVersion|state|targetGroupArn' &&
    typeof record.targetGroupArn === 'string' &&
    meriControlTargetArn.test(record.targetGroupArn)
  ) {
    return {
      schemaVersion: 1,
      state: 'FORWARD',
      targetGroupArn: record.targetGroupArn,
    };
  }
  throw new Error('Exact Meri DENY or dedicated control FORWARD action required');
}

/**
 * One independent retained rule. DENY is the only default and rollback action.
 * FORWARD requires a separate review of the target, image, and health; this
 * construct merely renders a bounded action on the same logical rule.
 */
export class FirstChatMeriIngressStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    input: unknown = { schemaVersion: 1, state: 'DENY' },
  ) {
    super(scope, id, { env: { account, region } });
    const action = firstChatMeriIngressAction(input);
    const rule = new elb.CfnListenerRule(this, 'MeriPreviewHostIngress', {
      listenerArn,
      priority: FIRST_CHAT_MERI_INGRESS_PRIORITY,
      conditions: [
        { field: 'host-header', hostHeaderConfig: { values: [FIRST_CHAT_MERI_HOST] } },
      ],
      actions: action.state === 'DENY'
        ? [{
            type: 'fixed-response',
            fixedResponseConfig: {
              statusCode: '404',
              contentType: 'application/json',
              messageBody: '{"error":"MERI_PREVIEW_ROUTE_NOT_FOUND"}',
            },
          }]
        : [{ type: 'forward', targetGroupArn: action.targetGroupArn }],
    });
    // Keep the host deny boundary if a later change set or stack deletion
    // fails. Retention alone does not change a FORWARD action back to DENY.
    rule.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
    rule.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;
    new cdk.CfnOutput(this, 'MeriPreviewHostIngressRuleArn', {
      value: rule.ref,
      exportName: FIRST_CHAT_MERI_INGRESS_RULE_EXPORT,
    });
  }
}
