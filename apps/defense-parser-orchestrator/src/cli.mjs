#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { evaluateBenchmark } from './session5.mjs';
import {
  REAL_BATCH_INPUT_CONTENT_TYPE,
  REAL_BATCH_OUTPUT_ACCEPT,
  RealNvidiaBatchCoordinator,
  loadRealBatchConfig,
  validateLiveBenchmarkCorpus,
} from './real-batch.mjs';
import { createAwsRealBatchPorts } from './aws-real-runtime.mjs';

function usage() {
  return `Usage:
  node src/cli.mjs validate-config [--out <file>]
  node src/cli.mjs benchmark --corpus <file> --out <file> [--enforce-live true]
  node src/cli.mjs plan --request <file> --out <file>
  node src/cli.mjs submit --plan <file> --out <file>
  node src/cli.mjs reconcile --job-id <id> --out <file>
  node src/cli.mjs reconcile --all true --out <file>
  node src/cli.mjs retry --job-id <id> --out <file>
  node src/cli.mjs watch --job-id <id> --interval-seconds 30 --max-seconds 3600 --out <file>
  node src/cli.mjs handle-event --job-id <id> --out <file>
  node src/cli.mjs zero-idle --out <file>

handle-event is only a reconciliation signal: provider status, output identity, timing,
and cost are always re-read from SageMaker/S3. Caller-supplied provider facts are never trusted.
The CLI exposes no public listener and accepts no static cloud credentials.
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
      materialImprovementThreshold: Number(
        args['improvement-threshold'] ?? 0.05,
      ),
      maxCostPerThousandPages: Number(
        args['max-cost-per-thousand'] ?? Infinity,
      ),
    });
    await writeJson(args.out, result);
    if (args['enforce-live'] === 'true' && !result.liveBenchmarkAccepted) {
      process.exitCode = 2;
    }
    return;
  }

  const config = loadRealBatchConfig();
  if (command === 'validate-config') {
    await writeJson(args.out, {
      valid: true,
      enabled: config.enabled,
      routingMode: config.routingMode,
      benchmarkAccepted: config.benchmarkAccepted,
      modelName: config.modelName,
      modelVersion: config.modelVersion,
      maxConcurrentGpuJobs: config.maxConcurrentGpuJobs,
      maxPagesPerJob: config.maxPagesPerJob,
      initialBenchmarkCapUsd: config.initialBenchmarkCapUsd,
      hardIncrementalCapUsd: config.hardIncrementalCapUsd,
      effectiveSpendCapUsd: config.effectiveSpendCapUsd,
      extendedBudgetAuthorized: config.extendedBudgetAuthorized,
      maxPaidAttempts: config.maxPaidAttempts,
      executionModel: 'sagemaker_batch_transform',
      inputContentType: REAL_BATCH_INPUT_CONTENT_TYPE,
      outputAccept: REAL_BATCH_OUTPUT_ACCEPT,
      persistentEndpoint: false,
      atomicReservationLedger: Boolean(config.ledgerTableName),
    });
    return;
  }

  const ports = createAwsRealBatchPorts(config);
  const coordinator = new RealNvidiaBatchCoordinator(ports, config);

  if (command === 'plan') {
    await writeJson(args.out, await coordinator.plan(await readJson(args.request)));
    return;
  }
  if (command === 'submit') {
    await writeJson(args.out, await coordinator.submit(await readJson(args.plan)));
    return;
  }
  if (command === 'reconcile') {
    if (args.all === 'true') {
      await writeJson(args.out, await coordinator.reconcileAll());
      return;
    }
    if (!args['job-id']) {
      throw new Error('reconcile requires --job-id or --all true');
    }
    await writeJson(args.out, await coordinator.reconcileJob(args['job-id']));
    return;
  }
  if (command === 'handle-event') {
    if (!args['job-id']) {
      throw new Error(
        'handle-event requires --job-id; caller provider facts are not accepted',
      );
    }
    await writeJson(args.out, await coordinator.reconcileJob(args['job-id']));
    return;
  }
  if (command === 'retry') {
    if (!args['job-id']) throw new Error('retry requires --job-id');
    await writeJson(args.out, await coordinator.retry(args['job-id']));
    return;
  }
  if (command === 'watch') {
    if (!args['job-id']) throw new Error('watch requires --job-id');
    const intervalSeconds = Number(args['interval-seconds'] ?? 30);
    const maxSeconds = Number(args['max-seconds'] ?? 3600);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) {
      throw new Error('watch --interval-seconds must be >= 1');
    }
    if (!Number.isFinite(maxSeconds) || maxSeconds < intervalSeconds) {
      throw new Error('watch --max-seconds must be >= interval-seconds');
    }
    const deadline = Date.now() + maxSeconds * 1000;
    let result;
    while (Date.now() <= deadline) {
      result = await coordinator.reconcileJob(args['job-id']);
      if (
        ['RESUME_PUBLISHED', 'DLQ'].includes(result.status) &&
        result.dlqPublishPending !== true
      ) {
        await writeJson(args.out, result);
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, intervalSeconds * 1000),
      );
    }
    throw new Error(`watch deadline exceeded for ${args['job-id']}`);
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
  process.stderr.write(`${JSON.stringify({
    error: error?.name ?? 'Error',
    code: error?.code ?? 'SESSION5_CLI_FAILURE',
    message: error?.message ?? String(error),
    details: error?.details,
  })}\n`);
  process.exitCode = 1;
});
