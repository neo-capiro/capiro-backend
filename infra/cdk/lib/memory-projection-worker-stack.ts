import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { commonTags, type EnvConfig } from './config';
import { ScheduledMemoryProjectionWorker } from './constructs/scheduled-memory-projection-worker';

export interface MemoryProjectionWorkerStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  cluster: ecs.ICluster;
  apiRepo: ecr.IRepository;
  apiImageTag: string;
  serviceSecurityGroup: ec2.ISecurityGroup;
  dbSecret: secretsmanager.ISecret;
  appDbSecret: secretsmanager.ISecret;
  databaseName: string;
  dataKey: kms.IKey;
  secretsKey: kms.IKey;
  scheduleEnabled: boolean;
  alertsTopic: sns.ITopic;
}

/**
 * Separate stack for the scheduled governed-memory projector.
 *
 * Keeping this outside ComputeStack gives operations an explicit rollback switch:
 * disable the EventBridge rule or roll back this task definition without replacing
 * long-running API services. The stack consumes existing cluster/network/data
 * outputs and creates no database, customer-data, or migration resources. Its
 * schedule is dark unless the release operator supplies the exact enable context.
 */
export class MemoryProjectionWorkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MemoryProjectionWorkerStackProps) {
    super(scope, id, props);
    const {
      cfg,
      cluster,
      apiRepo,
      apiImageTag,
      serviceSecurityGroup,
      dbSecret,
      appDbSecret,
      databaseName,
      dataKey,
      secretsKey,
      scheduleEnabled,
      alertsTopic,
    } = props;

    for (const [key, value] of Object.entries(commonTags(cfg))) {
      cdk.Tags.of(this).add(key, value);
    }

    const worker = new ScheduledMemoryProjectionWorker(this, 'ScheduledWorker', {
      envName: cfg.envName,
      cluster,
      apiRepo,
      apiImageTag,
      securityGroup: serviceSecurityGroup,
      dbSecret,
      appDbSecret,
      databaseName,
      dataKeyArn: dataKey.keyArn,
      secretsKeyArn: secretsKey.keyArn,
      region: this.region,
      account: this.account,
      protectFromDestroy: cfg.protectFromDestroy,
      scheduleEnabled,
      alertsTopic,
    });

    new cdk.CfnOutput(this, 'ProjectionWorkerScheduleName', {
      value: worker.rule.ruleName,
      description: `Governed-memory projection schedule (enabled=${scheduleEnabled})`,
    });
    new cdk.CfnOutput(this, 'ProjectionWorkerImageTag', {
      value: apiImageTag,
      description: 'API image tag bound to the governed-memory projection task definition',
    });
  }
}
