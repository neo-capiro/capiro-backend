#!/usr/bin/env node
/**
 * Deploy only the additive MeriV2 operations stacks with both schedules disabled.
 *
 * MUTATES AWS. It never synthesizes or deploys Compute, Data, DNS, Network,
 * Secrets, Assets, or the legacy Alarms stack. Existing resources are imported
 * from the read-only context document. The exact API release-SHA tag is resolved
 * to an immutable ECR digest before CDK synthesis, and both EventBridge rules are
 * verified DISABLED after deployment.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveAwsCli } from './lib/resolve-aws-cli.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parse(process.argv.slice(2));
const sha = required('sha');
if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('--sha must be an exact 40-character SHA.');
const contextPath = path.resolve(ROOT, required('context'));
const profile = args.profile ?? 'capiro-dev';
const region = args.region ?? 'us-east-1';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const aws = resolveAwsCli();
const evidenceDir = path.resolve(ROOT, args.evidenceDir ?? `.deploy-logs/meriv2-operations/${sha}`);

async function main() {
  const document = JSON.parse(await readFile(contextPath, 'utf8'));
  const contexts = document.contexts;
  validateContexts(contexts);
  const expected = `DEPLOY_CAPIRO_${String(contexts.env).toUpperCase()}_OPERATIONS_DARK`;
  if (required('confirm') !== expected) throw new Error(`--confirm must equal ${expected}.`);

  const identity = await awsJson(['sts', 'get-caller-identity']);
  if (String(identity.Account ?? '') !== String(contexts.account)) {
    throw new Error('AWS caller account does not match the collected operations context.');
  }
  const apiImageDigest = await imageDigest(String(contexts.existingApiRepositoryName), sha);
  await mkdir(evidenceDir, { recursive: true });

  const cdkContexts = {
    ...contexts,
    releaseSha: sha,
    meriv2ApiImageDigest: apiImageDigest,
    enableMemoryProjectionWorker: 'false',
    enableMeriV2ControlMonitor: 'false',
  };
  const contextArgs = Object.entries(cdkContexts).flatMap(([key, value]) => [
    '--context',
    `${key}=${String(value)}`,
  ]);
  const envName = String(contexts.env);
  const stacks = [`Capiro-${envName}-MemoryProjectionWorker`, `Capiro-${envName}-MeriV2Control`];
  const app = 'ts-node --prefer-ts-exts bin/meriv2-operations.ts';
  const commandArgs = [
    'exec',
    'cdk',
    'deploy',
    '--app',
    app,
    ...stacks,
    ...contextArgs,
    '--profile',
    profile,
    '--require-approval',
    'never',
    '--outputs-file',
    path.join(evidenceDir, 'cdk-outputs.json'),
  ];
  const { stdout, stderr } = await execFileAsync(pnpm, commandArgs, {
    cwd: path.join(ROOT, 'infra/cdk'),
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  await writeFile(path.join(evidenceDir, 'cdk-deploy.log'), `${stdout}${stderr}`, 'utf8');
  if (stdout?.trim()) process.stdout.write(stdout);
  if (stderr?.trim()) process.stderr.write(stderr);

  const worker = await describeRule(`capiro-${envName}-memory-projection-worker`);
  const monitor = await describeRule(`capiro-${envName}-meriv2-control-monitor`);
  if (worker.State !== 'DISABLED' || monitor.State !== 'DISABLED') {
    throw new Error(
      `Operations deployment was not dark: worker=${worker.State} monitor=${monitor.State}.`,
    );
  }
  const summary = {
    marker: 'MERIV2_OPERATIONS_DARK_DEPLOY_COMPLETE',
    completedAt: new Date().toISOString(),
    sha,
    apiImageDigest,
    account: contexts.account,
    region,
    profile,
    stacks,
    workerRule: { name: worker.Name, state: worker.State },
    controlMonitorRule: { name: monitor.Name, state: monitor.State },
    productFeatureActivationAttempted: false,
    backfillExecuted: false,
  };
  await writeFile(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
}

async function imageDigest(repository, imageTag) {
  const response = await awsJson([
    'ecr',
    'describe-images',
    '--repository-name',
    repository,
    '--image-ids',
    `imageTag=${imageTag}`,
  ]);
  const digest = response.imageDetails?.[0]?.imageDigest;
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(digest ?? ''))) {
    throw new Error(`No immutable digest resolved for ${repository}:${imageTag}.`);
  }
  return digest;
}

async function describeRule(name) {
  return awsJson(['events', 'describe-rule', '--name', name]);
}

function validateContexts(contexts) {
  const requiredKeys = [
    'account',
    'region',
    'env',
    'existingClusterArn',
    'existingApiRepositoryName',
    'existingPrivateSubnetIds',
    'existingServiceSecurityGroupId',
    'existingDbSecretArn',
    'existingAppDbSecretArn',
    'existingDatabaseName',
    'existingDataKeyArn',
    'existingSecretsKeyArn',
    'existingAlertsTopicArn',
  ];
  if (!contexts || typeof contexts !== 'object') {
    throw new Error('Operations context document has no contexts object.');
  }
  for (const key of requiredKeys) {
    if (!String(contexts[key] ?? '').trim())
      throw new Error(`Operations context is missing ${key}.`);
  }
  if (String(contexts.region) !== region) {
    throw new Error(`--region ${region} does not match context region ${contexts.region}.`);
  }
}

async function awsJson(commandArgs) {
  const { stdout, stderr } = await execFileAsync(
    aws,
    [...commandArgs, '--region', region, '--profile', profile, '--output', 'json'],
    { cwd: ROOT, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  if (stderr?.trim()) process.stderr.write(stderr);
  return JSON.parse(stdout || '{}');
}

function required(name) {
  const value = args[name];
  if (!value) throw new Error(`--${name} is required.`);
  return String(value);
}

function parse(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [raw, inline] = arg.slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = inline ?? values[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${raw}`);
    parsed[key] = value;
  }
  return parsed;
}

main().catch(async (error) => {
  const payload = {
    marker: 'MERIV2_OPERATIONS_DARK_DEPLOY_FAILED',
    failedAt: new Date().toISOString(),
    sha,
    error: error instanceof Error ? error.message : String(error),
    productFeatureActivationAttempted: false,
  };
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  await writeFile(
    path.join(evidenceDir, 'failure.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
  ).catch(() => undefined);
  console.error(JSON.stringify(payload));
  process.exitCode = 1;
});
