import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface OneShotDefenseBudgetIngestionDrainWorkerProps {
  envName: string;
  apiRepo: ecr.IRepository;
  apiImageDigest: string;
  /** Aurora master credential (host/port) -- same secret the API's other one-off
   * task definitions read DB_HOST/DB_PORT from. This construct's container is
   * dispatched through the same `entrypoint-dispatcher.inc` every other one-off
   * verb runs through, which composes DATABASE_URL from DB_HOST/DB_PORT (master)
   * + DB_USER/DB_PASSWORD (app) + DB_NAME -- never from a single secret's `url`
   * field, which does not exist on either secret. */
  dbSecret: secretsmanager.ISecret;
  /** Aurora app credential (username/password) -- capiro_app role. */
  appDbSecret: secretsmanager.ISecret;
  databaseName: string;
  rawBucketName: string;
  extractionArtifactBucketName: string;
  extractionArtifactPrefix?: string;
  /**
   * KMS key that protects the RAW/EXTRACTION S3 object bytes (SSE-KMS). The raw
   * archive bucket's own bucket policy denies any PutObject that doesn't use
   * this exact key, and reading an SSE-KMS object requires the caller (the
   * task role, not the execution role) to hold kms:Decrypt on it too. Bound at
   * the operations app to the defense-budget-raw archive CMK, NOT the general
   * `capiro/<env>/secrets` alias despite the prop name mirroring the brief's
   * "data KMS key" import.
   */
  dataKeyArn: string;
  /**
   * KMS key that protects the Aurora master/app credential SECRETS at rest
   * (SecretsManager auto-decrypts on GetSecretValue using whichever CMK the
   * secret was created with -- both `/capiro/<env>/aurora/master` and
   * `/capiro/<env>/aurora/app` are created against the DataStack's own CMK,
   * i.e. what config.ts calls the "data" key elsewhere). This is the EXECUTION
   * role's grant, distinct from `dataKeyArn` above which is the TASK role's S3
   * grant -- do not pass the same ARN for both unless they are genuinely the
   * same key in the target account.
   */
  secretsKeyArn: string;
  protectFromDestroy: boolean;
}

