import * as cdk from 'aws-cdk-lib';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { Construct } from 'constructs';
import coreRoutes from './first-chat-core-routes.json';
import writes from './first-chat-preview-writes.json';

export const FIRST_CHAT_PREVIEW_EDGE_STACK = 'Capiro-Preview-Services-Edge';
export const PREVIEW_EDGE_CORE_TARGET_EXPORT = `${FIRST_CHAT_PREVIEW_EDGE_STACK}-CoreTargetArn`;
export const PREVIEW_MERI_CLIENT_GROUP_EXPORT = `${FIRST_CHAT_PREVIEW_EDGE_STACK}-MeriClientSecurityGroupId`;
const meriCa = readFileSync(join(__dirname, 'meri-control-ca.pem'));
const meriCaDerSha256 = 'e177a1bc059a0fd7c54740f6db6619c992af01d1fda804d6c2058f0bd53995d4';
if (createHash('sha256').update(new X509Certificate(meriCa).raw).digest('hex') !== meriCaDerSha256)
  throw new Error('Pinned Meri preview public CA required');
export const MERI_PREVIEW_CONTROL_ENVIRONMENT = {
  MERI_CONTROL_ORIGIN: 'https://control.meri-preview.internal',
  MERI_CONTROL_CA_BASE64: meriCa.toString('base64'),
  // DER certificate digest, independent of PEM line endings.
  MERI_CONTROL_CA_SHA256: meriCaDerSha256,
} as const;
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

/** Dedicated preview edge and backend client identity in the existing VPC.
 * Never owns a shared listener rule, live service, certificate or production DNS. */
export class FirstChatPreviewEdgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id, {
      env,
      description: 'Dedicated first-chat preview ingress; existing shared listener untouched.',
    });
    // Only preview Core and Strategy receive this additional identity. The
    // shared ServiceSg must never gain access to Meri's private control listener.
    const meriClient = new ec2.CfnSecurityGroup(this, 'MeriBackendClient', {
      groupDescription: 'Preview Core and Strategy to Meri private HTTPS only',
      vpcId,
      securityGroupEgress: [
        {
          ipProtocol: 'tcp',
          fromPort: 443,
          toPort: 443,
          destinationSecurityGroupId: 'sg-0c3fe2e509b22ee5c',
        },
      ],
    });
    new ec2.CfnSecurityGroupIngress(this, 'MeriPrivateHttpsFromBackend', {
      groupId: 'sg-0c3fe2e509b22ee5c',
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      sourceSecurityGroupId: meriClient.attrGroupId,
      description: 'Preview Core and Strategy only',
    });
    new cdk.CfnOutput(this, 'MeriClientSecurityGroupId', {
      value: meriClient.attrGroupId,
      exportName: PREVIEW_MERI_CLIENT_GROUP_EXPORT,
    });
    new cdk.CfnOutput(this, 'StrategySecurityGroups', {
      value: this.toJsonString(['sg-01def4e5c0fe44d4a', meriClient.attrGroupId]),
    });
    new cdk.CfnOutput(this, 'StrategyMeriControlEnvironment', {
      value: this.toJsonString(MERI_PREVIEW_CONTROL_ENVIRONMENT),
    });
    const alb = new elb.CfnLoadBalancer(this, 'PreviewLoadBalancer', {
      name: 'capiro-preview-services',
      type: 'application',
      scheme: 'internet-facing',
      ipAddressType: 'ipv4',
      securityGroups: ['sg-0dc7236a6d67e4340'],
      loadBalancerAttributes: [{ key: 'idle_timeout.timeout_seconds', value: '4000' }],
      subnets: ['subnet-0adcda6d70a456c21', 'subnet-0d368aeedf6133ca8', 'subnet-054ee44795a3d07c8'],
    });
    // Preserve the existing ingress inspection policy without changing its
    // rules or its association with the shared load balancer.
    new wafv2.CfnWebACLAssociation(this, 'ExistingPreviewWebAcl', {
      resourceArn: alb.ref,
      webAclArn:
        'arn:aws:wafv2:us-east-1:967807252336:regional/webacl/capiro-dev-waf/95dc2979-45e1-4c94-9ea8-650dfb21c516',
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
      forward('id' in group ? group.id ?? `Wave2Writes${index + 1}` : `Wave2Writes${index + 1}`, group.service, [group.method], group.pathRegexes, true),
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
