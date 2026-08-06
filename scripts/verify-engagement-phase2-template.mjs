#!/usr/bin/env node
/**
 * Phase 2 template safety verifier.
 *
 * Makes the infrastructure safety rules mechanically enforceable: a dangerous
 * synthesized template cannot pass CI, whatever the CDK code looks like.
 *
 * This runs on the SYNTHESIZED output rather than the source, so a rule cannot
 * be satisfied by a comment or a helper name. Every check reads CloudFormation.
 *
 * Usage:
 *   node scripts/verify-engagement-phase2-template.mjs <template.json> [...]
 *
 * Exit: 0 all templates safe · 1 usage error · 2 one or more violations
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Resource types no Phase 2 stack may CREATE. Everything live is imported. */
const FORBIDDEN_RESOURCE_TYPES = [
  'AWS::EC2::VPC',
  'AWS::EC2::Subnet',
  'AWS::EC2::NatGateway',
  'AWS::EC2::InternetGateway',
  'AWS::EC2::RouteTable',
  'AWS::EC2::SecurityGroup',
  'AWS::EC2::SecurityGroupIngress',
  'AWS::EC2::SecurityGroupEgress',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::ElasticLoadBalancingV2::Listener',
  'AWS::ElasticLoadBalancingV2::ListenerRule',
  'AWS::ElasticLoadBalancingV2::ListenerCertificate',
  'AWS::Route53::RecordSet',
  'AWS::Route53::HostedZone',
  'AWS::CertificateManager::Certificate',
  'AWS::RDS::DBCluster',
  'AWS::RDS::DBInstance',
  'AWS::ECS::Cluster',
  'AWS::KMS::Key',
  'AWS::SecretsManager::Secret',
];

const EXACT_SHADOW_ENV = {
  CAPIRO_SERVICE_NAME: 'engagement-api',
  ENGAGEMENT_PROCESS_MODE: 'shadow',
  ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
  ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
  ENGAGEMENT_CALLBACKS_ENABLED: 'false',
  ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
};

const FORBIDDEN_ENV_PATTERNS = [
  { pattern: /^OUTREACH_V3_ENABLED$/, why: 'claims Outreach V3 is available' },
  { pattern: /^VITE_/, why: 'is a web build variable and has no place in an API task' },
  { pattern: /^LANGGRAPH_/, why: 'LangGraph is not part of Phase 2' },
  { pattern: /^CAMPAIGN_SPEC_/, why: 'Campaign Spec persistence is not part of Phase 2' },
];

/** Env values that would mean campaign content is baked into infrastructure. */
const CONTENT_SHAPED_ENV = [
  { pattern: /goal[_-]?text/i, why: 'goal text' },
  { pattern: /message[_-]?body/i, why: 'message body' },
  { pattern: /campaign[_-]?prompt/i, why: 'campaign prompt' },
  { pattern: /recipient/i, why: 'recipient data' },
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, why: 'an email address' },
];

/**
 * Actions that genuinely have no resource-level ARN in IAM. A wildcard resource
 * is tolerated only for these; anything else must name its resources.
 */
const WILDCARD_ALLOWLIST = [
  'ecr:GetAuthorizationToken',
  'logs:CreateLogGroup',
  'logs:CreateLogStream',
  'logs:PutLogEvents',
  'cloudwatch:PutMetricData',
  'xray:PutTraceSegments',
  'xray:PutTelemetryRecords',
];

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error('ERROR usage: verify-engagement-phase2-template.mjs <template.json> [...]');
  process.exit(1);
}

const failures = [];
let checked = 0;

