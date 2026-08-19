import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AwsCliDynamoReservationLedger,
  SafeAwsCliSageMakerBatchTransformAdapter,
} from '../src/aws-real-runtime.mjs';

class FakeRunner {
  constructor() {
    this.calls = [];
    this.region = 'us-east-1';
    this.binary = 'aws';
    this.descriptions = new Map();
    this.listObjects = [];
    this.items = new Map();
  }

  async invoke(service, operation, input) {
    this.calls.push({ service, operation, input });
    if (service === 'sagemaker' && operation === 'describe-transform-job') {
      const d = this.descriptions.get(input.TransformJobName);
      if (!d) {
        throw new Error('ValidationException: Could not find transform job');
      }
      return d;
    }
    if (service === 'sagemaker' && operation === 'create-transform-job') {
      this.descriptions.set(input.TransformJobName, {
        TransformJobName: input.TransformJobName,
        TransformJobStatus: 'InProgress',
        CreationTime: '2026-08-19T00:00:00Z',
        TransformOutput: input.TransformOutput,
      });
      return {};
    }
    if (service === 's3api' && operation === 'list-objects-v2') {
      return { Contents: this.listObjects.map((Key) => ({ Key })) };
    }
    if (service === 'dynamodb' && operation === 'get-item') {
      return { Item: this.items.get(input.Key.pk.S) };
    }
    if (service === 'dynamodb' && operation === 'transact-write-items') return {};
    if (service === 'sagemaker' && operation === 'list-transform-jobs') {
      return { TransformJobSummaries: [] };
    }
    if (service === 'sagemaker' && operation === 'list-endpoints') {
      return { Endpoints: [] };
    }
    return {};
  }
}

test('safe adapter sends provider-supported application/json while splitting and assembling records by line', async () => {
  const runner = new FakeRunner();
  const adapter = new SafeAwsCliSageMakerBatchTransformAdapter(runner);
  const manifest = {
    s3Uri: 's3://in/batch/input.jsonl',
    bucket: 'in',
    key: 'batch/input.jsonl',
  };
  const handle = await adapter.ensureTransformJob({
    transformJobName: 'capiro-s5-abc-a01',
    batch: { batchId: 'b1' },
    manifest,
    config: {
      transformModelName: 'model',
      outputBucket: 'out',
      outputPrefix: 'prefix',
      instanceType: 'ml.g5.xlarge',
    },
  });
  const call = runner.calls.find((c) => c.operation === 'create-transform-job');
  assert.equal(call.input.TransformInput.ContentType, 'application/json');
  assert.equal(call.input.TransformInput.SplitType, 'Line');
  assert.equal(call.input.TransformOutput.Accept, 'application/json');
  assert.equal(call.input.TransformOutput.AssembleWith, 'Line');
  assert.equal(call.input.MaxConcurrentTransforms, 1);
  assert.equal(call.input.TransformResources.InstanceCount, 1);
  assert.equal(handle.transformJobName, 'capiro-s5-abc-a01');
});

test('safe adapter is idempotent by deterministic transform job name', async () => {
  const runner = new FakeRunner();
  const adapter = new SafeAwsCliSageMakerBatchTransformAdapter(runner);
  const manifest = {
    s3Uri: 's3://in/x.jsonl',
    bucket: 'in',
    key: 'x.jsonl',
  };
  const args = {
    transformJobName: 'capiro-s5-same-a01',
    batch: { batchId: 'same' },
    manifest,
    config: {
      transformModelName: 'model',
      outputBucket: 'out',
      outputPrefix: 'prefix',
      instanceType: 'ml.g5.xlarge',
    },
  };
  await adapter.ensureTransformJob(args);
  await adapter.ensureTransformJob(args);
  assert.equal(
    runner.calls.filter((c) => c.operation === 'create-transform-job').length,
    1,
  );
});

test('provider output resolver requires exactly one input-correlated .out object', async () => {
  const runner = new FakeRunner();
  const adapter = new SafeAwsCliSageMakerBatchTransformAdapter(runner);
  runner.listObjects = ['raw/input.jsonl.out'];
  assert.deepEqual(
    await adapter.resolveOutputObject({
      outputBucket: 'out',
      outputPrefix: 'raw',
      manifestKey: 'input.jsonl',
    }),
    { bucket: 'out', key: 'raw/input.jsonl.out' },
  );
  runner.listObjects = [];
  await assert.rejects(
    () =>
      adapter.resolveOutputObject({
        outputBucket: 'out',
        outputPrefix: 'raw',
        manifestKey: 'input.jsonl',
      }),
    (e) => e.code === 'PROVIDER_OUTPUT_OBJECT_MISMATCH',
  );
});

test('atomic ledger reservation transaction gates both concurrency and spend in one DynamoDB transaction', async () => {
  const runner = new FakeRunner();
  const ledger = new AwsCliDynamoReservationLedger(runner, {
    ledgerTableName: 'ledger',
  });
  await ledger.reserve({
    reservationId: 'r1',
    jobId: 'j1',
    attempt: 1,
    reservedCostUsd: 3,
    effectiveCapUsd: 50,
    hardCapUsd: 150,
    maxConcurrent: 1,
    at: '2026-08-19T00:00:00Z',
  });
  const tx = runner.calls.find(
    (c) => c.service === 'dynamodb' && c.operation === 'transact-write-items',
  ).input;
  assert.equal(tx.TransactItems.length, 2);
  const update = tx.TransactItems[1].Update;
  assert.match(update.ConditionExpression, /activeJobs < :max/);
  assert.match(update.ConditionExpression, /spentAndReservedUsd/);
  assert.equal(update.ExpressionAttributeValues[':remaining'].N, '47');
  assert.equal(update.ExpressionAttributeValues[':max'].N, '1');
});

test('atomic ledger refuses reconciled cost above the reserved amount before settlement', async () => {
  const runner = new FakeRunner();
  runner.items.set('RESERVATION#r-over', {
    pk: { S: 'RESERVATION#r-over' },
    status: { S: 'ACTIVE' },
    reservedCostUsd: { N: '1' },
    effectiveCapUsd: { N: '50' },
    hardCapUsd: { N: '150' },
    jobId: { S: 'job-over' },
  });
  const ledger = new AwsCliDynamoReservationLedger(runner, {
    ledgerTableName: 'ledger',
  });
  await assert.rejects(
    () => ledger.settle({
      reservationId: 'r-over',
      reconciledCostUsd: 2,
      at: '2026-08-19T00:00:00Z',
    }),
    (error) => error.code === 'RECONCILED_COST_EXCEEDS_HARD_CAP',
  );
  assert.equal(
    runner.calls.filter(
      (call) => call.service === 'dynamodb' && call.operation === 'transact-write-items',
    ).length,
    0,
  );
});

test('real Batch port factory is hard-disabled after the ModelDataSource compatibility block', async () => {
  const { createAwsRealBatchPorts } = await import('../src/aws-real-runtime.mjs');
  assert.throws(
    () => createAwsRealBatchPorts(),
    (error) => error.code === 'BATCH_TRANSFORM_DISABLED',
  );
});
