import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import {
  PREVIEW_EDGE_PREFIXES,
  PREVIEW_EDGE_SERVICES,
  PREVIEW_ENGAGEMENT_TARGET,
  PREVIEW_ONBOARD_TARGET,
  previewFirstChatEdgeApplication,
} from '../lib/preview/first-chat-preview-edge';

const host = 'first-chat-preview.app-dev.capiro.ai';
const id = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const core = { Ref: 'CoreTarget' };
const strategy = { Ref: 'StrategyTarget' };
const workspace = { Ref: 'WorkspaceTarget' };
const intel = { Ref: 'IntelTarget' };

function render(includeDns: boolean, check: (edge: any, dns: any) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-edge-'));
  try {
    const { edge, dns } = previewFirstChatEdgeApplication(dir, includeDns);
    check(Template.fromStack(edge).toJSON(), dns ? Template.fromStack(dns).toJSON() : null);
  } finally {
    const real = fs.realpathSync(dir);
    assert.equal(fs.lstatSync(dir).isSymbolicLink(), false);
    assert.ok(real.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(real, { recursive: true });
  }
}
const ofType = (template: any, type: string): any[] =>
  Object.values(template.Resources).filter((resource: any) => resource.Type === type);
const listenerRules = (edge: any) =>
  ofType(edge, 'AWS::ElasticLoadBalancingV2::ListenerRule')
    .map((resource) => resource.Properties)
    .sort((a, b) => Number(a.Priority) - Number(b.Priority));

/** ALB first-match evaluation: host, optional method, then glob or regex paths. */
function routeDestination(rules: any[], method: string, pathname: string, hostname = host) {
  const glob = (pattern: string) =>
    new RegExp(
      '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$',
    );
  for (const rule of rules) {
    const condition = (field: string) => rule.Conditions.find((c: any) => c.Field === field);
    if (!condition('host-header').HostHeaderConfig.Values.includes(hostname)) continue;
    const verbs = condition('http-request-method')?.HttpRequestMethodConfig.Values;
    if (verbs && !verbs.includes(method)) continue;
    const paths = condition('path-pattern').PathPatternConfig;
    const matches = paths.RegexValues
      ? paths.RegexValues.some((regex: string) => new RegExp(regex).test(pathname))
      : paths.Values.some((pattern: string) => glob(pattern).test(pathname));
    if (matches) return rule.Actions[0].TargetGroupArn;
  }
  return null;
}

test('the preview host forwards each service namespace, every method, to its own target', () =>
  render(false, (edge) => {
    const rules = listenerRules(edge);
    assert.deepEqual(
      rules.map((rule) => [
        rule.Priority,
        rule.Conditions.find((c: any) => c.Field === 'path-pattern').PathPatternConfig.Values,
      ]),
      [
        [190, ['/api/engagement/outreach-v3/*']],
        [200, ['/api/*']],
        [201, ['/strategy-api/*']],
        [202, ['/workspace-api/*']],
        [203, ['/intel-api/*']],
        [204, ['/onboard-api/*']],
        [205, ['/webhooks/*']],
      ],
    );
    assert.deepEqual(
      PREVIEW_EDGE_PREFIXES.map((route) => route.owner),
      ['engagement', 'core', 'strategy', 'workspace', 'intel', 'onboard', 'core'],
    );
    for (const rule of rules) {
      assert.deepEqual(rule.ListenerArn, { Ref: 'PreviewHttps' });
      // Host and path only: no method condition, so every method reaches the owner.
      assert.deepEqual(
        rule.Conditions.map((c: any) => c.Field),
        ['host-header', 'path-pattern'],
      );
      assert.deepEqual(rule.Conditions[0].HostHeaderConfig.Values, [host]);
      assert.equal(rule.Actions.length, 1);
      assert.equal(rule.Actions[0].Type, 'forward');
    }
    const expected: [string, unknown][] = [
      ['/api/clients', core],
      ['/strategy-api/planner/strategies', strategy],
      ['/workspace-api/drafts', workspace],
      ['/intel-api/clients/x/tracker/track', intel],
      ['/onboard-api/setup/state', PREVIEW_ONBOARD_TARGET],
      ['/webhooks/clerk', core],
      ['/webhooks/recall/bot-status', core],
    ];
    for (const [pathname, target] of expected)
      for (const method of methods)
        assert.deepEqual(routeDestination(rules, method, pathname), target, `${method} ${pathname}`);
  }));

test('Outreach v3 reaches the preview engagement-api while the rest of engagement stays on Core', () =>
  render(false, (edge) => {
    const rules = listenerRules(edge);
    for (const pathname of [
      '/api/engagement/outreach-v3/sessions',
      '/api/engagement/outreach-v3/templates/from-scratch',
      `/api/engagement/outreach-v3/sessions/${id}/generation`,
      `/api/engagement/outreach-v3/sessions/${id}/send`,
    ])
      for (const method of methods)
        assert.deepEqual(routeDestination(rules, method, pathname), PREVIEW_ENGAGEMENT_TARGET, `${method} ${pathname}`);
    for (const pathname of [
      '/api/engagement/mail/send',
      '/api/engagement/meetings',
      '/api/engagement/outreach',
      '/api/engagement/outreach/send-intents',
      '/api/engagement/integrations/microsoft/notifications',
      '/api/engagement/outreach-v3',
      '/api/engagement/outreach-v3x/sessions',
    ])
      assert.deepEqual(routeDestination(rules, 'POST', pathname), core, pathname);
    assert.equal(
      routeDestination(rules, 'POST', '/api/engagement/outreach-v3/sessions', 'app.capiro.ai'),
      null,
    );
  }));

test('product writes the per-path allowlist dropped now reach their owning service', () =>
  render(false, (edge) => {
    const rules = listenerRules(edge);
    // Each answered the edge 404 PREVIEW_ROUTE_NOT_FOUND on 2 Nov 2026, or was
    // forwarded only by a hand-added live rule outside this definition.
    const writes: [string, string, unknown][] = [
      ['POST', '/api/clio/action-proposals', core],
      ['POST', `/api/clio/action-proposals/${id}/approve`, core],
      ['POST', '/api/clio/conversations', core],
      ['POST', `/api/clients/${id}/objectives`, core],
      ['PATCH', `/api/clients/${id}/objectives`, core],
      ['DELETE', `/api/clients/${id}/objectives`, core],
      ['POST', `/api/clients/${id}/objectives/transition`, core],
      ['POST', `/api/clients/${id}/objectives/${child}/generation/commands`, core],
      ['POST', `/api/clients/${id}/objectives/${child}/questions`, core],
      ['POST', '/api/clio/mcp-servers/from-catalog', core],
      ['DELETE', `/api/clio/mcp-servers/${id}`, core],
      ['POST', `/api/engagement/meetings/${id}/prep`, core],
      ['PATCH', `/api/engagement/meeting-preps/${id}`, core],
      ['POST', '/api/engagement/outreach/send-intents', core],
      ['POST', `/api/business-development/prospects/${id}/watch`, core],
      ['POST', '/api/clio/office-drafts/save', core],
      ['POST', '/api/workspace/collaborator-invite-email', core],
      ['POST', '/strategy-api/planner/strategy-materializations', strategy],
      ['PATCH', `/strategy-api/planner/strategies/${id}`, strategy],
      ['POST', `/intel-api/clients/${id}/tracker/test-alert`, intel],
      ['POST', '/onboard-api/setup/complete', PREVIEW_ONBOARD_TARGET],
    ];
    for (const [method, pathname, target] of writes)
      assert.deepEqual(routeDestination(rules, method, pathname), target, `${method} ${pathname}`);
  }));

test('internal routes reach only their owning service, which enforces its service secret', () =>
  render(false, (edge) => {
    const rules = listenerRules(edge);
    // Backend services call these through this host (API_INTERNAL_URL), so the
    // edge forwards them; each owner fails closed without the secret or signed proof.
    const internal: [string, unknown][] = [
      ['/api/internal/ai-credentials/resolve', core],
      ['/api/internal/routines/current', core],
      ['/api/internal/objective-workload-authority/decisions', core],
      ['/strategy-api/internal/objective-canonical/generation-requests', strategy],
      ['/workspace-api/internal/workspace/collaborator-invitations/email-context', workspace],
      ['/intel-api/internal/hearing-record-retrieval', intel],
    ];
    for (const [pathname, target] of internal)
      for (const method of ['GET', 'POST'])
        assert.deepEqual(routeDestination(rules, method, pathname), target, `${method} ${pathname}`);
    assert.equal(
      edge.Outputs.StrategySavedReadEnvironment.Value,
      JSON.stringify({ API_INTERNAL_URL: `https://${host}` }),
    );
  }));

test('other hosts, unknown prefixes and prefix look-alikes keep the listener 404', () =>
  render(false, (edge) => {
    const rules = listenerRules(edge);
    for (const hostname of [
      'app.capiro.ai',
      'os.capiro.ai',
      'office-preview.app-dev.capiro.ai',
      'arbitrary.invalid',
    ])
      for (const pathname of ['/api/clients', '/strategy-api/planner/strategies', '/workspace-api/drafts'])
        assert.equal(routeDestination(rules, 'POST', pathname, hostname), null, `${hostname} ${pathname}`);
    for (const pathname of [
      '/',
      '/api',
      '/apiextra/clients',
      '/API/clients',
      '/strategy-api',
      '/meri-api/runs',
      '/webhooks',
      '/health',
      '/extra/api/clients',
      '/onboard/setup',
    ])
      for (const method of ['GET', 'POST'])
        assert.equal(routeDestination(rules, method, pathname), null, `${method} ${pathname}`);
  }));

test('dedicated edge reuses only existing network/certificate and has no shared-listener mutation', () =>
  render(false, (edge, dns) => {
    assert.equal(dns, null);
    const allowed = new Set([
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'AWS::ElasticLoadBalancingV2::Listener',
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      'AWS::ElasticLoadBalancingV2::ListenerRule',
      'AWS::WAFv2::WebACLAssociation',
      'AWS::EC2::SecurityGroup',
      'AWS::EC2::SecurityGroupIngress',
      'AWS::SecretsManager::Secret',
      'AWS::IAM::ManagedPolicy',
    ]);
    for (const resource of Object.values(edge.Resources) as any[])
      assert.ok(allowed.has(resource.Type));
    const [alb] = ofType(edge, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    assert.equal(alb.Properties.Scheme, 'internet-facing');
    assert.deepEqual(alb.Properties.SecurityGroups, ['sg-0dc7236a6d67e4340']);
    assert.deepEqual(alb.Properties.LoadBalancerAttributes, [
      { Key: 'idle_timeout.timeout_seconds', Value: '4000' },
    ]);
    const [waf] = ofType(edge, 'AWS::WAFv2::WebACLAssociation');
    assert.deepEqual(waf.Properties, {
      ResourceArn: { Ref: 'PreviewLoadBalancer' },
      WebACLArn:
        'arn:aws:wafv2:us-east-1:967807252336:regional/webacl/capiro-dev-waf/95dc2979-45e1-4c94-9ea8-650dfb21c516',
    });
    assert.deepEqual(alb.Properties.Subnets, [
      'subnet-0adcda6d70a456c21',
      'subnet-0d368aeedf6133ca8',
      'subnet-054ee44795a3d07c8',
    ]);
    const [listener] = ofType(edge, 'AWS::ElasticLoadBalancingV2::Listener');
    assert.deepEqual(listener.Properties.LoadBalancerArn, { Ref: 'PreviewLoadBalancer' });
    assert.equal(listener.Properties.Port, 443);
    assert.equal(listener.Properties.SslPolicy, 'ELBSecurityPolicy-TLS13-1-2-2021-06');
    assert.equal(
      listener.Properties.Certificates[0].CertificateArn,
      'arn:aws:acm:us-east-1:967807252336:certificate/70b04aad-4971-4bba-81a8-30da1b1d97b5',
    );
    assert.deepEqual(listener.Properties.DefaultActions, [
      {
        Type: 'fixed-response',
        FixedResponseConfig: {
          StatusCode: '404',
          ContentType: 'application/json',
          MessageBody: '{"error":"PREVIEW_ROUTE_NOT_FOUND"}',
        },
      },
    ]);
    assert.equal(JSON.stringify(edge).includes('listener/app/capiro-prod-alb'), false);
    assert.equal(ofType(edge, 'AWS::ElasticLoadBalancingV2::TargetGroup').length, 4);
  }));

test('the Workspace export signing key stays retained and readable only through the existing execution role', () =>
  render(false, (edge) => {
    const secret = edge.Resources.WorkspaceExportSigningSecret;
    assert.equal(secret.DeletionPolicy, 'Retain');
    assert.equal(secret.UpdateReplacePolicy, 'Retain');
    assert.equal(secret.Properties.Name, '/capiro/preview/workspace/export-signing');
    assert.deepEqual(secret.Properties.GenerateSecretString, {
      ExcludePunctuation: true,
      IncludeSpace: false,
      PasswordLength: 64,
    });
    const policy = edge.Resources.WorkspaceExportSigningRead.Properties;
    assert.deepEqual(policy.PolicyDocument.Statement, [
      {
        Action: ['secretsmanager:GetSecretValue'],
        Effect: 'Allow',
        Resource: { Ref: 'WorkspaceExportSigningSecret' },
      },
    ]);
    assert.deepEqual(policy.Roles, ['Capiro-dev-Compute-ApiTaskDefExecutionRoleE6ABB053-YlEDKuUPHjLg']);
    assert.deepEqual(edge.Outputs.WorkspaceExportSigningSecretArn.Value, {
      Ref: 'WorkspaceExportSigningSecret',
    });
  }));

test('private Meri HTTPS admits only the new preview backend identity, preserving shared SG access', () =>
  render(false, (edge) => {
    const [client] = ofType(edge, 'AWS::EC2::SecurityGroup');
    assert.equal(client.Properties.VpcId, 'vpc-0ac26cfac7ed972be');
    assert.equal(client.Properties.SecurityGroupIngress, undefined);
    assert.deepEqual(client.Properties.SecurityGroupEgress, [
      {
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        DestinationSecurityGroupId: 'sg-0c3fe2e509b22ee5c',
      },
    ]);
    const ingress = ofType(edge, 'AWS::EC2::SecurityGroupIngress');
    assert.equal(ingress.length, 1);
    assert.deepEqual(ingress[0].Properties, {
      GroupId: 'sg-0c3fe2e509b22ee5c',
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      SourceSecurityGroupId: { 'Fn::GetAtt': ['MeriBackendClient', 'GroupId'] },
      Description: 'Preview Core and Strategy only',
    });
    const binding = JSON.stringify(edge.Outputs.StrategySecurityGroups.Value);
    assert.ok(binding.includes('sg-01def4e5c0fe44d4a') && binding.includes('MeriBackendClient'));
    assert.equal(
      edge.Outputs.MeriClientSecurityGroupId.Export.Name,
      'Capiro-Preview-Services-Edge-MeriClientSecurityGroupId',
    );
    assert.equal(JSON.stringify(ingress).includes('sg-01def4e5c0fe44d4a'), false);
  }));

test('service attachment outputs retain old and new preview targets with original container ports', () =>
  render(false, (edge) => {
    for (const [owner, service] of Object.entries(PREVIEW_EDGE_SERVICES)) {
      const name = owner[0]!.toUpperCase() + owner.slice(1);
      const target = edge.Resources[`${name}Target`].Properties;
      assert.equal(target.VpcId, 'vpc-0ac26cfac7ed972be');
      assert.equal(target.TargetType, 'ip');
      assert.equal(target.Port, service.port);
      assert.equal(target.HealthCheckPath, service.health);
      const binding = JSON.stringify(edge.Outputs[`${name}ServiceLoadBalancers`].Value);
      assert.ok(binding.includes(service.oldTarget));
      assert.ok(binding.includes(`"Ref":"${name}Target"`));
      assert.ok(binding.includes(service.containerName));
      assert.ok(binding.includes(String(service.port)));
    }
    assert.ok(JSON.stringify(edge).includes(PREVIEW_ONBOARD_TARGET));
    assert.equal(JSON.stringify(edge).includes('capiro-dev-onboard-api'), false);
  }));

test('DNS is a separately rendered exact preview alias, with the wildcard left outside ownership', () =>
  render(true, (edge, dns) => {
    assert.equal(ofType(edge, 'AWS::Route53::RecordSet').length, 0);
    assert.equal(Object.keys(dns.Resources).length, 1);
    assert.deepEqual(dns.Resources.FirstChatAlias.Properties, {
      HostedZoneId: 'Z085985135X6Q5QT98ZBK',
      Name: `${host}.`,
      Type: 'A',
      AliasTarget: {
        DNSName: { 'Fn::ImportValue': 'Capiro-Preview-Services-Edge-DnsName' },
        HostedZoneId: { 'Fn::ImportValue': 'Capiro-Preview-Services-Edge-HostedZoneId' },
        EvaluateTargetHealth: false,
      },
    });
  }));
