#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { awsEnv, commonTags, loadConfig, stackName } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { DnsStack } from '../lib/dns-stack';
import { SecretsStack } from '../lib/secrets-stack';
import { ComputeStack } from '../lib/compute-stack';
import { MemoryProjectionWorkerStack } from '../lib/memory-projection-worker-stack';
import { AlarmsStack } from '../lib/alarms-stack';
import { MeriV2ControlStack } from '../lib/meriv2-control-stack';
import { AssetsStack } from '../lib/assets-stack';

/**
 * Capiro CDK app. Stacks are deployed in dependency order:
 *   Network → Dns → Data → Secrets → Compute → Alarms
 *   → MemoryProjectionWorker → MeriV2Control
 *
 * `cdk deploy --all --context env=dev --context account=<id>` will respect
 * the dependency graph below. Individual stacks can also be deployed by
 * name when iterating. Both new scheduled MeriV2 tasks remain dark unless
 * their exact enable contexts are supplied. An armed schedule also requires
 * `meriv2ApiImageTag` to be the exact 40-character release SHA—not `latest`.
 */
const app = new cdk.App();
const cfg = loadConfig(app);
const env = awsEnv(cfg);
const tags = commonTags(cfg);

const network = new NetworkStack(app, stackName(cfg.envName, 'Network'), { env, tags, cfg });

const dns = new DnsStack(app, stackName(cfg.envName, 'Dns'), { env, tags, cfg });

const data = new DataStack(app, stackName(cfg.envName, 'Data'), {
  env,
  tags,
  cfg,
  vpc: network.vpc,
  dbSecurityGroup: network.dbSecurityGroup,
});
data.addDependency(network);

const secrets = new SecretsStack(app, stackName(cfg.envName, 'Secrets'), {
  env,
  tags,
  cfg,
});

const assets = new AssetsStack(app, stackName(cfg.envName, 'Assets'), {
  env,
  tags,
  cfg,
});

const compute = new ComputeStack(app, stackName(cfg.envName, 'Compute'), {
  env,
  tags,
  cfg,
  vpc: network.vpc,
  albSecurityGroup: network.albSecurityGroup,
  serviceSecurityGroup: network.serviceSecurityGroup,
  dbCluster: data.cluster,
  dbSecret: data.secret,
  appDbSecret: data.appSecret,
  databaseName: data.databaseName,
  dataKey: data.key,
  secretsStack: secrets,
  certificate: dns.certificate,
  apexCertificate: dns.apexCertificate,
  hostedZone: dns.hostedZone,
  assetsStack: assets,
});
compute.addDependency(network);
compute.addDependency(dns);
compute.addDependency(data);
compute.addDependency(secrets);
compute.addDependency(assets);

const alarms = new AlarmsStack(app, stackName(cfg.envName, 'Alarms'), {
  env,
  tags,
  cfg,
  // CDK exposes pre-formatted dimension strings via `*FullName`. These
  // resolve cross-stack via CFN intrinsic functions so the alarm dimensions
  // stay in sync as CDK regenerates resource ids.
  albFullName: compute.alb.loadBalancerFullName,
  apiTargetGroupFullName: compute.apiTargetGroup.targetGroupFullName,
  webTargetGroupFullName: compute.webTargetGroup.targetGroupFullName,
  marketingTargetGroupFullName: compute.marketingTargetGroup.targetGroupFullName,
  ecsClusterName: compute.cluster.clusterName,
  apiServiceName: compute.apiService.serviceName,
  webServiceName: compute.webService.serviceName,
  marketingServiceName: compute.marketingService.serviceName,
  auroraClusterIdentifier: data.cluster.clusterIdentifier,
  alertEmails: app.node.tryGetContext('alertEmails') as string | undefined,
});
alarms.addDependency(compute);
alarms.addDependency(data);

const memoryProjectionWorkerEnabled = exactTrue(
  app.node.tryGetContext('enableMemoryProjectionWorker'),
);
const controlMonitorEnabled = exactTrue(app.node.tryGetContext('enableMeriV2ControlMonitor'));
const meriv2ApiImageTag =
  String(app.node.tryGetContext('meriv2ApiImageTag') ?? '').trim() || 'latest';
assertImageTag(meriv2ApiImageTag, memoryProjectionWorkerEnabled || controlMonitorEnabled);

const memoryProjectionWorker = new MemoryProjectionWorkerStack(
  app,
  stackName(cfg.envName, 'MemoryProjectionWorker'),
  {
    env,
    tags,
    cfg,
    cluster: compute.cluster,
    apiRepo: compute.apiRepo,
    apiImageTag: meriv2ApiImageTag,
    serviceSecurityGroup: network.serviceSecurityGroup,
    dbSecret: data.secret,
    appDbSecret: data.appSecret,
    databaseName: data.databaseName,
    dataKey: data.key,
    secretsKey: secrets.secretsKey,
    scheduleEnabled: memoryProjectionWorkerEnabled,
    alertsTopic: alarms.alertsTopic,
  },
);
memoryProjectionWorker.addDependency(network);
memoryProjectionWorker.addDependency(data);
memoryProjectionWorker.addDependency(secrets);
memoryProjectionWorker.addDependency(compute);
memoryProjectionWorker.addDependency(alarms);

const meriV2Control = new MeriV2ControlStack(
  app,
  stackName(cfg.envName, 'MeriV2Control'),
  {
    env,
    tags,
    cfg,
    cluster: compute.cluster,
    apiRepo: compute.apiRepo,
    apiImageTag: meriv2ApiImageTag,
    securityGroup: network.serviceSecurityGroup,
    dbSecret: data.secret,
    appDbSecret: data.appSecret,
    databaseName: data.databaseName,
    dataKey: data.key,
    secretsKey: secrets.secretsKey,
    alertsTopic: alarms.alertsTopic,
    monitorEnabled: controlMonitorEnabled,
  },
);
meriV2Control.addDependency(network);
meriV2Control.addDependency(data);
meriV2Control.addDependency(secrets);
meriV2Control.addDependency(compute);
meriV2Control.addDependency(memoryProjectionWorker);
meriV2Control.addDependency(alarms);

app.synth();

function exactTrue(value: unknown): boolean {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function assertImageTag(tag: string, scheduledTaskArmed: boolean): void {
  const validDockerTag = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag);
  if (!validDockerTag) {
    throw new Error('meriv2ApiImageTag is not a valid ECR image tag.');
  }
  if (scheduledTaskArmed && !/^[0-9a-f]{40}$/i.test(tag)) {
    throw new Error(
      'Arming a MeriV2 scheduled task requires meriv2ApiImageTag to equal the exact 40-character release SHA; mutable tags such as latest are refused.',
    );
  }
}