/** Manually invoked, finite Phase 10B ingestion drain task. It creates no schedule or service. */
export class OneShotDefenseBudgetIngestionDrainWorker extends Construct {
  readonly taskDefinition: ecs.FargateTaskDefinition;
  constructor(scope: Construct, id: string, props: OneShotDefenseBudgetIngestionDrainWorkerProps) {
    super(scope, id);
    if (!/^sha256:[0-9a-f]{64}$/i.test(props.apiImageDigest)) throw new Error('one-shot ingestion worker requires an immutable ECR digest');
    const prefix = (props.extractionArtifactPrefix ?? 'phase10/parser-artifacts').replace(/^\/+|\/+$/g, '');

    const taskRole = new iam.Role(this, 'TaskRole', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
    // Raw archive bucket: whole-bucket object scope (matches every other reader
    // of this bucket in this codebase -- DocumentRegistrar/RawArchiveService
    // write under raw/incoming/derived, S3SourceDocumentArchiveReadAdapter reads
    // a version-pinned locator back). GetObjectVersion is required because the
    // read adapter always passes an explicit VersionId when the archive result
    // carried one -- reading "whatever is live at that key now" would defeat the
    // whole point of pinning a locator to an exact archived version.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'RawArchiveBucketObjectAccess',
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${props.rawBucketName}/*`],
    }));
    // Extraction artifact bucket + prefix: same three actions, scoped to the
    // exact immutable-key prefix ExtractionArtifactStoreV1 writes/reads under.
    // GetObjectVersion is the fix this PR exists for: S3ExtractionArtifactStore
    // always requires an exact VersionId in its locator (requireVersionId
    // defaults true) and reads it back with GetObjectCommand({VersionId}) --
    // plain GetObject alone cannot satisfy a version-pinned read once any
    // later PUT has landed a newer version at the same key (impossible here
    // since keys are content-addressed by SHA-256, but IAM must still permit
    // the exact API action the SDK calls).
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ExtractionArtifactPrefixObjectAccess',
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${props.extractionArtifactBucketName}/${prefix}/*`],
    }));
    // Bucket-level s3:ListBucket, scoped to the bucket ARN (never bucket/*,
    // which is an OBJECT resource -- ListBucket is a BUCKET-level action and
    // only accepts the bare bucket ARN) with an s3:prefix condition narrowing
    // it to exactly the prefix this task actually touches.
    //
    // WHY THIS IS REQUIRED, NOT DEFENSIVE: S3's HeadObject on a key that does
    // not exist can return a bare 403 Forbidden instead of 404 Not Found when
    // the calling principal lacks s3:ListBucket on the bucket -- S3 conflates
    // "key not found" and "you can't prove whether it exists" into the same
    // ambiguous 403 to avoid leaking key existence to an unauthorized caller.
    // Both S3 stores in this codebase depend on HEAD reliably distinguishing
    // "object missing" from a real permission error on their FIRST write to a
    // brand-new content-addressed key:
    //   - RawArchiveService.archiveOriginal -> private headSafe(key) (raw-
    //     archive.service.ts) HEADs the content-addressed original key BEFORE
    //     the first conditional PUT; headSafe() classifies only NotFound/
    //     NoSuchKey/404 as "absent" and RE-THROWS anything else (including an
    //     ambiguous 403) as a hard failure -- so a first-ever write to a new
    //     document_id/sha256 without ListBucket would fail closed, not open,
    //     but it WOULD fail the very first ingestion of every new document.
    //   - S3ExtractionArtifactStore.putImmutable (extraction-artifact-
    //     store.ts) calls objects.headObject() first; on ANY error from the
    //     subsequent putObject it re-HEADs to distinguish "someone else's
    //     PUT already landed" from a genuine failure -- same 403-vs-404
    //     ambiguity risk on the first-ever write for a new content hash.
    // Code-trace-verified: headSafe() is called from EXACTLY one call site
    // (archiveOriginal, on raw/public/dod-budget/* keys only) -- archiveDerived
    // never HEADs (it PUTs derived/public/dod-budget/* unconditionally), so no
    // additional raw-bucket ListBucket prefix is added beyond raw/public/dod-
    // budget/*.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'RawArchiveBucketList',
      actions: ['s3:ListBucket'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${props.rawBucketName}`],
      conditions: { StringLike: { 's3:prefix': ['raw/public/dod-budget/*'] } },
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ExtractionArtifactBucketList',
      actions: ['s3:ListBucket'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${props.extractionArtifactBucketName}`],
      conditions: { StringLike: { 's3:prefix': [`${prefix}/*`] } },
    }));
    // SSE-KMS on the raw/extraction bucket: the bucket policy denies any
    // PutObject that doesn't use this exact CMK, and any SSE-KMS GetObject
    // requires the reading principal to hold kms:Decrypt on it too.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'RawArchiveObjectEncryptionKeyAccess',
      actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'],
      resources: [props.dataKeyArn],
    }));

    const logGroup = new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_YEAR, removalPolicy: props.protectFromDestroy ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY });
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', { family: `capiro-${props.envName}-defense-budget-ingestion-drain`, cpu: 1024, memoryLimitMiB: 2048, taskRole });

    const executionRole = this.taskDefinition.obtainExecutionRole();
    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'DbSecretRead',
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [props.dbSecret.secretArn, props.appDbSecret.secretArn],
    }));
    // Decrypts the DB secrets' own at-rest encryption, NOT the S3 object key.
    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'DbSecretDecryptionKeyAccess',
      actions: ['kms:Decrypt', 'kms:DescribeKey'],
      resources: [props.secretsKeyArn],
    }));

    this.taskDefinition.addContainer('ingestion-drain', {
      image: ecs.ContainerImage.fromEcrRepository(props.apiRepo, props.apiImageDigest),
      command: ['drain-defense-budget-ingestion-outbox-v1'],
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'worker' }),
      environment: {
        NODE_ENV: props.envName === 'dev' ? 'development' : 'production',
        DB_NAME: props.databaseName,
        DEFENSE_BUDGET_RAW_BUCKET: props.rawBucketName,
        BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET: props.extractionArtifactBucketName,
        BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_PREFIX: prefix,
        // Ephemeral per-task scratch only (Fargate ephemeral storage). Never
        // durable state -- the composed extraction artifact itself persists
        // through BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET above; this
        // root only ever holds the parser runtime's transient working files
        // and this container's own local-parser-run cache, both of which are
        // safe to lose on restart.
        BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT: '/tmp/defense-budget-parser-scratch',
      },
      secrets: {
        // Matches the exact DB_* contract entrypoint-dispatcher.inc composes
        // DATABASE_URL from (host/port from the master secret, username/
        // password from the app secret). This container's command dispatches
        // through that same include -- there is no per-task DATABASE_URL
        // secret field on either credential to read directly.
        DB_HOST: ecs.Secret.fromSecretsManager(props.dbSecret, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(props.dbSecret, 'port'),
        DB_USER: ecs.Secret.fromSecretsManager(props.appDbSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(props.appDbSecret, 'password'),
      },
      readonlyRootFilesystem: false,
    });
    new cdk.CfnOutput(this, 'TaskDefinitionArn', { value: this.taskDefinition.taskDefinitionArn, description: 'Run manually with aws ecs run-task; this construct creates no schedule.' });
  }
}
