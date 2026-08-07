#!/usr/bin/env node
/**
 * Tests for the Phase 2 template safety verifier.
 *
 * Every negative control mutates a copy of a REAL synthesized template, so a
 * control can only pass because the verifier caught the mutation — not because
 * a hand-written fixture happened to be malformed.
 *
 * Run: node scripts/verify-engagement-phase2-template.spec.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFIER = path.join(ROOT, 'scripts', 'verify-engagement-phase2-template.mjs');
const FIXTURES = path.join(ROOT, 'scripts', 'fixtures', 'engagement-phase2-template');

const templatePath = (name) => path.join(FIXTURES, `${name}.template.json`);
const load = (name) => JSON.parse(readFileSync(templatePath(name), 'utf8'));

function run(files) {
  try {
    return { status: 0, out: execFileSync('node', [VERIFIER, ...files], { encoding: 'utf8' }) };
  } catch (error) {
    return {
      status: error.status ?? 1,
      out: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
}

/** Write a mutated copy of a real template and verify it. */
function mutated(name, mutate) {
  const template = load(name);
  mutate(template, findTask(template), findContainer(template));
  const dir = mkdtempSync(path.join(tmpdir(), 'eng-tpl-'));
  const file = path.join(dir, `${name}.template.json`);
  writeFileSync(file, JSON.stringify(template, null, 2));
  return run([file]);
}

function findTask(template) {
  return Object.values(template.Resources).find((r) => r.Type === 'AWS::ECS::TaskDefinition');
}
function findContainer(template) {
  return findTask(template)?.Properties?.ContainerDefinitions?.[0];
}
function envOf(container) {
  return container.Environment;
}
function setEnv(container, name, value) {
  const entry = envOf(container).find((e) => e.Name === name);
  if (entry) entry.Value = value;
  else envOf(container).push({ Name: name, Value: value });
}

// ─────────────────────────────────────────────────────────────── baseline

test('the real synthesized templates are safe', () => {
  const result = run([templatePath('registry'), templatePath('network'), templatePath('service')]);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /ENGAGEMENT_PHASE2_TEMPLATE_SAFE/);
  assert.match(result.out, /Templates checked: 3/);
});

test('usage error when no template is passed', () => {
  const result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.out, /usage/);
});

// ────────────────────────────────────────── negative controls (fixture mutations)

