import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AssetsStack } from '../lib/assets-stack';
import type { EnvConfig } from '../lib/config';

describe('AssetsStack.grantClientLogoRead', () => {
  test('grants only canonical client-logo reads and KMS decrypt', () => {
    const app = new cdk.App();
    const cfg = {
      envName: 'dev',
      account: '123456789012',
      region: 'us-east-1',
      rootDomain: 'capiro.ai',
      appHost: 'app.capiro.ai',
      protectFromDestroy: false,
    } as EnvConfig;
    const stack = new AssetsStack(app, 'Assets', {
      cfg,
      env: { account: cfg.account, region: cfg.region },
    });
    const addToPrincipalPolicy = jest.fn();
    const grantee = {
      grantPrincipal: { addToPrincipalPolicy },
    } as unknown as iam.IGrantable;

    stack.grantClientLogoRead(grantee);

    // `.roleName` always resolves through the CFN `Ref` intrinsic (a Token)
    // even for an explicit name, so assert the literal against the
    // synthesized resource property instead — that's what actually deploys.
    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'capiro-dev-api-strategy-task-role',
    });

    expect(addToPrincipalPolicy).toHaveBeenCalledTimes(2);
    const statements = addToPrincipalPolicy.mock.calls.map(
      ([statement]) =>
        (statement as iam.PolicyStatement).toStatementJson() as Record<
          string,
          unknown
        >,
    );
    expect(statements[0]).toMatchObject({
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:GetObjectVersion'],
    });
    expect(statements[0]?.Resource).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/tenants\/\*\/clients\/\*\/logos\/\*\.png$/),
        expect.stringMatching(/\/tenants\/\*\/clients\/\*\/logos\/\*\.jpg$/),
        expect.stringMatching(/\/tenants\/\*\/clients\/\*\/logos\/\*\.jpeg$/),
      ]),
    );
    expect(statements[0]?.Resource).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\/clients\/\*\/logo\./)]),
    );
    expect(statements[0]?.Resource).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/client-logo-uploads/)]),
    );
    expect(statements[1]).toMatchObject({
      Effect: 'Allow',
      Action: 'kms:Decrypt',
    });

    const actions = statements.flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action],
    );
    expect(actions).not.toEqual(
      expect.arrayContaining([
        's3:ListBucket',
        's3:PutObject',
        's3:DeleteObject',
      ]),
    );

    const synthesized = JSON.stringify(Template.fromStack(stack).toJSON());
    expect(synthesized).toContain('tenants/client-logo-uploads/');
    expect(synthesized).toContain('ExpireUnconfirmedClientLogos');
    expect(synthesized).toContain('NoncurrentVersionExpiration');
  });
});

describe('manual Strategy task definition', () => {
  test('supplies the tenant assets bucket and AWS region', () => {
    const taskDefinition = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../deploy/api-strategy-serve-taskdef.json'),
        'utf8',
      ),
    ) as {
      taskRoleArn: string;
      containerDefinitions: Array<{
        name: string;
        environment: Array<{ name: string; value: string }>;
      }>;
    };
    const container = taskDefinition.containerDefinitions.find(
      ({ name }) => name === 'api-strategy',
    );
    const environment = Object.fromEntries(
      (container?.environment ?? []).map(({ name, value }) => [name, value]),
    );

    expect(environment).toMatchObject({
      ASSETS_BUCKET: 'capiro-dev-tenant-assets-967807252336',
      AWS_REGION_DEFAULT: 'us-east-1',
    });
    expect(taskDefinition.taskRoleArn).toBe(
      'arn:aws:iam::967807252336:role/capiro-dev-api-strategy-task-role',
    );
  });
});
