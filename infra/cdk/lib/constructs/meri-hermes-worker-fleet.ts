import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface MeriHermesWorkerFleetProps {
  envName: string;
  vpc: ec2.IVpc;
  /** Private subnets only: workers never get a public IP (RunTask sets `assignPublicIp: DISABLED`) and EFS mount targets go here. */
  subnets: ec2.ISubnet[];
  workerRepo: ecr.IRepository;
  /** Immutable `sha256:...` digest. Phase 1 has no real digest yet; the caller supplies whatever is pinned in `docs/meri/hermes/phase-0/pins.md` once the arm64 build (backlog #3) exists. */
  workerImageDigest: string;
  /** Shared bearer key the API uses to call every worker (`API_SERVER_KEY` on the worker side, `MERI_HERMES_API_KEY` on the Meri side) — static/shared per pilot-configuration.md §3, not scope-specific. */
  apiServerKeySecret: secretsmanager.ISecret;
  /** Platform model credential (OpenAI/Anthropic key). Narrow-budget-per-tenant is an unresolved Phase 1 product decision (backlog "Decisions Phase 1 needs"); this wires whichever secret is supplied today. */
  modelCredentialSecret: secretsmanager.ISecret;
  /** Field inside `modelCredentialSecret` holding the key value. */
  modelCredentialSecretField: string;
  /** Container env var name the credential is exposed as, e.g. `OPENAI_API_KEY`. */
  modelCredentialEnvName: string;
  /** `MERI_BROKER_URL` — static per environment: `https://<api-host>/api/internal/hermes/broker`. */
  brokerUrl: string;
  /** `MERI_HERMES_MODEL` — pilot default recommendation: `gpt-5.6-terra` (pilot-configuration.md §4). */
  hermesModel: string;
  /** `MERI_HERMES_PROVIDER` — pilot default: `custom`. */
  hermesProvider: string;
  /** `MERI_HERMES_BASE_URL` — pilot default: `https://api.openai.com/v1`. */
  hermesBaseUrl: string;
  region: string;
  account: string;
  protectFromDestroy: boolean;
  /** Existing encrypted operational alert topic (same one every other worker construct in this codebase uses). */
  alertsTopic: sns.ITopic;
  /**
   * Optional: the API task's own log group. When supplied, this construct adds
   * a metric filter + alarm over it for the lifecycle service's structured
   * `meri_hermes_worker_provisioning` failure log line (see
   * `MeriHermesWorkerLifecycleService`). Omitted in a standalone/unit-test
   * synth where no API stack exists yet.
   */
  apiLogGroup?: logs.ILogGroup;
}

