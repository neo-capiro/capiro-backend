import { Construct } from 'constructs';
import {
  CfnCondition,
  CfnOutput,
  CfnParameter,
  CfnRule,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { ScheduledIngestionJobs } from './constructs/scheduled-ingestion-jobs';

export const FORECAST_ARCHIVE = '/var/lib/capiro/government-forecasts';
// CORE-CUT2-RECEIPT-20261102: qualified ARM64 Core48, not old clone/Strategy images.
export const FORECAST_IMAGE =
  '967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-core@sha256:bad6082aba3a67526ed3a835ab6a417749c4aae58635d4a422ac4edd2feb0ce8';

/** Additive clone job resources only. Parameters are missing executor facts, not defaults. */
export class GovernmentForecastOperationsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const parameter = (
      name: string,
      description: string,
      type = 'String',
      allowedPattern?: string,
    ) =>
      new CfnParameter(this, name, {
        type,
        description,
        ...(name.endsWith('SecretArn') ? { noEcho: true } : {}),
        ...(allowedPattern ? { allowedPattern } : {}),
      }).valueAsString;
    const vpcId = parameter(
      'CloneVpcId',
      'Actual VPC containing the preview clone and approved producer subnets.',
      'AWS::EC2::VPC::Id',
    );
    const subnetA = parameter(
      'ClonePrivateSubnetA',
      'Approved private subnet with HTTPS egress; no public IP.',
      'AWS::EC2::Subnet::Id',
    );
    const subnetB = parameter(
      'ClonePrivateSubnetB',
      'Second private subnet in a distinct AZ, same clone VPC.',
      'AWS::EC2::Subnet::Id',
    );
    const azA = parameter(
      'CloneSubnetAzA',
      'Verified AZ of ClonePrivateSubnetA.',
      'AWS::EC2::AvailabilityZone::Name',
    );
    const azB = parameter(
      'CloneSubnetAzB',
      'Verified AZ of ClonePrivateSubnetB.',
      'AWS::EC2::AvailabilityZone::Name',
    );
    new CfnRule(this, 'DistinctArchiveZones', {
      assertions: [
        {
          assert: Fn.conditionNot(Fn.conditionEquals(azA, azB)),
          assertDescription: 'Archive mount targets require distinct AZs.',
        },
        {
          assert: Fn.conditionNot(Fn.conditionEquals(subnetA, subnetB)),
          assertDescription: 'Use two distinct approved subnets.',
        },
        {
          assert: Fn.conditionEachMemberEquals(
            Fn.valueOfAll('AWS::EC2::Subnet::Id', 'VpcId'),
            vpcId,
          ),
          assertDescription: 'Both subnets must belong to the supplied clone VPC.',
        },
        {
          assert: Fn.conditionEachMemberEquals(
            [Fn.valueOf('ClonePrivateSubnetA', 'AvailabilityZone')],
            azA,
          ),
          assertDescription: 'Subnet A must match its supplied AZ.',
        },
        {
          assert: Fn.conditionEachMemberEquals(
            [Fn.valueOf('ClonePrivateSubnetB', 'AvailabilityZone')],
            azB,
          ),
          assertDescription: 'Subnet B must match its supplied AZ.',
        },
      ],
    });
    const clusterArn = parameter(
      'CloneClusterArn',
      'Actual existing ECS cluster; do not infer from a service alias.',
      'String',
      '^arn:aws:ecs:us-east-1:967807252336:cluster/[A-Za-z0-9_-]+$',
    );
    const dbGroupId = parameter(
      'CloneDatabaseSecurityGroupId',
      'Security group attached to the preview-clone writer, never the live database.',
      'AWS::EC2::SecurityGroup::Id',
    );
    const secretArn = parameter(
      'ForecastDatabaseUrlSecretArn',
      'Custodian-created complete secret ARN: raw qualified clone importer DATABASE_URL, sslmode=require and connection_limit=1. No credentials in parameters.',
      'String',
      '^arn:aws:secretsmanager:us-east-1:967807252336:secret:.+$',
    );
    const secretKeyArn = new CfnParameter(this, 'ForecastSecretKmsKeyArn', {
      type: 'String',
      noEcho: true,
      default: '',
      description:
        'Actual customer KMS key ARN if the secret uses one; empty only for the AWS-managed Secrets Manager key.',
      allowedPattern: '^$|^arn:aws:kms:us-east-1:967807252336:key/[a-f0-9-]+$',
    });
    const enabled = new CfnParameter(this, 'EnableDailyRule', {
      type: 'String',
      default: 'false',
      allowedValues: ['false', 'true'],
      description:
        'Keep false until first finite population/readback and custody/monitoring binding are accepted.',
    });
    const enableDaily = new CfnCondition(this, 'DailyApproved', {
      expression: Fn.conditionEquals(enabled.valueAsString, 'true'),
    });
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'CloneVpc', {
      vpcId,
      availabilityZones: [azA, azB],
      privateSubnetIds: [subnetA, subnetB],
    });
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'CloneCluster', {
      clusterArn,
      clusterName: Fn.select(1, Fn.split('/', clusterArn)),
      vpc,
    });
    const taskGroup = new ec2.SecurityGroup(this, 'ProducerNetwork', {
      vpc,
      allowAllOutbound: false,
      description: 'Government Forecasts: publisher HTTPS, clone PostgreSQL and own archive only.',
    });
    const dbGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'CloneDatabaseNetwork', dbGroupId, {
      mutable: false,
    });
    taskGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Official publisher and AWS runtime HTTPS endpoints',
    );
    taskGroup.addEgressRule(
      dbGroup,
      ec2.Port.tcp(5432),
      'Only the custodian-bound clone database group',
    );
    new ec2.CfnSecurityGroupIngress(this, 'CloneDatabaseAdmission', {
      groupId: dbGroupId,
      sourceSecurityGroupId: taskGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      description: 'Dedicated Government Forecast importer',
    });
    const taskRole = new iam.Role(this, 'ProducerRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    const archive = new efs.FileSystem(this, 'Archive', {
      vpc,
      encrypted: true,
      enableAutomaticBackups: true,
      removalPolicy: RemovalPolicy.RETAIN,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: new ec2.SecurityGroup(this, 'ArchiveNetwork', {
        vpc,
        allowAllOutbound: false,
      }),
      fileSystemPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['elasticfilesystem:Client*'],
            resources: ['*'],
            conditions: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['elasticfilesystem:Client*'],
            resources: ['*'],
            conditions: { StringNotEquals: { 'aws:PrincipalArn': taskRole.roleArn } },
          }),
        ],
      }),
    });
    archive.connections.allowDefaultPortFrom(taskGroup, 'Only the dedicated Forecast task');
    const access = archive.addAccessPoint('Producer', {
      path: '/government-forecasts',
      posixUser: { uid: '1001', gid: '1001' },
      createAcl: { ownerUid: '1001', ownerGid: '1001', permissions: '0700' },
    });
    access.applyRemovalPolicy(RemovalPolicy.RETAIN);
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
        resources: [archive.fileSystemArn],
        conditions: {
          StringEquals: { 'elasticfilesystem:AccessPointArn': access.accessPointArn },
          Bool: { 'elasticfilesystem:AccessedViaMountTarget': 'true' },
        },
      }),
    );
    const task = new ecs.FargateTaskDefinition(this, 'ProducerTask', {
      family: 'capiro-preview-government-forecasts',
      cpu: 512,
      memoryLimitMiB: 2048,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      volumes: [
        {
          name: 'forecast-archive',
          efsVolumeConfiguration: {
            fileSystemId: archive.fileSystemId,
            transitEncryption: 'ENABLED',
            authorizationConfig: { accessPointId: access.accessPointId, iam: 'ENABLED' },
          },
        },
      ],
    });
    const logGroup = new logs.LogGroup(this, 'ProducerLogs', {
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const secret = secrets.Secret.fromSecretCompleteArn(this, 'ImporterUrl', secretArn);
    const container = task.addContainer('forecast', {
      image: ecs.ContainerImage.fromRegistry(FORECAST_IMAGE),
      command: ['refresh-government-forecasts', '--help'], // No implicit apply on bare RunTask.
      secrets: { DATABASE_URL: ecs.Secret.fromSecretsManager(secret) },
      environment: {
        TMPDIR: '/dev/shm',
        GIT_SHA: '4ee2a11ec050d5abf4f25b9d0bdaceb737d41b81',
        RELEASE_SHA: '4ee2a11ec050d5abf4f25b9d0bdaceb737d41b81',
      },
      readonlyRootFilesystem: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'forecast' }),
    });
    container.addMountPoints({
      sourceVolume: 'forecast-archive',
      containerPath: FORECAST_ARCHIVE,
      readOnly: false,
    });
    const executionRole = task.obtainExecutionRole();
    // fromRegistry pins the exact image but does not automatically grant private ECR pulls.
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }),
    );
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: ['arn:aws:ecr:us-east-1:967807252336:repository/capiro/preview-core'],
      }),
    );
    const keyPolicy = new iam.Policy(this, 'SecretKeyRead', {
      roles: [executionRole],
      statements: [
        new iam.PolicyStatement({
          actions: ['kms:Decrypt'],
          resources: [secretKeyArn.valueAsString],
          conditions: {
            StringEquals: { 'kms:ViaService': 'secretsmanager.us-east-1.amazonaws.com' },
          },
        }),
      ],
    });
    (keyPolicy.node.defaultChild as iam.CfnPolicy).cfnOptions.condition = new CfnCondition(
      this,
      'CustomerSecretKey',
      { expression: Fn.conditionNot(Fn.conditionEquals(secretKeyArn.valueAsString, '')) },
    );
    const jobs = new ScheduledIngestionJobs(this, 'Daily', {
      envName: 'preview',
      cluster,
      taskDefinition: task,
      containerName: container.containerName,
      securityGroup: taskGroup,
      jobs: [
        {
          id: 'GovernmentForecasts',
          tier: 'daily',
          description:
            'Official Unified Agenda windows; clone only, exclusive archive, no automatic retry.',
          cron: { minute: '13', hour: '4' },
          enabled: false,
          retryAttempts: 0,
          command: [
            'refresh-government-forecasts',
            '--archive-dir',
            FORECAST_ARCHIVE,
            '--run-id',
            events.EventField.eventId,
            '--apply',
          ],
        },
      ],
    });
    const rule = jobs.rules[0];
    if (!rule) throw new Error('Forecast rule missing');
    (rule.node.defaultChild as events.CfnRule).state = Fn.conditionIf(
      enableDaily.logicalId,
      'ENABLED',
      'DISABLED',
    ).toString();
    rule.node.addDependency(archive.mountTargetsAvailable);
    for (const [name, value] of Object.entries({
      TaskDefinitionArn: task.taskDefinitionArn,
      TaskSecurityGroupId: taskGroup.securityGroupId,
      ArchiveFileSystemId: archive.fileSystemId,
      ArchiveAccessPointId: access.accessPointId,
      DailyRuleName: rule.ruleName,
      TaskRoleArn: taskRole.roleArn,
      ExecutionRoleArn: executionRole.roleArn,
      LogGroupName: logGroup.logGroupName,
    }))
      new CfnOutput(this, name, { value });
  }
}
