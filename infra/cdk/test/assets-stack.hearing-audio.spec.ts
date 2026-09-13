import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AssetsStack } from '../lib/assets-stack';
import type { EnvConfig } from '../lib/config';

test('hearing retention can purge object versions only inside its media prefix', () => {
  const cfg = {
    envName: 'dev',
    account: '123456789012',
    region: 'us-east-1',
    rootDomain: 'capiro.ai',
    appHost: 'app.capiro.ai',
    protectFromDestroy: false,
  } as EnvConfig;
  const stack = new AssetsStack(new cdk.App(), 'HearingAssets', {
    cfg,
    env: { account: cfg.account, region: cfg.region },
  });
  const addToPrincipalPolicy = jest.fn();
  stack.grantHearingAudioAccess({
    grantPrincipal: { addToPrincipalPolicy },
  } as unknown as iam.IGrantable);
  const statements = addToPrincipalPolicy.mock.calls.map(([statement]) =>
    (statement as iam.PolicyStatement).toStatementJson(),
  );
  expect(statements).toHaveLength(2);
  expect(statements[0].Resource).toMatch(/\/hearing-audio\/\*$/);
  expect(statements[0].Action).toEqual(
    expect.arrayContaining(['s3:PutObject', 's3:GetObject', 's3:DeleteObjectVersion']),
  );
  expect(statements[1]).toMatchObject({
    Action: ['s3:ListBucket', 's3:ListBucketVersions'],
    Condition: { StringLike: { 's3:prefix': ['hearing-audio/*'] } },
  });
  const serialized = JSON.stringify(statements);
  expect(serialized).not.toContain('tenants/*');
  expect(serialized).not.toContain('s3:PutObjectAcl');
  expect(serialized).not.toContain('s3:PutBucketPolicy');
});
