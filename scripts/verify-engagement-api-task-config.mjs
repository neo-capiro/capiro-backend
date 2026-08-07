#!/usr/bin/env node
/**
 * Phase 2 task-definition verifier.
 *
 * The accepted verifier is retained verbatim under scripts/lib and receives a
 * synthetic, in-memory Clerk-webhook binding only for backward-compatible
 * validation. The real rendered task must omit that secret; this wrapper proves
 * the omission first, then applies the stronger rolling-deployment DB budget.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY = path.join(ROOT, 'scripts/lib/verify-engagement-api-task-config-legacy.mjs');
const RETIRED_SECRET = 'CLERK_WEBHOOK_SIGNING_SECRET';

function usage(message) {
  console.error(`ERROR ${message}`);
  console.error(
    'Usage: verify-engagement-api-task-config.mjs (--template <f> | --task-definition <f>) --config <f>',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) usage(`unexpected argument: ${arg}`);
    const [raw, inline] = arg.slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
    const value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) usage(`missing value for --${raw}`);
    out[key] = value;
  }
  return out;
}

function taskContainer(document, kind) {
  if (kind === 'template') {
    const tasks = Object.values(document.Resources ?? {}).filter(
      (resource) => resource.Type === 'AWS::ECS::TaskDefinition',
    );
    if (tasks.length !== 1) usage(`expected exactly one task definition, found ${tasks.length}`);
    const containers = tasks[0].Properties?.ContainerDefinitions ?? [];
    if (containers.length !== 1) usage(`expected exactly one container, found ${containers.length}`);
    return containers[0];
  }
  const task = document.taskDefinition ?? document;
  const containers = task.containerDefinitions ?? [];
  if (containers.length !== 1) usage(`expected exactly one container, found ${containers.length}`);
  return containers[0];
}

const args = parseArgs(process.argv.slice(2));
if (!args.config) usage('--config is required');
const inputKind = args.template ? 'template' : args.taskDefinition ? 'task-definition' : null;
if (!inputKind) usage('pass either --template or --task-definition');
if (args.template && args.taskDefinition) usage('pass only one of --template or --task-definition');

const sourcePath = args.template ?? args.taskDefinition;
const cfg = JSON.parse(readFileSync(args.config, 'utf8'));
const original = JSON.parse(readFileSync(sourcePath, 'utf8'));
const originalContainer = taskContainer(original, inputKind);
const originalSecrets = inputKind === 'template' ? originalContainer.Secrets ?? [] : originalContainer.secrets ?? [];
const originalNames = originalSecrets.map((entry) => entry.Name ?? entry.name);
if (originalNames.includes(RETIRED_SECRET)) {
  console.error(`FAIL  ${RETIRED_SECRET} is injected into the real dark task`);
  process.exit(2);
}

// Feed the accepted verifier a compatibility-only copy. No generated template,
// task definition, IAM policy, or deployed resource receives this entry.
const compatibility = structuredClone(original);
const compatibilityContainer = taskContainer(compatibility, inputKind);
if (inputKind === 'template') {
  compatibilityContainer.Secrets = [
    ...(compatibilityContainer.Secrets ?? []),
    { Name: RETIRED_SECRET, ValueFrom: cfg.clerkWebhookSigningSecretArn },
  ];
} else {
  compatibilityContainer.secrets = [
    ...(compatibilityContainer.secrets ?? []),
    { name: RETIRED_SECRET, valueFrom: cfg.clerkWebhookSigningSecretArn },
  ];
}

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'engagement-task-config-'));
const compatibilityPath = path.join(tempDir, `${inputKind}.json`);
writeFileSync(compatibilityPath, `${JSON.stringify(compatibility)}\n`);
try {
  const legacyArgs = [
    LEGACY,
    inputKind === 'template' ? '--template' : '--task-definition',
    compatibilityPath,
    '--config',
    args.config,
  ];
  const legacy = spawnSync(process.execPath, legacyArgs, { stdio: 'inherit' });
  if (legacy.error) throw legacy.error;
  if ((legacy.status ?? 1) !== 0) process.exit(legacy.status ?? 2);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const budget = cfg.dbConnectionBudget;
if (!budget) {
  console.error('FAIL  dbConnectionBudget is absent from the config');
  process.exit(2);
}
const deploymentTaskCeiling = Math.ceil(cfg.maximumCount * 2); // ECS maxHealthyPercent=200
const projected =
  budget.observedSevenDayPeak + deploymentTaskCeiling * budget.perTaskPoolMaximum;
const safeCeiling = Math.floor(budget.databaseMaxConnections * 0.8);
const headroom = budget.databaseMaxConnections - projected;
const requiredHeadroom = budget.databaseMaxConnections * 0.1;
const failures = [];
if (projected > safeCeiling) {
  failures.push(
    `deployment-surge projected peak ${projected} exceeds safe ceiling ${safeCeiling} ` +
      `(tasks=${deploymentTaskCeiling})`,
  );
}
if (headroom < requiredHeadroom) {
  failures.push(
    `deployment-surge headroom ${headroom} is below required ${requiredHeadroom} ` +
      `(tasks=${deploymentTaskCeiling})`,
  );
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  console.error(`\nENGAGEMENT_API_TASK_CONFIG_FAILED (${failures.length} violation(s))`);
  process.exit(2);
}

console.log(`Real task secrets: ${originalNames.length}; ${RETIRED_SECRET} omitted`);
console.log(`Deployment task ceiling: ${deploymentTaskCeiling}; projected DB peak: ${projected}`);
console.log('ENGAGEMENT_API_TASK_CONFIG_HARDENED_VERIFIED');