/**
 * Phase 1 backlog #2 — Hermes worker provisioning + lifecycle, CDK half.
 *
 * This construct provides the FIXED, CDK-managed parts of the worker fleet:
 * the container image/role/logging/static-config template, the shared EFS
 * file system for scope home directories, and narrowly-scoped IAM so the API
 * task can provision workers on demand. It deliberately does NOT itself run
 * any worker — `MeriHermesWorkerLifecycleService` (apps/api) does that at
 * request time via `ecs:RunTask`, because execution scopes (and therefore
 * which EFS access point a given task needs) do not exist at CDK-synth time.
 *
 * ## Why the task definition here is a TEMPLATE, not the thing RunTask uses directly
 *
 * The task asked for "per-scope EFS access point selection... via RunTask
 * overrides, or however ECS actually supports this" and to say plainly if the
 * naive design doesn't work. It doesn't, and this is not a guess:
 *
 * ECS `RunTask`'s `overrides` (`TaskOverride`) supports `containerOverrides`
 * (env/command/cpu/memory per container), `cpu`, `memory`, `taskRoleArn`,
 * `executionRoleArn`, `ephemeralStorage` and `inferenceAcceleratorOverrides`.
 * There is no `volumes` override. A task definition's `volumes[].efsVolumeConfiguration`
 * (including `authorizationConfig.accessPointId`) is fixed at task-definition
 * REGISTRATION time and cannot be swapped per `RunTask` call. So a single
 * shared task definition cannot serve different scopes' EFS access points —
 * the naive "one task def + per-run EFS override" design does not exist in
 * the ECS API.
 *
 * The real alternative (which this construct and `MeriHermesWorkerLifecycleService`
 * implement): **one task definition revision per execution scope**, registered
 * dynamically at first-provision time. `MeriHermesWorkerLifecycleService`
 * calls `DescribeTaskDefinition` on THIS construct's template family, clones
 * the container definition (image/roles/static env/secrets/logging — the
 * single source of truth stays here in CDK), adds a `volumes[]` entry whose
 * `efsVolumeConfiguration.authorizationConfig.accessPointId` is that scope's
 * access point, and calls `RegisterTaskDefinition`. It caches the resulting
 * task definition ARN on `MeriExecutionScope.workerState` and reuses it on
 * later provisions of the same scope instead of re-registering every time.
 * `RunTask` then targets that specific family:revision, with only the truly
 * per-run values (`MERI_EXECUTION_SCOPE_ID`, `MERI_WORKER_TOKEN`,
 * `MERI_SOUL_B64`) passed as `containerOverrides[].environment`.
 *
 * This construct's own `taskDefinition` output therefore has NO EFS volume —
 * it exists so the lifecycle service has a stable, CDK-managed family to
 * clone from, and so `cdk synth` alone proves the container/role/logging
 * shape is valid. It is never RunTask-able as-is for real work (no home
 * directory mounted); do not RunTask this family's un-revised task
 * definition and expect a usable worker.
 *
 * ## Task role scope
 *
 * The worker task role gets exactly two permissions:
 * `elasticfilesystem:ClientMount`/`ClientWrite` scoped to this file system's
 * ARN (required because the EFS volumes registered per-scope use
 * `authorizationConfig.iam: ENABLED`). No S3, DynamoDB, Bedrock or other AWS
 * API access — the plan's "constrained egress" requirement is enforced at the
 * network layer (a dedicated security group with narrow egress: HTTPS out for
 * model-provider calls, NFS to the file system, nothing else) since IAM
 * cannot constrain outbound HTTP to arbitrary internet hosts. Per-scope
 * filesystem ISOLATION is enforced by the access point's `RootDirectory` +
 * POSIX ownership, not by IAM — the shared task role can mount any access
 * point on this file system, but each access point only exposes its own
 * scope's subtree (the standard EFS multi-tenant access-point pattern).
 */
