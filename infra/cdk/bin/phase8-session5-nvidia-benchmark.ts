#!/usr/bin/env node
import { App, Stack, Tags } from 'aws-cdk-lib';
import {
  Phase8Session5NvidiaBenchmark,
  SESSION5_REQUIRED_MODEL_PACKAGE_ARN,
} from '../lib/phase8-session5-nvidia-benchmark';

const REQUIRED_MODEL_PACKAGE_ARN = SESSION5_REQUIRED_MODEL_PACKAGE_ARN;
const REQUIRED_ACCOUNT = '967807252336';
const REQUIRED_REGION = 'us-east-1';
const INITIAL_BENCHMARK_CAP_USD = 50;
const HARD_INCREMENTAL_BUDGET_USD = 150;

const app = new App();
const account =
  app.node.tryGetContext('account') ?? process.env.CDK_DEFAULT_ACCOUNT;
const region =
  app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION;
const modelPackageArn =
  app.node.tryGetContext('modelPackageArn') ?? REQUIRED_MODEL_PACKAGE_ARN;
const hardCapUsd = Number(
  app.node.tryGetContext('monthlyGpuBudgetUsd') ?? HARD_INCREMENTAL_BUDGET_USD,
);
const initialCapUsd = Number(
  app.node.tryGetContext('initialBenchmarkCapUsd') ?? INITIAL_BENCHMARK_CAP_USD,
);

if (account !== REQUIRED_ACCOUNT || region !== REQUIRED_REGION) {
  throw new Error(
    `Session 5 benchmark is approved only for ${REQUIRED_ACCOUNT}/${REQUIRED_REGION}; received ${account}/${region}`,
  );
}
if (modelPackageArn !== REQUIRED_MODEL_PACKAGE_ARN) {
  throw new Error(
    'Session 5 benchmark requires the approved pinned NVIDIA Nemotron Parse model package ARN',
  );
}
if (
  !Number.isFinite(hardCapUsd) ||
  hardCapUsd <= 0 ||
  hardCapUsd > HARD_INCREMENTAL_BUDGET_USD
) {
  throw new Error(
    `monthlyGpuBudgetUsd must be > 0 and <= ${HARD_INCREMENTAL_BUDGET_USD}`,
  );
}
if (
  !Number.isFinite(initialCapUsd) ||
  initialCapUsd <= 0 ||
  initialCapUsd > INITIAL_BENCHMARK_CAP_USD ||
  initialCapUsd > hardCapUsd
) {
  throw new Error(
    `initialBenchmarkCapUsd must be > 0 and <= ${INITIAL_BENCHMARK_CAP_USD} and <= hard cap`,
  );
}

const stack = new Stack(app, 'CapiroPhase8Session5NvidiaBenchmark', {
  env: { account: REQUIRED_ACCOUNT, region: REQUIRED_REGION },
});
Tags.of(stack).add('Project', 'capiro');
Tags.of(stack).add('CapiroPhase', 'phase8-session5');
Tags.of(stack).add('CapiroPurpose', 'isolated-nvidia-benchmark');
Tags.of(stack).add('CapiroInitialCapUsd', String(initialCapUsd));
Tags.of(stack).add('CapiroSpendCapUsd', String(hardCapUsd));

new Phase8Session5NvidiaBenchmark(stack, 'Plane', {
  modelPackageArn,
  monthlyGpuBudgetUsd: hardCapUsd,
  initialBenchmarkCapUsd: initialCapUsd,
  instanceType: 'ml.g5.xlarge',
});

app.synth();
