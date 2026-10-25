import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import {
  PREVIEW_EDGE_SERVICES,
  PREVIEW_ONBOARD_TARGET,
  previewFirstChatEdgeApplication,
} from '../lib/preview/first-chat-preview-edge';
import callers from './fixtures/first-chat-wave2-routes.json';

const host = 'first-chat-preview.app-dev.capiro.ai';
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

test('finite method/path routes admit their owners and reject unintended cross-products, suffixes and hosts', () =>
  render(false, (edge) => {
    const rules = ofType(edge, 'AWS::ElasticLoadBalancingV2::ListenerRule').map(
      (r) => r.Properties,
    );
    assert.equal(rules.length, 54);
    for (const rule of rules) {
      assert.deepEqual(rule.ListenerArn, { Ref: 'PreviewHttps' });
      const conditions = rule.Conditions;
      assert.deepEqual(
        conditions.find((c: any) => c.Field === 'host-header').HostHeaderConfig.Values,
        [host],
      );
      const paths = conditions.find((c: any) => c.Field === 'path-pattern').PathPatternConfig;
      const expressions = paths.RegexValues ?? paths.Values;
      const methods = conditions.find((c: any) => c.Field === 'http-request-method')
        .HttpRequestMethodConfig.Values;
      assert.ok(expressions.length <= 3 && expressions.length + methods.length + 1 <= 5);
      assert.ok(expressions.every((p: string) => p.length <= 128));
    }
    function destination(method: string, pathname: string, hostname = host) {
      for (const rule of rules) {
        const condition = (field: string) => rule.Conditions.find((c: any) => c.Field === field);
        if (
          !condition('host-header').HostHeaderConfig.Values.includes(hostname) ||
          !condition('http-request-method').HttpRequestMethodConfig.Values.includes(method)
        )
          continue;
        const p = condition('path-pattern').PathPatternConfig;
        const matches = p.RegexValues
          ? p.RegexValues.some((regex: string) => new RegExp(regex).test(pathname))
          : p.Values.some((glob: string) => pathname.startsWith(glob.slice(0, -1)));
        if (matches) return rule.Actions[0].TargetGroupArn;
      }
      return null;
    }
    const concrete = (route: string) =>
      route.replace(/:[A-Za-z]+/g, '11111111-1111-4111-8111-111111111111');
    const registeredPath = (template: string, pathname: string) =>
      new RegExp(
        `^${template
          .split('/')
          .map((segment) =>
            segment.startsWith(':')
              ? '[A-Za-z0-9_-]+'
              : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          )
          .join('/')}$`,
      ).test(pathname);
    const target = (owner: string) =>
      owner === 'onboard'
        ? PREVIEW_ONBOARD_TARGET
        : { Ref: `${owner[0]!.toUpperCase()}${owner.slice(1)}Target` };
    for (const row of callers) {
      const pathname = concrete(row.path);
      assert.deepEqual(
        destination(row.method, pathname),
        target(row.service),
        `${row.method} ${row.path}`,
      );
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
        const registered = callers.find(
          (r) => r.method === method && registeredPath(r.path, pathname),
        );
        assert.deepEqual(
          destination(method, pathname),
          registered ? target(registered.service) : null,
          `unintended method/path cross-product: ${method} ${row.path}`,
        );
      }
      assert.equal(destination(row.method, `${pathname}/unallocated`), null);
      assert.equal(destination(row.method, pathname, 'app.capiro.ai'), null);
      assert.equal(destination(row.method, pathname, 'arbitrary.invalid'), null);
    }
    for (const [prefix, owner] of [
      ['api', 'core'],
      ['strategy-api', 'strategy'],
      ['workspace-api', 'workspace'],
      ['intel-api', 'intel'],
    ]) {
      for (const method of ['GET', 'HEAD'])
        assert.deepEqual(destination(method, `/${prefix}/existing-read`), target(owner!));
      assert.equal(destination('POST', `/${prefix}/unallocated`), null);
    }
    assert.deepEqual(destination('POST', '/api/clio/tools/client_context.read'), target('core'));
    assert.deepEqual(destination('POST', '/api/clio/conversations/bootstrap'), target('core'));
    assert.deepEqual(
      destination('GET', '/api/engagement/meeting-commands/11111111-1111-4111-8111-111111111111'),
      target('core'),
    );
    assert.deepEqual(
      destination(
        'GET',
        '/api/business-development/prospects/11111111-1111-4111-8111-111111111111/contacts/transfers/22222222-2222-4222-8222-222222222222',
      ),
      target('core'),
    );
    assert.equal(destination('POST', '/api/clio/application-authority/history-release'), null);
    assert.deepEqual(
      destination(
        'GET',
        '/workspace-api/prospects/11111111-1111-4111-8111-111111111111/clients/22222222-2222-4222-8222-222222222222/brief-copies/33333333-3333-4333-8333-333333333333',
      ),
      target('workspace'),
    );
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
