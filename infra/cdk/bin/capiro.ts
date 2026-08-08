#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { awsEnv, commonTags, loadConfig, stackName } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { DnsStack } from '../lib/dns-stack';
import { SecretsStack } from '../lib/secrets-stack';
import { ComputeStack } from '../lib/compute-stack';
import { AlarmsStack } from '../lib/alarms-stack';
import { AssetsStack } from '../lib/assets-stack';

/**
 * Primary Capiro infrastructure app. Stacks are deployed in dependency order:
 *   Network → Dns → Data → Secrets → Assets → Compute → Alarms
 *
 * IMPORTANT: the live environment named `dev` serves production traffic and its
 * historical Compute stack is drifted/frozen. Do not use `cdk deploy --all` as
 * the MeriV2 release path. The governed-memory projection worker and MeriV2
 * control monitor are deliberately owned only by `bin/meriv2-operations.ts`,
 * which imports live resources by literal identifier and cannot mutate this
 * app's DNS, ALB, Aurora, or long-running ECS services.
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
  promoterDbSecret: data.promoterSecret,
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

app.synth();