export class MeriHermesWorkerFleet extends Construct {
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly fileSystem: efs.FileSystem;
  readonly workerSecurityGroup: ec2.SecurityGroup;
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: MeriHermesWorkerFleetProps) {
    super(scope, id);
    if (props.subnets.length === 0) {
      throw new Error('The Hermes worker fleet requires at least one private subnet.');
    }
    if (!/^sha256:[0-9a-f]{64}$/i.test(props.workerImageDigest)) {
      throw new Error('The Hermes worker fleet requires an immutable ECR digest.');
    }

    // ---------------------------------------------------------------------
    // Networking: a dedicated, narrowly-egressed security group. Not the
    // shared API service security group (compute-stack.ts imports that one
    // elsewhere as immutable) — the worker's egress needs are different and
    // narrower than the API's, so it gets its own group this construct owns.
    // ---------------------------------------------------------------------
    this.workerSecurityGroup = new ec2.SecurityGroup(this, 'WorkerSecurityGroup', {
      vpc: props.vpc,
      description: 'Meri Hermes worker tasks: constrained egress (HTTPS + NFS only), no inbound from the internet.',
      allowAllOutbound: false,
    });
    // Model-provider APIs (OpenAI/Anthropic/Bedrock) and the broker over HTTPS.
    this.workerSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS egress for model-provider and broker calls',
    );
    // DNS resolution. Not scoped to the VPC CIDR: an imported VPC
    // (`ec2.Vpc.fromVpcAttributes`, the pattern this codebase's other
    // standalone operational stacks use — see meriv2-control-stack.ts) does
    // not always carry a resolvable `vpcCidrBlock`, and DNS-only port 53
    // egress is already far narrower than `allowAllOutbound`.
    this.workerSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(53), 'DNS (TCP)');
    this.workerSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(53), 'DNS (UDP)');

    const efsSecurityGroup = new ec2.SecurityGroup(this, 'EfsSecurityGroup', {
      vpc: props.vpc,
      description: 'Meri Hermes scope home-directory EFS mount targets.',
      allowAllOutbound: false,
    });
    efsSecurityGroup.addIngressRule(this.workerSecurityGroup, ec2.Port.tcp(2049), 'NFS from Hermes worker tasks');
    this.workerSecurityGroup.addEgressRule(efsSecurityGroup, ec2.Port.tcp(2049), 'NFS to the scope home-directory file system');

    // ---------------------------------------------------------------------
    // EFS: one file system, one access point per execution scope (created at
    // runtime by MeriHermesWorkerLifecycleService — scopes don't exist at
    // synth time). Encrypted at rest; IAM-authorized access points required
    // per the task role's ClientMount/ClientWrite grant below.
    // ---------------------------------------------------------------------
    this.fileSystem = new efs.FileSystem(this, 'ScopeHomeFileSystem', {
      vpc: props.vpc,
      vpcSubnets: { subnets: props.subnets },
      securityGroup: efsSecurityGroup,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: props.protectFromDestroy ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---------------------------------------------------------------------
    // Logging
    // ---------------------------------------------------------------------
    this.logGroup = new logs.LogGroup(this, 'WorkerLogs', {
      logGroupName: `/capiro/${props.envName}/meri-hermes-worker`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: props.protectFromDestroy ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---------------------------------------------------------------------
    // Task role: EFS client mount/write only. See class doc for why nothing
    // else lives here.
    // ---------------------------------------------------------------------
    const taskRole = new iam.Role(this, 'WorkerTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Meri Hermes worker task role: EFS client access only, no other AWS API access.',
    });
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
        resources: [this.fileSystem.fileSystemArn],
      }),
    );

    // ---------------------------------------------------------------------
    // Task definition TEMPLATE (see class doc: never RunTask this directly).
    // ---------------------------------------------------------------------
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'WorkerTaskDefTemplate', {
      family: `capiro-${props.envName}-meri-hermes-worker`,
      cpu: 1024, // 1 vCPU
      memoryLimitMiB: 2048, // 2 GiB — measurements.md's recommended starting class
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole,
    });

    const executionRole = this.taskDefinition.obtainExecutionRole();
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [props.apiServerKeySecret.secretArn, props.modelCredentialSecret.secretArn],
      }),
    );

    this.taskDefinition.addContainer('hermes-worker', {
      image: ecs.ContainerImage.fromEcrRepository(props.workerRepo, props.workerImageDigest),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.logGroup, streamPrefix: 'worker' }),
      portMappings: [{ containerPort: 8642 }],
      // Static/shared across every worker (pilot-configuration.md §3). Per-scope
      // values (MERI_EXECUTION_SCOPE_ID, MERI_WORKER_TOKEN, MERI_SOUL_B64) are
      // NEVER baked in here — the lifecycle service injects them as
      // `overrides.containerOverrides[].environment` on every RunTask call, so
      // a stale cached value can never survive past that one task's lifetime.
      environment: {
        MERI_BROKER_URL: props.brokerUrl,
        MERI_HERMES_MODEL: props.hermesModel,
        MERI_HERMES_PROVIDER: props.hermesProvider,
        MERI_HERMES_BASE_URL: props.hermesBaseUrl,
        // Required for native approvals to block instead of auto-deny on the
        // api_server platform (hermes-source-evidence-a.md §8).
        HERMES_EXEC_ASK: '1',
      },
      secrets: {
        API_SERVER_KEY: ecs.Secret.fromSecretsManager(props.apiServerKeySecret),
        [props.modelCredentialEnvName]: ecs.Secret.fromSecretsManager(
          props.modelCredentialSecret,
          props.modelCredentialSecretField,
        ),
      },
      readonlyRootFilesystem: false,
    });

    // ---------------------------------------------------------------------
    // Alarms
    // ---------------------------------------------------------------------
    const action = new cwActions.SnsAction(props.alertsTopic);

    const crashMetric = new logs.MetricFilter(this, 'WorkerCrashMetric', {
      logGroup: this.logGroup,
      metricNamespace: 'Capiro/MeriHermesWorker',
      metricName: 'worker.crashed',
      filterPattern: logs.FilterPattern.anyTerm('Traceback', 'FATAL', 'panic:'),
      metricValue: '1',
      defaultValue: 0,
    }).metric({ statistic: 'Sum', period: cdk.Duration.minutes(5) });

    const crashAlarm = new cloudwatch.Alarm(this, 'WorkerCrashAlarm', {
      alarmName: `capiro-${props.envName}-meri-hermes-worker-crashed`,
      alarmDescription: 'A Meri Hermes worker container logged a crash/fatal signature.',
      metric: crashMetric,
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    crashAlarm.addAlarmAction(action);
    crashAlarm.addOkAction(action);

    if (props.apiLogGroup) {
      // Provisioning happens in the API process (MeriHermesWorkerLifecycleService),
      // not in this construct's own task, so this alarm watches the API's log
      // group for the lifecycle service's structured failure line rather than
      // the worker's log group.
      const provisioningFailedMetric = new logs.MetricFilter(this, 'ProvisioningFailedMetric', {
        logGroup: props.apiLogGroup,
        metricNamespace: 'Capiro/MeriHermesWorker',
        metricName: 'provisioning.failed',
        filterPattern: logs.FilterPattern.literal(
          '{ $.event = "meri_hermes_worker_provisioning" && $.failed = * }',
        ),
        metricValue: '$.failed',
        defaultValue: 0,
      }).metric({ statistic: 'Sum', period: cdk.Duration.minutes(5) });

      const provisioningAlarm = new cloudwatch.Alarm(this, 'ProvisioningFailedAlarm', {
        alarmName: `capiro-${props.envName}-meri-hermes-worker-provisioning-failed`,
        alarmDescription: 'MeriHermesWorkerLifecycleService failed to provision a scope worker.',
        metric: provisioningFailedMetric,
        threshold: 1,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      provisioningAlarm.addAlarmAction(action);
      provisioningAlarm.addOkAction(action);
    }

    new cdk.CfnOutput(this, 'FileSystemId', {
      value: this.fileSystem.fileSystemId,
      description: 'EFS file system id for MERI_HERMES_EFS_FILE_SYSTEM_ID (lifecycle service config).',
    });
    new cdk.CfnOutput(this, 'TaskDefinitionFamily', {
      value: this.taskDefinition.family,
      description: 'ECS task definition family for MERI_HERMES_TASK_DEFINITION_FAMILY (lifecycle service config).',
    });
    new cdk.CfnOutput(this, 'WorkerSecurityGroupId', {
      value: this.workerSecurityGroup.securityGroupId,
      description: 'Security group id for MERI_HERMES_SECURITY_GROUP_ID (lifecycle service RunTask networkConfiguration).',
    });
  }

  /**
   * Grants the lifecycle service's own execution identity (the API task
   * role — NOT this construct's worker task role) exactly what
   * `MeriHermesWorkerLifecycleService` needs: create/describe access points
   * on this file system, register a per-scope task definition revision
   * (with `iam:PassRole` restricted to the two fixed role ARNs this
   * construct created, so the API can only ever launch workers with THESE
   * roles, never an arbitrary one), and run/describe/stop tasks scoped to
   * this specific task definition family via a `ecs:cluster` condition.
   *
   * `ecs:RegisterTaskDefinition` and `ecs:RunTask` do not support
   * resource-level ARN scoping by family in the same way `iam:PassRole`
   * does, so the family-level narrowing here is a defense-in-depth
   * `StringEquals` condition on the resolved cluster ARN, not a hard
   * guarantee the API role can ONLY ever touch Hermes-worker tasks; the
   * `iam:PassRole` restriction to these two specific role ARNs is the real
   * boundary (the API role can never hand a RunTask/RegisterTaskDefinition
   * call broader privileges than these two roles carry).
   */
  grantLifecycleAccess(grantee: iam.IGrantable, clusterArn: string): void {
    this.fileSystem.grant(grantee, 'elasticfilesystem:CreateAccessPoint', 'elasticfilesystem:DescribeAccessPoints');
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['elasticfilesystem:DeleteAccessPoint'],
      resourceArns: [
        `arn:aws:elasticfilesystem:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:access-point/*`,
      ],
      conditions: {
        StringEquals: { 'elasticfilesystem:AccessedViaMountTarget': 'false' },
      },
    });
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['ecs:RegisterTaskDefinition', 'ecs:DescribeTaskDefinition'],
      resourceArns: ['*'], // RegisterTaskDefinition/DescribeTaskDefinition do not support resource-level permissions.
    });
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['iam:PassRole'],
      resourceArns: [this.taskDefinition.taskRole.roleArn, this.taskDefinition.obtainExecutionRole().roleArn],
    });
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['ecs:RunTask'],
      resourceArns: ['*'], // RunTask is authorized against the TASK DEFINITION ARN, not the cluster; scoped below via ecs:cluster.
      conditions: { ArnEquals: { 'ecs:cluster': clusterArn } },
    });
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['ecs:DescribeTasks', 'ecs:StopTask'],
      resourceArns: ['*'],
      conditions: { ArnEquals: { 'ecs:cluster': clusterArn } },
    });
  }
}
