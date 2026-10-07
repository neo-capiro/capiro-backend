import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AssetsStack } from '../lib/assets-stack';
import type { EnvConfig } from '../lib/config';
test('Planner attachment grants are scoped to its object prefix and existing encryption key', () => {
  const cfg = {
    envName: 'dev',
    account: '123456789012',
    region: 'us-east-1',
    rootDomain: 'capiro.ai',
    appHost: 'app.capiro.ai',
    protectFromDestroy: false,
  } as EnvConfig;
  const stack = new AssetsStack(new cdk.App(), 'Assets', {
    cfg,
    env: { account: cfg.account, region: cfg.region },
  });
  const addToPrincipalPolicy = jest.fn();
  stack.grantPlannerAttachmentAccess({
    grantPrincipal: { addToPrincipalPolicy },
  } as unknown as iam.IGrantable);
  const statements = addToPrincipalPolicy.mock.calls.map(([s]) =>
    (s as iam.PolicyStatement).toStatementJson(),
  );
  expect(statements[0].Action).toEqual(['s3:GetObject', 's3:PutObject', 's3:DeleteObject']);
  expect(JSON.stringify(statements[0].Resource)).toContain('/tenants/*/planner/tasks/*/*');
  expect(statements[1].Action).toEqual(['kms:GenerateDataKey', 'kms:Decrypt']);
  expect(JSON.stringify(stack.resolve(statements[1].Resource))).toContain('AssetsKey');
  const resources = Template.fromStack(stack).toJSON().Resources;
  expect(Object.values(resources).filter((r: any) => r.Type === 'AWS::S3::Bucket')).toHaveLength(1);
});
