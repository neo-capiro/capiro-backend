import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { commonTags, type EnvConfig } from './config';
import { ScheduledMemoryProjectionWorker } from './constructs/scheduled-memory-projection-worker';

export interface MemoryProjectionWorkerStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  cluster: ecs.ICluster;
  apiRepo: ecr.IRepository;
  serviceSecurityGroup: ec2.ISecurityGroup;
  dbSecret: secretsmanager.ISecret;
  appDbSecret: secretsmanager.ISecret;
  databaseName: string;
  dataKey: kms.IKey;
  secretsKey: kms.IKey;
}

/**
 * Separate stack for the scheduled governed-memory projector.
 *
 * Keeping this outside ComputeStack gives operations an explicit rollback switch:
 * disable the EventBridge rule or roll back this task definition without replacing
 * long-running API services. The stack consumes existing cluster/network/data
 * outputs and creates no database, customer-data, or migration resources.
 */
export class MemoryProjectionWorkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MemoryProjectionWorkerStackProps) {
    super(scope, id, props);
    const {
      cfg,
      cluster,
      apiRepo,
      serviceSecurityGroup,
      dbSecret,
      appDbSecret,
      databaseName,
      dataKey,
      secretsKey,
    } = props;

    commonTags(cfg).forEach((tag) => cdk.Tags.of(this).add(tag.key, tag.value));

    new ScheduledMemoryProjectionWorker(this, 'ScheduledWorker', {
      envName: cfg.envName,
      cluster,
      apiRepo,
      securityGroup: serviceSecurityGroup,
      dbSecret,
      appDbSecret,
      databaseName,
      dataKeyArn: dataKey.keyArn,
      secretsKeyArn: secretsKey.keyArn,
      region: this.region,
      account: this.account,
      protectFromDestroy: cfg.protectFromDestroy,
    });
  }
}
