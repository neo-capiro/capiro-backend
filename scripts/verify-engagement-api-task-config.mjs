#!/usr/bin/env node
/**
 * Verify a rendered engagement-api task definition against the accepted
 * Phase 1 configuration contract.
 *
 * Works on a synthesized CloudFormation template (before deploy) or on the
 * output of `aws ecs describe-task-definition` (after deploy), so the same
 * gate covers both sides of Gate C.
 *
 * Evidence lists secret NAMES and FIELDS. It never reads or prints a value.
 *
 * Usage:
 *   node scripts/verify-engagement-api-task-config.mjs \
 *     --template <synthesized-service-template.json> \
 *     --config   <engagement-api-config.json>
 *
 *   node scripts/verify-engagement-api-task-config.mjs \
 *     --task-definition <describe-task-definition.json> \
 *     --config <engagement-api-config.json>
 *
 * Exit: 0 contract satisfied · 1 usage error · 2 one or more violations
 */
import { readFileSync } from 'node:fs';

const REQUIRED_SECRETS = [
  'CLERK_SECRET_KEY',
  'CLERK_WEBHOOK_SIGNING_SECRET',
  'DB_HOST',
  'DB_NAME',
  'DB_PASSWORD',
  'DB_PORT',
  'DB_USER',
  'NOTES_ENCRYPTION_KEY',
  'OAUTH_TOKEN_ENCRYPTION_KEY',
];

const FORBIDDEN_SECRETS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'RECALL_API_KEY',
  'RECALL_WEBHOOK_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CERT_PRIVATE_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'SAM_GOV_API_KEY',
  'AI_CREDENTIAL_ENCRYPTION_KEY',
];

const EXACT_SHADOW_ENV = {
  CAPIRO_SERVICE_NAME: 'engagement-api',
  ENGAGEMENT_PROCESS_MODE: 'shadow',
  ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
  ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
  ENGAGEMENT_CALLBACKS_ENABLED: 'false',
  ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
};

const FORBIDDEN_ENV_PATTERNS = [/^OUTREACH_V3_ENABLED$/, /^VITE_/, /^LANGGRAPH_/, /^CAMPAIGN_SPEC_/];

/** Env names that must never carry a literal value. */
const SECRET_SHAPED_ENV = /SECRET|PASSWORD|PRIVATE_KEY|API_KEY|_TOKEN$|CREDENTIAL/i;

const failures = [];
const fail = (message) => failures.push(message);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) usage(`unexpected argument: ${arg}`);
    const [raw, inline] = arg.slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    const value = inline ?? argv[++i];
    if (!value || value.startsWith('--')) usage(`missing value for --${raw}`);
    out[key] = value;
  }
  return out;
}

function usage(message) {
  console.error(`ERROR ${message}`);
  console.error(
    'Usage: verify-engagement-api-task-config.mjs (--template <f> | --task-definition <f>) --config <f>',
  );
  process.exit(1);
}

