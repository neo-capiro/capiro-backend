#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import {
  NvidiaBatchCoordinator,
  evaluateBenchmark,
  loadSession5Config,
} from './session5.mjs';
import { createAwsRuntimePorts } from './aws-runtime.mjs';

function usage() {
  return `Usage:
  node src/cli.mjs validate-config
  node src/cli.mjs benchmark --corpus <file> --out <file>
  node src/cli.mjs plan --request <file> --out <file>
  node src/cli.mjs submit --plan <file> --out <file>
  node src/cli.mjs handle-event --event <file> --out <file>
  node src/cli.mjs zero-idle --out <file>

The CLI never exposes a public HTTP listener. AWS operations use the task role
through AWS CLI v2; no static NVIDIA or AWS credential is accepted as an argument.
`;
}

function argsMap(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    values[value.slice(2)] = argv[index + 1];
    index += 1;
  }
  return values;
}

async function readJson(path) {
  if (!path) throw new Error('Required JSON path is missing');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (path) await writeFile(path, text, 'utf8');
  else process.stdout.write(text);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = argsMap(rest);
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(usage());
    return;
  }

  if (command === 'validate-config') {
    const config = loadSession5Config();
    await writeJson(args.out, {
      valid: true,
      enabled: config.enabled,
      routingMode: config.routingMode,
      benchmarkAccepted: config.benchmarkAccepted,
      modelName: config.modelName,
      modelVersion: config.modelVersion,
      maxConcurrentGpuJobs: config.maxConcurrentGpuJobs,
      maxPagesPerJob: config.maxPagesPerJob,
      monthlyGpuBudgetUsd: config.monthlyGpuBudgetUsd,
      executionModel: 'sagemaker_batch_transform',
      persistentEndpoint: false,
    });
    return;
  }

  if (command === 'benchmark') {
    const corpus = await readJson(args.corpus);
    const result = evaluateBenchmark(corpus, {
      materialImprovementThreshold: Number(args['improvement-threshold'] ?? 0.05),
      maxCostPerThousandPages: Number(args['max-cost-per-thousand'] ?? Infinity),
    });
    await writeJson(args.out, result);
    if (args['enforce-live'] === 'true' && !result.liveBenchmarkAccepted) {
      process.exitCode = 2;
    }
    return;
  }

  const config = loadSession5Config();
  const ports = createAwsRuntimePorts(config);
  const coordinator = new NvidiaBatchCoordinator(ports, config);

  if (command === 'plan') {
    const request = await readJson(args.request);
    await writeJson(args.out, await coordinator.plan(request));
    return;
  }
  if (command === 'submit') {
    const plan = await readJson(args.plan);
    await writeJson(args.out, await coordinator.submit(plan));
    return;
  }
  if (command === 'handle-event') {
    const event = await readJson(args.event);
    await writeJson(args.out, await coordinator.handleProviderEvent(event));
    return;
  }
  if (command === 'zero-idle') {
    const proof = await coordinator.zeroIdleProof();
    await writeJson(args.out, proof);
    if (!proof.zeroIdleGpu) process.exitCode = 3;
    return;
  }

  throw new Error(`Unknown command ${command}`);
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      error: error?.name ?? 'Error',
      code: error?.code ?? 'SESSION5_CLI_FAILURE',
      message: error?.message ?? String(error),
      details: error?.details,
    })}\n`,
  );
  process.exitCode = 1;
});
