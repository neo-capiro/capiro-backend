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
      monthlyGpuBudgetUsd: 250,
    });
    return Template.fromStack(stack);
  };

  it('creates Batch Transform prerequisites but no persistent endpoint', () => {
    const template = synth();
    template.resourceCountIs('AWS::SageMaker::Model', 1);
    template.resourceCountIs('AWS::SageMaker::Endpoint', 0);
    template.resourceCountIs('AWS::SageMaker::EndpointConfig', 0);
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.resourceCountIs('AWS::S3::Bucket', 1);
  });

  it('pins the Marketplace model package and retains encrypted evidence', () => {
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
  });

  it('grants transform-job operations and never grants endpoint mutation', () => {
    const template = synth().toJSON();
    const json = JSON.stringify(template);
    expect(json).toContain('sagemaker:CreateTransformJob');
    expect(json).toContain('sagemaker:DescribeTransformJob');
    expect(json).not.toContain('sagemaker:CreateEndpoint');
    expect(json).not.toContain('sagemaker:CreateEndpointConfig');
    expect(json).not.toContain('sagemaker:UpdateEndpoint');
    expect(json).not.toContain('sagemaker:DeleteEndpoint');
  });

  it('uses a DLQ and emits a literal zero-endpoint proof output', () => {
    const template = synth();
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
    const outputs = Object.values(template.toJSON().Outputs ?? {});
    expect(outputs).toContainEqual(
      expect.objectContaining({
        Value: '0',
        Description: 'This construct creates no endpoint or endpoint configuration',
      }),
    );
  });

  it('creates alarms for DLQ, queue age, concurrency, and application spend', () => {
    synth().resourceCountIs('AWS::CloudWatch::Alarm', 4);
  });
});