/** Normalize either input shape into { environment, secrets, container, task }. */
function extract(args) {
  if (args.template) {
    const template = JSON.parse(readFileSync(args.template, 'utf8'));
    const tasks = Object.values(template.Resources ?? {}).filter(
      (r) => r.Type === 'AWS::ECS::TaskDefinition',
    );
    if (tasks.length !== 1) usage(`expected exactly one task definition, found ${tasks.length}`);
    const properties = tasks[0].Properties ?? {};
    const containers = properties.ContainerDefinitions ?? [];
    if (containers.length !== 1) usage(`expected exactly one container, found ${containers.length}`);
    return {
      task: properties,
      container: containers[0],
      environment: Object.fromEntries(
        (containers[0].Environment ?? []).map((e) => [e.Name, e.Value]),
      ),
      secrets: Object.fromEntries(
        (containers[0].Secrets ?? []).map((s) => [s.Name, JSON.stringify(s.ValueFrom)]),
      ),
      source: 'template',
    };
  }
  if (args.taskDefinition) {
    const parsed = JSON.parse(readFileSync(args.taskDefinition, 'utf8'));
    const properties = parsed.taskDefinition ?? parsed;
    const containers = properties.containerDefinitions ?? [];
    if (containers.length !== 1) usage(`expected exactly one container, found ${containers.length}`);
    return {
      task: {
        Cpu: String(properties.cpu ?? ''),
        Memory: String(properties.memory ?? ''),
        Family: properties.family,
        RuntimePlatform: {
          CpuArchitecture: properties.runtimePlatform?.cpuArchitecture,
          OperatingSystemFamily: properties.runtimePlatform?.operatingSystemFamily,
        },
      },
      container: {
        Image: containers[0].image,
        ReadonlyRootFilesystem: containers[0].readonlyRootFilesystem,
        PortMappings: (containers[0].portMappings ?? []).map((p) => ({
          ContainerPort: p.containerPort,
        })),
        Command: containers[0].command,
        EntryPoint: containers[0].entryPoint,
        MountPoints: (containers[0].mountPoints ?? []).map((m) => ({
          ContainerPath: m.containerPath,
          ReadOnly: m.readOnly,
        })),
      },
      environment: Object.fromEntries(
        (containers[0].environment ?? []).map((e) => [e.name, e.value]),
      ),
      secrets: Object.fromEntries(
        (containers[0].secrets ?? []).map((s) => [s.name, s.valueFrom]),
      ),
      source: 'task-definition',
    };
  }
  return usage('pass either --template or --task-definition');
}

const args = parseArgs(process.argv.slice(2));
if (!args.config) usage('--config is required');
const cfg = JSON.parse(readFileSync(args.config, 'utf8'));
const rendered = extract(args);
const { environment, secrets, container, task } = rendered;

// ── shadow posture ───────────────────────────────────────────────────────────
for (const [name, expected] of Object.entries(EXACT_SHADOW_ENV)) {
  if (environment[name] !== expected) {
    fail(`shadow variable ${name} is "${environment[name]}", expected "${expected}"`);
  }
}
if (environment.ENGAGEMENT_CALLBACKS_ENABLED !== 'false') fail('callbacks are enabled');
if (environment.ENGAGEMENT_RECALL_WEBHOOK_ENABLED !== 'false') fail('the Recall webhook is enabled');

for (const name of Object.keys(environment)) {
  for (const pattern of FORBIDDEN_ENV_PATTERNS) {
    if (pattern.test(name)) fail(`forbidden environment variable ${name}`);
  }
}

// ── no plaintext secrets ─────────────────────────────────────────────────────
for (const [name, value] of Object.entries(environment)) {
  if (SECRET_SHAPED_ENV.test(name)) {
    fail(`secret-shaped variable ${name} is a plaintext environment value`);
  }
  if (typeof value === 'string' && /^(sk|pk)_(live|test)_/.test(value)) {
    fail(`environment variable ${name} carries a provider key literal`);
  }
  if (typeof value === 'string' && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
    fail(`environment variable ${name} carries a private key literal`);
  }
}

// ── secrets ──────────────────────────────────────────────────────────────────
const injected = Object.keys(secrets).sort();
for (const name of REQUIRED_SECRETS) {
  if (!injected.includes(name)) fail(`required boot secret ${name} is missing`);
}
for (const name of FORBIDDEN_SECRETS) {
  if (injected.includes(name)) fail(`nonrequired provider secret ${name} is injected`);
}
for (const name of injected) {
  if (!REQUIRED_SECRETS.includes(name)) fail(`unexpected secret ${name} is injected`);
}

// Whole-JSON injection has no field selector after the secret ARN.
for (const [name, valueFrom] of Object.entries(secrets)) {
  const rendering = String(valueFrom);
  const looksFieldScoped = /:[A-Za-z_][A-Za-z0-9_]*::?"?\s*$|:[A-Za-z_][A-Za-z0-9_]*::/.test(
    rendering,
  );
  if (!looksFieldScoped) {
    fail(`secret ${name} appears to inject a whole JSON document rather than one field`);
  }
}

