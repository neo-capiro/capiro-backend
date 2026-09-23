import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { EnvConfig, EnvName } from '../lib/config';
import { DataStack } from '../lib/data-stack';

function synthesizeData(envName: EnvName): Template {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const network = new cdk.Stack(app, `Network-${envName}`, { env });
  const vpc = new ec2.Vpc(network, 'Vpc', {
    maxAzs: 2,
    natGateways: 0,
    subnetConfiguration: [
      {
        cidrMask: 24,
        name: 'private',
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      {
        cidrMask: 24,
        name: 'isolated',
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    ],
  });
  const dbSecurityGroup = new ec2.SecurityGroup(network, 'DbSg', { vpc });
  const rotationSecurityGroup = new ec2.SecurityGroup(network, 'RotationSg', { vpc });
  const cfg = {
    envName,
    account: env.account,
    region: env.region,
    auroraMinAcu: 0.5,
    auroraMaxAcu: 4,
    auroraBackupRetentionDays: 35,
    protectFromDestroy: envName !== 'dev',
    logRetentionDays: 90,
  } as EnvConfig;

  return Template.fromStack(
    new DataStack(app, `Data-${envName}`, {
      env,
      cfg,
      vpc,
      dbSecurityGroup,
      rotationSecurityGroup,
    }),
  );
}

describe('DataStack Aurora PostgreSQL version', () => {
  test('uses the oldest currently available Aurora 16 minor for staging', () => {
    const template = synthesizeData('staging');
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      EngineVersion: '16.8',
    });
    template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
      RotationRules: {
        ScheduleExpression: 'rate(30 days)',
      },
    });
    template.resourceCountIs('AWS::CloudFormation::Stack', 1);
    template.hasResourceProperties('AWS::CloudFormation::Stack', {
      Parameters: Match.objectLike({
        vpcSecurityGroupIds: Match.objectLike({
          'Fn::ImportValue': Match.stringLikeRegexp('RotationSg'),
        }),
      }),
    });
    template.resourceCountIs('AWS::SecretsManager::Secret', 2);
  });

  test.each(['dev', 'prod'] as const)('does not alter the existing %s template', (envName) => {
    const template = synthesizeData(envName);
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      EngineVersion: '16.4',
    });
    template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
      RotationRules: {
        ScheduleExpression: 'rate(30 days)',
      },
    });
    template.resourceCountIs('AWS::CloudFormation::Stack', 0);
    template.resourceCountIs('AWS::SecretsManager::Secret', 4);
  });
});
