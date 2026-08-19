import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Phase8Session5NvidiaBenchmark } from '../lib/phase8-session5-nvidia-benchmark';

describe('Phase8Session5NvidiaBenchmark', () => {
  const synth = () => {
    const app = new App();
    const stack = new Stack(app, 'Session5Test', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    new Phase8Session5NvidiaBenchmark(stack, 'Plane', {
      modelPackageArn:
        'arn:aws:sagemaker:us-east-1:111111111111:model-package/capiro-nemotron-parse/7',
      monthlyGpuBudgetUsd: 150,
      initialBenchmarkCapUsd: 50,
    });
    return Template.fromStack(stack);
  };

  it('creates Batch Transform prerequisites with completion outbox and atomic reservation ledger, but no endpoint', () => {
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
          'arn:aws:sagemaker:us-east-1:111111111111:model-package/capiro-nemotron-parse/7',
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

  it('grants Batch Transform, completion publish and Dynamo transactions but never endpoint mutation', () => {
    const json = JSON.stringify(synth().toJSON());
    expect(json).toContain('sagemaker:CreateTransformJob');
    expect(json).toContain('sagemaker:DescribeTransformJob');
    expect(json).toContain('sqs:SendMessage');
    expect(json).toContain('dynamodb:TransactWriteItems');
    expect(json).not.toContain('sagemaker:CreateEndpoint');
    expect(json).not.toContain('sagemaker:CreateEndpointConfig');
    expect(json).not.toContain('sagemaker:UpdateEndpoint');
    expect(json).not.toContain('sagemaker:DeleteEndpoint');
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
        Description: 'This construct creates no endpoint or endpoint configuration',
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
});