// ── secret ARNs belong to the configured account and region ──────────────────
const arnPattern = /arn:aws:secretsmanager:([a-z0-9-]+):(\d{12}):/g;
const renderedSecrets = JSON.stringify(secrets);
for (const [, region, account] of renderedSecrets.matchAll(arnPattern)) {
  if (region !== cfg.region) fail(`a secret ARN is in region ${region}, expected ${cfg.region}`);
  if (account !== cfg.accountId) {
    fail(`a secret ARN belongs to account ${account}, expected ${cfg.accountId}`);
  }
}

// ── image, sizing and port ───────────────────────────────────────────────────
const image = JSON.stringify(container.Image ?? '');
if (cfg.imageDigest && !image.includes(cfg.imageDigest)) {
  fail(`image does not use the configured digest ${cfg.imageDigest}`);
}
if (!/@sha256:/.test(image)) fail('image is not digest-pinned');
if (/:latest/.test(image)) fail('image uses a mutable latest tag');

if (cfg.releaseSha && environment.RELEASE_SHA !== cfg.releaseSha) {
  fail(`RELEASE_SHA is "${environment.RELEASE_SHA}", expected "${cfg.releaseSha}"`);
}
if (String(task.Cpu) !== String(cfg.cpu)) fail(`cpu is ${task.Cpu}, expected ${cfg.cpu}`);
if (String(task.Memory) !== String(cfg.memoryMiB)) {
  fail(`memory is ${task.Memory}, expected ${cfg.memoryMiB}`);
}
if (task.RuntimePlatform?.CpuArchitecture !== 'ARM64') {
  fail(`cpu architecture is ${task.RuntimePlatform?.CpuArchitecture}, expected ARM64`);
}

const ports = (container.PortMappings ?? []).map((p) => p.ContainerPort);
if (!ports.includes(4500)) fail(`container port 4500 is not exposed (found ${ports.join(', ')})`);
if (environment.ENGAGEMENT_API_PORT !== '4500') {
  fail(`ENGAGEMENT_API_PORT is "${environment.ENGAGEMENT_API_PORT}", expected "4500"`);
}

// ── serve-only ───────────────────────────────────────────────────────────────
if (container.Command) fail('the task overrides the image command; serve-only must not be bypassed');
if (container.EntryPoint) fail('the task overrides the image entrypoint');
if (/migrate|prisma|seed/i.test(JSON.stringify(container.Command ?? ''))) {
  fail('the task command references a migration');
}
if (container.ReadonlyRootFilesystem !== true) fail('the root filesystem is not read-only');

// ── database connection budget ───────────────────────────────────────────────
const budget = cfg.dbConnectionBudget;
if (!budget) {
  fail('the database pool budget cannot be inferred: dbConnectionBudget is absent from the config');
} else {
  const projected = budget.observedSevenDayPeak + cfg.maximumCount * budget.perTaskPoolMaximum;
  const ceiling = Math.floor(budget.databaseMaxConnections * 0.8);
  if (projected > ceiling) {
    fail(`projected peak ${projected} exceeds the safe ceiling ${ceiling}`);
  }
}

// ── report ───────────────────────────────────────────────────────────────────
console.log(`Source: ${rendered.source}`);
console.log(`Secrets injected (names and fields only, never values): ${injected.length}`);
for (const name of injected) console.log(`  ${name}`);
console.log(`Provider secrets deliberately omitted: ${FORBIDDEN_SECRETS.length}`);

if (failures.length > 0) {
  console.error('');
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  console.error(`\nENGAGEMENT_API_TASK_CONFIG_FAILED (${failures.length} violation(s))`);
  process.exit(2);
}
console.log('\nENGAGEMENT_API_TASK_CONFIG_VERIFIED');
