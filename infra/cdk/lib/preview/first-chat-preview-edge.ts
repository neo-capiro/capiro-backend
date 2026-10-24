import * as cdk from 'aws-cdk-lib';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import coreRoutes from './first-chat-core-routes.json';
import writes from './first-chat-preview-writes.json';

export const FIRST_CHAT_PREVIEW_EDGE_STACK = 'Capiro-Preview-Services-Edge';
export const PREVIEW_EDGE_CORE_TARGET_EXPORT = `${FIRST_CHAT_PREVIEW_EDGE_STACK}-CoreTargetArn`;
const dnsExport = `${FIRST_CHAT_PREVIEW_EDGE_STACK}-DnsName`;
const zoneExport = `${FIRST_CHAT_PREVIEW_EDGE_STACK}-HostedZoneId`;
const env = { account: '967807252336', region: 'us-east-1' };
const vpcId = 'vpc-0ac26cfac7ed972be';
const targetArn = (name: string, id: string) =>
  `arn:aws:elasticloadbalancing:us-east-1:967807252336:targetgroup/${name}/${id}`;

// Existing service identities from the full read-only October 24 inventory.
// New groups are SECOND attachments. Keep old attachments through DNS cutover.
export const PREVIEW_EDGE_SERVICES = {
  core: {
    serviceName: 'capiro-preview-first-chat-core',
    containerName: 'core',
    port: 4000,
    health: '/health',
    oldTarget: targetArn('Capiro-CoreT-NHA4DBPHLZ2E', '11512f9487ee2f54'),
  },
  strategy: {
    serviceName: 'capiro-preview-api-strategy',
    containerName: 'api-strategy',
    port: 4400,
    health: '/strategy-api/health',
    oldTarget: targetArn('capiro-preview-api-strategy', '9b9f2b7f3a7557a3'),
  },
  workspace: {
    serviceName: 'capiro-preview-workspace',
    containerName: 'workspace',
    port: 4200,
    health: '/health',
    oldTarget: targetArn('capiro-preview-workspace', '22b9cc808113f82c'),
  },
  intel: {
    serviceName: 'capiro-preview-intel-api',
    containerName: 'intel-api',
    port: 4300,
    health: '/health',
    oldTarget: targetArn('capiro-preview-intel-api', 'c8702677c0884b1c'),
  },
} as const;
export const PREVIEW_ONBOARD_TARGET = targetArn('capiro-preview-onboard-api', 'e1ffa6a1394ba2ca');

/** Dedicated preview edge in the existing VPC. Never owns a shared listener rule,
 * service, security-group rule, certificate, database or production DNS record. */