for (const file of files) {
  const label = path.basename(file);
  const fail = (message) => failures.push(`${label}: ${message}`);

  let template;
  try {
    template = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`could not read template: ${error.message}`);
    continue;
  }
  checked += 1;

  const resources = template.Resources ?? {};
  const entries = Object.entries(resources);
  const rendered = JSON.stringify(template);
  const byType = (type) => entries.filter(([, r]) => r.Type === type).map(([id]) => id);

  // ── nothing live may be created ─────────────────────────────────────────
  for (const type of FORBIDDEN_RESOURCE_TYPES) {
    for (const id of byType(type)) fail(`creates ${type} (${id}); live resources must be imported`);
  }

  // ── no historical Compute stack coupling ────────────────────────────────
  if (/Capiro-[a-z]+-Compute/.test(rendered)) {
    fail('references the historical Compute stack, which is frozen and drifted');
  }

  // ── retained data ───────────────────────────────────────────────────────
  for (const [id, resource] of entries) {
    if (!['AWS::ECR::Repository', 'AWS::Logs::LogGroup'].includes(resource.Type)) continue;
    if (resource.DeletionPolicy !== 'Retain') {
      fail(`${resource.Type} (${id}) has DeletionPolicy ${resource.DeletionPolicy}, expected Retain`);
    }
  }

  // ── ECR immutability ────────────────────────────────────────────────────
  for (const id of byType('AWS::ECR::Repository')) {
    const properties = resources[id].Properties ?? {};
    if (properties.ImageTagMutability !== 'IMMUTABLE') {
      fail(`ECR repository ${id} is ${properties.ImageTagMutability}, expected IMMUTABLE`);
    }
    if (properties.EmptyOnDelete === true) fail(`ECR repository ${id} sets EmptyOnDelete`);
    if (properties.ImageScanningConfiguration?.ScanOnPush !== true) {
      fail(`ECR repository ${id} does not scan on push`);
    }
  }

  // ── ECS service posture ─────────────────────────────────────────────────
  for (const id of byType('AWS::ECS::Service')) {
    const properties = resources[id].Properties ?? {};
    const awsvpc = properties.NetworkConfiguration?.AwsvpcConfiguration ?? {};
    if (awsvpc.AssignPublicIp !== 'DISABLED') {
      fail(`ECS service ${id} does not disable public IP (${awsvpc.AssignPublicIp})`);
    }
    if (properties.EnableExecuteCommand === true) fail(`ECS service ${id} enables ECS Exec`);
    if (properties.DeploymentConfiguration?.DeploymentCircuitBreaker?.Enable !== true) {
      fail(`ECS service ${id} has no deployment circuit breaker`);
    }
  }

  // ── task definition posture ─────────────────────────────────────────────
  for (const id of byType('AWS::ECS::TaskDefinition')) {
    const properties = resources[id].Properties ?? {};
    if (properties.RuntimePlatform?.CpuArchitecture !== 'ARM64') {
      fail(`task ${id} is ${properties.RuntimePlatform?.CpuArchitecture}, expected ARM64`);
    }

    const volumes = (properties.Volumes ?? []).map((v) => v.Name);
    for (const container of properties.ContainerDefinitions ?? []) {
      const name = container.Name ?? id;

      if (container.ReadonlyRootFilesystem !== true) {
        fail(`container ${name} does not use a read-only root filesystem`);
      }
      if (container.Privileged === true) fail(`container ${name} is privileged`);

      const mounts = (container.MountPoints ?? []).map((m) => m.ContainerPath).sort();
      for (const required of ['/app/tmp', '/tmp']) {
        if (!mounts.includes(required)) {
          fail(`container ${name} has no writable mount at ${required}`);
        }
      }
      for (const mount of container.MountPoints ?? []) {
        if (!volumes.includes(mount.SourceVolume)) {
          fail(`container ${name} mounts undeclared volume ${mount.SourceVolume}`);
        }
      }

      const image = JSON.stringify(container.Image ?? '');
      if (!/@sha256:/.test(image)) fail(`container ${name} is not pinned to an image digest`);
      if (/:latest/.test(image)) fail(`container ${name} uses a mutable latest tag`);

      const command = JSON.stringify(container.Command ?? []);
      if (container.Command) fail(`container ${name} overrides the serve-only command`);
      if (/migrate|prisma|seed/i.test(command)) fail(`container ${name} runs a migration command`);
      if (container.EntryPoint) fail(`container ${name} overrides the image entrypoint`);

      const env = Object.fromEntries(
        (container.Environment ?? []).map((e) => [e.Name, e.Value]),
      );

      for (const [key, expected] of Object.entries(EXACT_SHADOW_ENV)) {
        if (env[key] !== expected) {
          fail(`container ${name} has ${key}="${env[key]}", expected "${expected}"`);
        }
      }
      for (const { pattern, why } of FORBIDDEN_ENV_PATTERNS) {
        for (const key of Object.keys(env)) {
          if (pattern.test(key)) fail(`container ${name} sets ${key}, which ${why}`);
        }
      }
      for (const [key, value] of Object.entries(env)) {
        for (const { pattern, why } of CONTENT_SHAPED_ENV) {
          if (pattern.test(String(key)) || pattern.test(String(value))) {
            fail(`container ${name} environment ${key} carries ${why}`);
          }
        }
      }

      // UI-aware provenance must be present and must be hashes, not content.
      for (const key of ['OUTREACH_V3_PROTOTYPE_SHA256', 'OUTREACH_V3_UI_CONTRACT_SHA256']) {
        if (!(key in env)) fail(`container ${name} is missing the ${key} provenance value`);
        else if (!/^[0-9a-f]{64}$/.test(String(env[key]))) {
          fail(`container ${name} ${key} is not a 64-hex hash`);
        }
      }

      // No prototype asset may be bundled into infrastructure.
      if (/<!DOCTYPE html|__bundler\/|<svg |text\/x-dc/i.test(JSON.stringify(container))) {
        fail(`container ${name} embeds UI asset content`);
      }
    }
  }

  // No UI asset anywhere in the template, not just in a container.
  if (/<!DOCTYPE html|__bundler\/|text\/x-dc/i.test(rendered)) {
    fail('template embeds Outreach V3 prototype or UI asset content');
  }

  // ── IAM least privilege ─────────────────────────────────────────────────
  for (const [id, resource] of entries) {
    if (!['AWS::IAM::Policy', 'AWS::IAM::Role'].includes(resource.Type)) continue;
    const properties = resource.Properties ?? {};
    const documents = [
      properties.PolicyDocument,
      ...(properties.Policies ?? []).map((p) => p.PolicyDocument),
    ].filter(Boolean);

    for (const document of documents) {
      for (const statement of document.Statement ?? []) {
        if (statement.Effect !== 'Allow') continue;
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];

        for (const action of actions) {
          if (typeof action !== 'string') continue;
          if (action === '*') fail(`IAM ${id} allows every action`);
          if (/^s3:(Put|Delete|Abort|Restore)/.test(action)) fail(`IAM ${id} allows ${action}`);
          if (/^s3:\*$/.test(action)) fail(`IAM ${id} allows s3:*`);
          if (/^ses:/i.test(action)) fail(`IAM ${id} allows a send action ${action}`);
          if (/^elasticloadbalancing:/i.test(action)) fail(`IAM ${id} allows routing mutation ${action}`);
          if (/^ecs:(Update|Create|Delete|Register)/i.test(action)) fail(`IAM ${id} allows ${action}`);
          if (/^iam:/i.test(action)) fail(`IAM ${id} allows ${action}`);
          if (/^secretsmanager:(Put|Update|Delete|Create)/i.test(action)) {
            fail(`IAM ${id} allows secret mutation ${action}`);
          }
          if (/^kms:(Encrypt|ReEncrypt|\*)/.test(action)) fail(`IAM ${id} allows ${action}`);
        }

        const resourceValue = JSON.stringify(statement.Resource);
        if (resourceValue === '"*"') {
          const offending = actions.filter(
            (a) => typeof a === 'string' && !WILDCARD_ALLOWLIST.includes(a),
          );
          if (offending.length > 0) {
            fail(`IAM ${id} uses Resource "*" for ${offending.join(', ')}`);
          }
        }
      }
    }
  }
}

// ── report ────────────────────────────────────────────────────────────────
console.log(`Templates checked: ${checked}`);
if (failures.length > 0) {
  console.error('');
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  console.error(`\nENGAGEMENT_PHASE2_TEMPLATE_UNSAFE (${failures.length} violation(s))`);
  process.exit(2);
}
console.log('ENGAGEMENT_PHASE2_TEMPLATE_SAFE');
