#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { evaluateBenchmark } from './session5.mjs';
import { validateLiveBenchmarkCorpus } from './real-batch.mjs';
import {
  ASYNC_EXECUTION_MODEL,
  ASYNC_INPUT_CONTENT_TYPE,
  ASYNC_OUTPUT_ACCEPT,
  AsyncNvidiaCoordinator,
  loadRealAsyncConfig,
} from './real-async.mjs';
import { createAwsRealAsyncPorts } from './aws-real-runtime.mjs';

function usage() {
  return `Usage:
  node src/cli.mjs validate-config [--out <file>]
  node src/cli.mjs benchmark --corpus <file> --out <file> [--enforce-live true]
  node src/cli.mjs async-submit --request <file> --out <file>
  node src/cli.mjs async-reconcile --job-id <id> --out <file>
  node src/cli.mjs async-watch --job-id <id> --interval-seconds 30 --max-seconds 3600 --out <file>
  node src/cli.mjs async-drain --job-id <id> --out <file>
  node src/cli.mjs async-zero-idle --out <file>

The active Session 5 execution model is SageMaker Asynchronous Inference.
caller provider facts are not accepted; reconciliation re-reads SageMaker and S3.
Batch Transform commands are intentionally unavailable because the pinned
Marketplace package resolves through ModelDataSource, which SageMaker Batch
Transform rejects. No caller-supplied provider facts are trusted.
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

  if (command === 'benchmark') {
    const corpus = await readJson(args.corpus);
    if (args['enforce-live'] === 'true') {
      validateLiveBenchmarkCorpus(corpus, { requireScorableGold: true });
    }
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

  const config = loadRealAsyncConfig();
  if (command === 'submit' || command === 'plan' || command === 'reconcile' || command === 'retry' || command === 'watch' || command === 'handle-event' || command === 'zero-idle') {
    throw new Error('ASYNC_MODE_REQUIRED: Batch Transform execution commands are disabled; use async-submit/async-reconcile/async-watch/async-drain/async-zero-idle');
  }
  if (command === 'validate-config') {
    await writeJson(args.out, {
      valid: true,
      enabled: config.enabled,
      routingMode: config.routingMode,
      benchmarkAccepted: config.benchmarkAccepted,
      modelName: config.modelName,
      modelVersion: config.modelVersion,
      modelPackageArn: config.modelPackageArn,
      maxConcurrentGpuJobs: config.maxConcurrentGpuJobs,
      maxEndpointLifetimeSeconds: config.maxEndpointLifetimeSeconds,
      initialBenchmarkCapUsd: config.initialBenchmarkCapUsd,
      hardIncrementalCapUsd: config.hardIncrementalCapUsd,
      effectiveSpendCapUsd: config.effectiveSpendCapUsd,
      extendedBudgetAuthorized: config.extendedBudgetAuthorized,
      executionModel: ASYNC_EXECUTION_MODEL,
      inputContentType: ASYNC_INPUT_CONTENT_TYPE,
      outputAccept: ASYNC_OUTPUT_ACCEPT,
      endpointScaleToZeroConfigured: true,
      endpointLifecycle: 'orchestrator_owned_create_and_delete',
      atomicReservationLedger: Boolean(config.ledgerTableName),
    });
    return;
  }

  const ports = createAwsRealAsyncPorts(config);
  const coordinator = new AsyncNvidiaCoordinator(ports, config);
  if (command === 'async-submit') {
    await writeJson(args.out, await coordinator.submit(await readJson(args.request)));
    return;
  }
  if (command === 'async-reconcile') {
    if (!args['job-id']) throw new Error('async-reconcile requires --job-id');
    await writeJson(args.out, await coordinator.reconcile(args['job-id']));
    return;
  }
  if (command === 'async-drain') {
    if (!args['job-id']) throw new Error('async-drain requires --job-id');
    const job = await ports.jobStore.get(args['job-id']);
    if (!job) throw new Error(`Async job ${args['job-id']} was not found`);
    await writeJson(args.out, await coordinator.drain(job));
    return;
  }
  if (command === 'async-watch') {
    if (!args['job-id']) throw new Error('async-watch requires --job-id');
    const intervalSeconds = Number(args['interval-seconds'] ?? 30);
    const maxSeconds = Number(args['max-seconds'] ?? 3600);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) throw new Error('async-watch interval must be >= 1');
    if (!Number.isFinite(maxSeconds) || maxSeconds < intervalSeconds) throw new Error('async-watch max must be >= interval');
    const deadline = Date.now() + maxSeconds * 1000;
    let result;
    while (Date.now() <= deadline) {
      result = await coordinator.reconcile(args['job-id']);
      if (['COMPLETE', 'ENDPOINT_DELETED'].includes(result.status)) {
        await writeJson(args.out, result);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
    }
    throw new Error(`async-watch deadline exceeded for ${args['job-id']}`);
  }
  if (command === 'async-zero-idle') {
    const proof = await coordinator.zeroIdleProof();
    await writeJson(args.out, proof);
    if (!proof.zeroIdleGpu) process.exitCode = 3;
    return;
  }
  throw new Error(`Unknown command ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    error: error?.name ?? 'Error',
    code: error?.code ?? 'SESSION5_CLI_FAILURE',
    message: error?.message ?? String(error),
    details: error?.details,
  })}\n`);
  process.exitCode = 1;
});
