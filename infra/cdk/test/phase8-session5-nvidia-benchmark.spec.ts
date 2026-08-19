import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Phase8Session5NvidiaBenchmark } from '../lib/phase8-session5-nvidia-benchmark';
import {
  SESSION5_ASYNC_EXECUTION_MODE,
  SESSION5_REQUIRED_MODEL_PACKAGE_ARN,
} from '../lib/phase8-session5-nvidia-benchmark';

describe('Phase8Session5NvidiaBenchmark', () => {
  const synth = () => {
    const app = new App();
    const stack = new Stack(app, 'Session5Test', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    new Phase8Session5NvidiaBenchmark(stack, 'Plane', {
      modelPackageArn: SESSION5_REQUIRED_MODEL_PACKAGE_ARN,
      monthlyGpuBudgetUsd: 150,
      initialBenchmarkCapUsd: 50,
      executionMode: SESSION5_ASYNC_EXECUTION_MODE,
    });
    return Template.fromStack(stack);
  };

  it('creates Async Inference control-plane prerequisites with completion outbox and atomic reservation ledger, but no declarative endpoint', () => {
    const template = synth();
    template.resourceCountIs('AWS::SageMaker::Model', 1);
    template.resourceCountIs('AWS::SageMaker::Endpoint', 0);
    template.resourceCountIs('AWS::SageMaker::EndpointConfig', 0);
    template.resourceCountIs('AWS::SQS::Queue', 3);
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.resourceCountIs('AWS::S3::Bucket', 1);
  });

  it('pins Marketplace package, network isolation, encrypted retained evidence and PITR ledger', () => {
    const template = synth();
    template.hasResourceProperties('AWS::SageMaker::Model', {
      EnableNetworkIsolation: true,
      PrimaryContainer: {
        ModelPackageName:
          SESSION5_REQUIRED_MODEL_PACKAGE_ARN,
      },
    });
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: Match.anyValue(),
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
  });

  it('grants Async Inference lifecycle, completion publish and Dynamo transactions', () => {
    const json = JSON.stringify(synth().toJSON());
    expect(json).toContain('sagemaker:CreateEndpoint');
    expect(json).toContain('sagemaker:CreateEndpointConfig');
    expect(json).toContain('sagemaker:InvokeEndpointAsync');
    expect(json).toContain('sagemaker:DeleteEndpoint');
    expect(json).toContain('application-autoscaling:RegisterScalableTarget');
    expect(json).toContain('sqs:SendMessage');
    expect(json).toContain('dynamodb:TransactWriteItems');
    expect(json).not.toContain('sagemaker:CreateTransformJob');
    expect(json).not.toContain('sagemaker:DescribeTransformJob');
  });

  it('retains DLQ wiring and literal zero-endpoint proof', () => {
    const template = synth();
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
    const outputs = Object.values(template.toJSON().Outputs ?? {});
    expect(outputs).toContainEqual(
      expect.objectContaining({
        Value: '0',
        Description:
          'Endpoints are orchestrator-owned ephemeral resources and must be deleted after the run',
      }),
    );
    expect(
      outputs.some(
        (o: any) =>
          o.Value && JSON.stringify(o.Value).includes('CompletionQueue'),
      ),
    ).toBe(true);
  });

  it('creates alarms for DLQ, queue age, concurrency and hard spend', () => {
    synth().resourceCountIs('AWS::CloudWatch::Alarm', 4);
  });

  it('rejects unapproved model packages and cap overrides', () => {
    const app = new App();
    const stack = new Stack(app, 'RejectTest', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    expect(() =>
      new Phase8Session5NvidiaBenchmark(stack, 'BadModel', {
        modelPackageArn: 'arn:aws:sagemaker:us-east-1:111111111111:model-package/other',
        monthlyGpuBudgetUsd: 50,
      }),
    ).toThrow();
    expect(() =>
      new Phase8Session5NvidiaBenchmark(stack, 'BadCap', {
        modelPackageArn: SESSION5_REQUIRED_MODEL_PACKAGE_ARN,
        monthlyGpuBudgetUsd: 151,
      }),
    ).toThrow();
  });
});
