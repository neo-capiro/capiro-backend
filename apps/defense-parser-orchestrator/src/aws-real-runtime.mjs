export * from './aws-real-storage.mjs';
export * from './aws-real-ledger.mjs';

import { AwsCliRunner, AwsCliSqsPublisher, Session5RefusalError } from './session5.mjs';
import {
  AwsCliParserMetrics,
  AwsCliS3RealBatchStore,
  SafeAwsCliSageMakerBatchTransformAdapter,
} from './aws-real-storage.mjs';
import { AwsCliDynamoReservationLedger } from './aws-real-ledger.mjs';
import { SafeAwsCliSageMakerAsyncInferenceAdapter } from './real-async.mjs';

export function createAwsRealBatchPorts() {
  throw new Session5RefusalError(
    'BATCH_TRANSFORM_DISABLED',
    'The pinned ModelDataSource package cannot use the Batch Transform execution path',
  );
}

export function createAwsRealAsyncPorts(config, options = {}) {
  const runner =
    options.runner ?? new AwsCliRunner({ region: config.region });
  const store = new AwsCliS3RealBatchStore(runner, config);
  return {
    artifactStore: store,
    jobStore: store,
    endpointClient: new SafeAwsCliSageMakerAsyncInferenceAdapter(runner),
    reservationLedger: new AwsCliDynamoReservationLedger(runner, config),
    completionQueue: new AwsCliSqsPublisher(runner, config.completionQueueUrl),
    dlq: new AwsCliSqsPublisher(runner, config.dlqUrl),
    metrics: new AwsCliParserMetrics(runner),
  };
}