export class FirstChatPreviewEdgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id, {
      env,
      description: 'Dedicated first-chat preview ingress; existing shared listener untouched.',
    });
    const alb = new elb.CfnLoadBalancer(this, 'PreviewLoadBalancer', {
      name: 'capiro-preview-services',
      type: 'application',
      scheme: 'internet-facing',
      ipAddressType: 'ipv4',
      securityGroups: ['sg-0dc7236a6d67e4340'],
      subnets: ['subnet-0adcda6d70a456c21', 'subnet-0d368aeedf6133ca8', 'subnet-054ee44795a3d07c8'],
    });
    const listener = new elb.CfnListener(this, 'PreviewHttps', {
      loadBalancerArn: alb.ref,
      port: 443,
      protocol: 'HTTPS',
      certificates: [
        {
          certificateArn:
            'arn:aws:acm:us-east-1:967807252336:certificate/70b04aad-4971-4bba-81a8-30da1b1d97b5',
        },
      ],
      sslPolicy: 'ELBSecurityPolicy-2016-08',
      defaultActions: [
        {
          type: 'fixed-response',
          fixedResponseConfig: {
            statusCode: '404',
            contentType: 'application/json',
            messageBody: '{"error":"PREVIEW_ROUTE_NOT_FOUND"}',
          },
        },
      ],
    });
    const targets: Record<string, string> = { onboard: PREVIEW_ONBOARD_TARGET };
    for (const [owner, service] of Object.entries(PREVIEW_EDGE_SERVICES)) {
      const name = owner[0]!.toUpperCase() + owner.slice(1);
      const target = new elb.CfnTargetGroup(this, `${name}Target`, {
        name: `capiro-preview-edge-${owner}`,
        vpcId,
        protocol: 'HTTP',
        port: service.port,
        targetType: 'ip',
        healthCheckPath: service.health,
        healthCheckPort: 'traffic-port',
        matcher: { httpCode: '200' },
      });
      targets[owner] = target.ref;
      new cdk.CfnOutput(this, `${name}TargetArn`, {
        value: target.ref,
        exportName: `${FIRST_CHAT_PREVIEW_EDGE_STACK}-${name}TargetArn`,
      });
      // Root applies satellites through their existing service owner. Core's
      // existing CDK service imports the CoreTargetArn export itself.
      new cdk.CfnOutput(this, `${name}ServiceLoadBalancers`, {
        value: this.toJsonString(
          [service.oldTarget, target.ref].map((arn) => ({
            targetGroupArn: arn,
            containerName: service.containerName,
            containerPort: service.port,
          })),
        ),
      });
    }
    let priority = 1;
    const forward = (
      id: string,
      owner: string,
      methods: string[],
      paths: string[],
      regex: boolean,
    ) => {
      if (
        !targets[owner] ||
        paths.length > 3 ||
        paths.length + methods.length + 1 > 5 ||
        paths.some((path) => path.length > 128)
      )
        throw new Error('Invalid finite preview route');
      new elb.CfnListenerRule(this, id, {
        listenerArn: listener.ref,
        priority: priority++,
        conditions: [
          { field: 'host-header', hostHeaderConfig: { values: [coreRoutes.host] } },
          { field: 'http-request-method', httpRequestMethodConfig: { values: methods } },
          {
            field: 'path-pattern',
            pathPatternConfig: regex ? { regexValues: paths } : { values: paths },
          },
        ],
        actions: [{ type: 'forward', targetGroupArn: targets[owner] }],
      });
    };
    forward('CoreChatPosts', 'core', ['POST'], [...coreRoutes.post, writes.corePostAddition], true);
    for (const [owner, prefix] of [
      ['core', 'api'],
      ['strategy', 'strategy-api'],
      ['workspace', 'workspace-api'],
      ['intel', 'intel-api'],
    ]) {
      forward(`${owner}Reads`, owner!, ['GET', 'HEAD'], [`/${prefix}/*`], false);
    }
    writes.groups.forEach((group, index) =>
      forward(`Wave2Writes${index + 1}`, group.service, [group.method], group.pathRegexes, true),
    );
    new cdk.CfnOutput(this, 'DnsName', { value: alb.attrDnsName, exportName: dnsExport });
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: alb.attrCanonicalHostedZoneId,
      exportName: zoneExport,
    });
  }
}

/** Apply this separate DNS stack LAST, after root verifies every new target and
 * authenticated route. Deleting it restores the unchanged guarded wildcard. */
export class FirstChatPreviewDnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id, { env, description: 'Final explicit first-chat preview DNS cutover only.' });
    new route53.CfnRecordSet(this, 'FirstChatAlias', {
      hostedZoneId: 'Z085985135X6Q5QT98ZBK',
      name: `${coreRoutes.host}.`,
      type: 'A',
      aliasTarget: {
        dnsName: cdk.Fn.importValue(dnsExport),
        hostedZoneId: cdk.Fn.importValue(zoneExport),
        evaluateTargetHealth: false,
      },
    });
  }
}

/** Rendering only. The default deliberately omits the separate DNS cutover. */
export function previewFirstChatEdgeApplication(outdir: string, includeDns = false) {
  const app = new cdk.App({ outdir });
  const edge = new FirstChatPreviewEdgeStack(app, FIRST_CHAT_PREVIEW_EDGE_STACK);
  const dns = includeDns ? new FirstChatPreviewDnsStack(app, 'Capiro-Preview-Services-Dns') : null;
  if (dns) dns.addStackDependency(edge);
  return { app, edge, dns };
}
