import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { commonTags, type EnvConfig } from './config';

export interface DataStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
}

/**
 * Aurora Serverless v2 (Postgres 16) + pgvector. Lives in isolated subnets.
 *
 * - Multi-AZ writer + reader (the reader doubles as failover and reporting).
 * - Custom DB cluster parameter group preloads the extensions Capiro relies
 *   on so application migrations don't need superuser to CREATE EXTENSION.
 *   `vector` and `pg_trgm` ship as preloaded shared libraries; the migrations
 *   `CREATE EXTENSION IF NOT EXISTS` calls just register them in the database.
 * - Master credential rotation: 30-day schedule via Secrets Manager.
 * - PITR + 35-day backup retention by default; deletion protection on prod.
 */
export class DataStack extends cdk.Stack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly databaseName: string;
  public readonly secret: secretsmanager.ISecret;
  /**
   * Runtime application credential. The API connects as `capiro_app`, a
   * non-DDL role created by migration 0005. The actual password is set by
   * the `bootstrap-roles` ECS task (which connects as master and runs
   * ALTER ROLE), this Secret holds the source-of-truth value.
   */
  public readonly appSecret: secretsmanager.ISecret;
  /**
   * Phase 7 Workstream N. `capiro_pe_promoter` credential — the least-privilege
   * role that alone may write canonical snapshot rows (Workstream D). Same
   * pattern as `appSecret`: this Secret holds the source-of-truth value, and
   * `bootstrap-roles` (already supports `PROMOTER_USER`/`PROMOTER_PASSWORD` as
   * of Workstream D — confirmed in `apps/api/scripts/bootstrap-roles.ts`)
   * rotates the actual DB role's password to match when it runs. Extends the
   * existing bootstrap-roles/separate-secret mechanism rather than inventing a
   * parallel one — see `docs/defense-budget/PHASE-7-PRE-IMPLEMENTATION-DEPENDENCY-MAP.md`
   * §5, which calls this "a significant favourable finding" for exactly this
   * reason.
   */
  public readonly promoterSecret: secretsmanager.ISecret;
  public readonly key: kms.Key;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { cfg, vpc, dbSecurityGroup } = props;
    this.databaseName = 'capiro';

    Object.entries(commonTags(cfg)).forEach(([k, v]) => cdk.Tags.of(this).add(k, v));

    this.key = new kms.Key(this, 'DataKey', {
      alias: `alias/capiro/${cfg.envName}/data`,
      description: `Capiro ${cfg.envName} Aurora + DB-related encryption CMK`,
      enableKeyRotation: true,
      removalPolicy: cfg.protectFromDestroy ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Cluster parameter group, preload pgvector + pg_trgm. The application
    // migration still runs CREATE EXTENSION to register them in the database.
    const parameterGroup = new rds.ParameterGroup(this, 'DbParameterGroup', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      description: 'Capiro Aurora Postgres 16 with pgvector and pg_trgm preloaded',
      parameters: {
        // Aurora Postgres only allows a fixed list of extensions in
        // shared_preload_libraries (pg_stat_statements, pg_cron, pgaudit, ...).
        // pgvector and pg_trgm don't need preloading, they are created via
        // CREATE EXTENSION in the application migrations.
        shared_preload_libraries: 'pg_stat_statements',
        'rds.force_ssl': '1',
        // Logging tuned for SOC 2 evidence: log everything that writes, plus
        // slow queries. Verbose enough for audit, not so verbose it dominates
        // CloudWatch Logs spend.
        log_statement: 'mod',
        log_min_duration_statement: '1000',
      },
    });

    const masterSecret = new secretsmanager.Secret(this, 'DbMasterSecret', {
      secretName: `/capiro/${cfg.envName}/aurora/master`,
      description: 'Capiro Aurora master credentials',
      encryptionKey: this.key,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'capiro_master' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: cfg.protectFromDestroy ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.secret = masterSecret;

    this.cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      credentials: rds.Credentials.fromSecret(masterSecret),
      defaultDatabaseName: this.databaseName,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup as ec2.SecurityGroup],
      parameterGroup,
      storageEncrypted: true,
      storageEncryptionKey: this.key,
      backup: {
        retention: cdk.Duration.days(cfg.auroraBackupRetentionDays),
      },
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_YEAR,
      iamAuthentication: true,
      deletionProtection: cfg.protectFromDestroy,
      removalPolicy: cfg.protectFromDestroy ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      serverlessV2MinCapacity: cfg.auroraMinAcu,
      serverlessV2MaxCapacity: cfg.auroraMaxAcu,
      writer: rds.ClusterInstance.serverlessV2('writer', {
        publiclyAccessible: false,
        enablePerformanceInsights: true,
        performanceInsightEncryptionKey: this.key,
      }),
      readers: [
        rds.ClusterInstance.serverlessV2('reader1', {
          publiclyAccessible: false,
          enablePerformanceInsights: true,
          performanceInsightEncryptionKey: this.key,
          scaleWithWriter: true,
        }),
      ],
    });

    // `Credentials.fromSecret(masterSecret)` attaches the secret to the cluster
    // automatically, calling masterSecret.attach() again throws.
    masterSecret.addRotationSchedule('Rotation', {
      hostedRotation: secretsmanager.HostedRotation.postgreSqlSingleUser({
        functionName: `capiro-${cfg.envName}-aurora-rotation`,
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [dbSecurityGroup as ec2.SecurityGroup],
      }),
      automaticallyAfter: cdk.Duration.days(30),
    });

    // App-role credential. Auto-generated password (32 chars, alphanumeric)
    // so the bootstrap-roles task can use it as a SQL literal without extra
    // escaping. The Secrets Manager value is the source of truth; the actual
    // DB role's password is rotated to match by bootstrap-roles.
    const appSecret = new secretsmanager.Secret(this, 'DbAppSecret', {
      secretName: `/capiro/${cfg.envName}/aurora/app`,
      description: 'Capiro Aurora capiro_app runtime credentials',
      encryptionKey: this.key,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'capiro_app' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: cfg.protectFromDestroy ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.appSecret = appSecret;

    // Phase 7 Workstream N — the promoter's own secret, deliberately separate
    // from both master (DDL) and app (general serve). No LLM/vendor/parser
    // secrets attach to this role's task; this Secret is the only credential
    // it needs.
    const promoterSecret = new secretsmanager.Secret(this, 'PromoterSecret', {
      secretName: `/capiro/${cfg.envName}/aurora/promoter`,
      description:
        'Capiro Aurora capiro_pe_promoter runtime credentials (Phase 7 canonical promotion)',
      encryptionKey: this.key,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'capiro_pe_promoter' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: cfg.protectFromDestroy ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.promoterSecret = promoterSecret;

    new cdk.CfnOutput(this, 'AuroraEndpoint', { value: this.cluster.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, 'AuroraSecretArn', { value: masterSecret.secretArn });
    new cdk.CfnOutput(this, 'AuroraAppSecretArn', { value: appSecret.secretArn });
    new cdk.CfnOutput(this, 'AuroraPromoterSecretArn', { value: promoterSecret.secretArn });
  }
}