test('NC-1 a path-only Engagement listener rule in CDK is rejected', () => {
  const result = mutated('network', (template) => {
    template.Resources.RoguePreviewRule = {
      Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
      Properties: {
        Priority: 6,
        Conditions: [{ Field: 'path-pattern', Values: ['/api/engagement/*'] }],
      },
    };
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /creates AWS::ElasticLoadBalancingV2::ListenerRule/);
});

test('NC-2 an armed external-action posture is rejected', () => {
  const result = mutated('service', (_t, _task, container) => {
    setEnv(container, 'ENGAGEMENT_EXTERNAL_ACTIONS', 'enabled');
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /ENGAGEMENT_EXTERNAL_ACTIONS="enabled"/);
});

test('NC-3 an OUTREACH_V3_ENABLED flag is rejected', () => {
  const result = mutated('service', (_t, _task, container) => {
    setEnv(container, 'OUTREACH_V3_ENABLED', 'true');
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /OUTREACH_V3_ENABLED.*claims Outreach V3 is available/);
});

test('NC-4 LangGraph and Campaign Spec variables are rejected', () => {
  for (const name of ['LANGGRAPH_ENDPOINT', 'CAMPAIGN_SPEC_TABLE', 'VITE_API_URL']) {
    const result = mutated('service', (_t, _task, container) => setEnv(container, name, 'x'));
    assert.equal(result.status, 2, `${name} was not rejected`);
    assert.match(result.out, new RegExp(name));
  }
});

test('NC-5 a campaign prompt stored in the environment is rejected', () => {
  const result = mutated('service', (_t, _task, container) => {
    setEnv(container, 'DEFAULT_CAMPAIGN_PROMPT', 'Write a warm follow-up to the committee');
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /campaign prompt/);
});

test('NC-6 a recipient email in the environment is rejected', () => {
  const result = mutated('service', (_t, _task, container) => {
    setEnv(container, 'FALLBACK_CONTACT', 'priya.anand@mail.house.gov');
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /an email address|recipient data/);
});

test('NC-7 a mutable image tag is rejected', () => {
  const result = mutated('service', (_t, _task, container) => {
    container.Image = 'capiro/dev/engagement-api:latest';
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /not pinned to an image digest/);
  assert.match(result.out, /mutable latest tag/);
});

test('NC-8 a mutable ECR repository is rejected', () => {
  const result = mutated('registry', (template) => {
    const repository = Object.values(template.Resources).find(
      (r) => r.Type === 'AWS::ECR::Repository',
    );
    repository.Properties.ImageTagMutability = 'MUTABLE';
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /is MUTABLE, expected IMMUTABLE/);
});

test('NC-9 a Delete removal policy on retained data is rejected', () => {
  const result = mutated('registry', (template) => {
    const id = Object.keys(template.Resources).find(
      (k) => template.Resources[k].Type === 'AWS::ECR::Repository',
    );
    template.Resources[id].DeletionPolicy = 'Delete';
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /DeletionPolicy Delete, expected Retain/);
});

test('NC-10 a public IP is rejected', () => {
  const result = mutated('service', (template) => {
    const service = Object.values(template.Resources).find((r) => r.Type === 'AWS::ECS::Service');
    service.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp = 'ENABLED';
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /does not disable public IP/);
});

test('NC-11 enabling ECS Exec is rejected', () => {
  const result = mutated('service', (template) => {
    const service = Object.values(template.Resources).find((r) => r.Type === 'AWS::ECS::Service');
    service.Properties.EnableExecuteCommand = true;
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /enables ECS Exec/);
});

test('NC-12 a migration command is rejected', () => {
  const result = mutated('service', (_t, _task, container) => {
    container.Command = ['migrate'];
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /overrides the serve-only command/);
  assert.match(result.out, /runs a migration command/);
});

test('NC-13 a writable root filesystem is rejected', () => {
  const result = mutated('service', (_t, _task, container) => {
    container.ReadonlyRootFilesystem = false;
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /read-only root filesystem/);
});

test('NC-14 a removed temp mount is rejected', () => {
  const result = mutated('service', (_t, _task, container) => {
    container.MountPoints = container.MountPoints.filter((m) => m.ContainerPath !== '/app/tmp');
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /no writable mount at \/app\/tmp/);
});

test('NC-15 x86 architecture is rejected', () => {
  const result = mutated('service', (_t, task) => {
    task.Properties.RuntimePlatform.CpuArchitecture = 'X86_64';
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /X86_64, expected ARM64/);
});

test('NC-16 wildcard IAM is rejected', () => {
  const result = mutated('service', (template) => {
    template.Resources.RoguePolicy = {
      Type: 'AWS::IAM::Policy',
      Properties: {
        PolicyDocument: {
          Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }],
        },
      },
    };
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /allows s3:\*/);
  assert.match(result.out, /Resource "\*"/);
});

test('NC-17 a send permission is rejected', () => {
  const result = mutated('service', (template) => {
    template.Resources.RogueSendPolicy = {
      Type: 'AWS::IAM::Policy',
      Properties: {
        PolicyDocument: {
          Statement: [
            { Effect: 'Allow', Action: 'ses:SendEmail', Resource: 'arn:aws:ses:::identity/x' },
          ],
        },
      },
    };
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /allows a send action ses:SendEmail/);
});

test('NC-18 a historical Compute stack reference is rejected', () => {
  const result = mutated('service', (template) => {
    template.Resources.RogueImport = {
      Type: 'AWS::CloudFormation::CustomResource',
      Properties: { ServiceToken: { 'Fn::ImportValue': 'Capiro-dev-Compute:AlbArn' } },
    };
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /historical Compute stack/);
});

test('NC-19 creating a live resource type is rejected', () => {
  const result = mutated('network', (template) => {
    template.Resources.RogueSecurityGroupIngress = {
      Type: 'AWS::EC2::SecurityGroupIngress',
      Properties: { FromPort: 4500, ToPort: 4500 },
    };
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /creates AWS::EC2::SecurityGroupIngress/);
});

test('NC-20 a bundled UI asset is rejected', () => {
  const result = mutated('service', (_t, _task, container) => {
    setEnv(container, 'PROTOTYPE_HTML', '<!DOCTYPE html><html><body>Outreach</body></html>');
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /UI asset content/);
});

test('NC-21 a missing UI provenance hash is rejected', () => {
  const result = mutated('service', (_t, _task, container) => {
    container.Environment = envOf(container).filter(
      (e) => e.Name !== 'OUTREACH_V3_PROTOTYPE_SHA256',
    );
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /missing the OUTREACH_V3_PROTOTYPE_SHA256 provenance value/);
});

test('NC-22 a non-hash UI provenance value is rejected', () => {
  const result = mutated('service', (_t, _task, container) => {
    setEnv(container, 'OUTREACH_V3_UI_CONTRACT_SHA256', 'not-a-hash');
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /is not a 64-hex hash/);
});

test('NC-23 a removed circuit breaker is rejected', () => {
  const result = mutated('service', (template) => {
    const service = Object.values(template.Resources).find((r) => r.Type === 'AWS::ECS::Service');
    delete service.Properties.DeploymentConfiguration.DeploymentCircuitBreaker;
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /no deployment circuit breaker/);
});

test('NC-24 a missing CLERK_JWT_ISSUER is rejected', () => {
  // Found missing from the initial Phase 2 build by independent review
  // (2.14): engagement-api boots the identical ConfigModule validator as the
  // main API and fatally crash-loops without this. No prior gate caught it,
  // because every other check only ever asserted what WAS present.
  const result = mutated('service', (_t, _task, container) => {
    container.Environment = envOf(container).filter((e) => e.Name !== 'CLERK_JWT_ISSUER');
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /has no CLERK_JWT_ISSUER; the task will crash-loop at boot/);
});

test('NC-25 a KMS key unrelated to the log group is still rejected', () => {
  // The LogsKey exception (Gate C, 2026-08-06) is scoped to the exact key CDK
  // names for the log group, not KMS::Key in general — any other key some
  // future construct might create still fails closed exactly as before.
  const result = mutated('service', (template) => {
    template.Resources.RogueDataKey = {
      Type: 'AWS::KMS::Key',
      Properties: { Description: 'not the log group key' },
    };
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /creates AWS::KMS::Key \(RogueDataKey\); live resources must be imported/);
});

test('NC-26 a second log-group-named KMS key is still rejected', () => {
  const result = mutated('service', (template) => {
    template.Resources.LogsKeyDuplicateB00 = {
      Type: 'AWS::KMS::Key',
      Properties: { Description: 'a second one' },
    };
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /creates 2 AWS::KMS::Key resources; only the log-group key is allowed/);
});

// ───────────────────────────────────────────────────────────── not vacuous

test('the verifier reports the exact number of violations', () => {
  const result = mutated('service', (_t, _task, container) => {
    setEnv(container, 'ENGAGEMENT_EXTERNAL_ACTIONS', 'enabled');
    setEnv(container, 'ENGAGEMENT_CALLBACKS_ENABLED', 'true');
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /ENGAGEMENT_PHASE2_TEMPLATE_UNSAFE \(2 violation\(s\)\)/);
});

test('an unmutated copy of each template still passes', () => {
  for (const name of ['registry', 'network', 'service']) {
    const result = mutated(name, () => {});
    assert.equal(result.status, 0, `${name} failed unmutated: ${result.out}`);
  }
});
