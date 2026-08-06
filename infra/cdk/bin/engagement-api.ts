#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';

import {
  engagementApiNames,
  loadEngagementApiConfig,
} from '../lib/engagement-api/engagement-api-config';
import { EngagementApiNetworkStack } from '../lib/engagement-api/engagement-api-network-stack';
import { EngagementApiRegistryStack } from '../lib/engagement-api/engagement-api-registry-stack';
import { EngagementApiServiceStack } from '../lib/engagement-api/engagement-api-service-stack';

/**
 * Additive CDK app for the dark `engagement-api` service.
 *
 * Completely separate from bin/capiro.ts. That app owns the historical
 * Compute stack, which is frozen in UPDATE_ROLLBACK_FAILED and refers to a
 * deleted phantom ALB (see infra/cdk/DRIFT-FINDINGS.md). This app never
 * deploys, imports, or repairs it: every live resource arrives by explicit
 * identifier from a validated config file.
 *
 * Usage:
 *   ENGAGEMENT_API_INFRA_CONFIG=/abs/path/config.json \
 *     pnpm --dir infra/cdk exec cdk synth \
 *     --app "ts-node --prefer-ts-exts bin/engagement-api.ts"
 *
 * Deployment order is Registry → Network → preview rule → image push →
 * Service, and each step has its own authorization gate. Synthesizing all
 * three stacks is always safe; deploying them is not.
 *
 * The Service stack is only added once the config carries a resolved image
 * digest and release SHA, so `cdk synth` before an authorized push produces
 * the foundation stacks rather than failing.
 */
const app = new cdk.App();

const cfg = loadEngagementApiConfig();
const names = engagementApiNames(cfg);
const env = { account: cfg.accountId, region: cfg.region };

const registry = new EngagementApiRegistryStack(app, names.registryStack, { cfg, env });

const network = new EngagementApiNetworkStack(app, names.networkStack, { cfg, env });

// No dependency between Registry and Network: they touch nothing in common,
// and forcing an order would make a foundation deploy fail as a unit.

if (cfg.imageDigest && cfg.releaseSha) {
  const service = new EngagementApiServiceStack(app, names.serviceStack, {
    cfg,
    env,
    // Passing the attribute lets CDK create and consume the cross-stack export
    // itself, so the export name can never drift from the importValue string.
    targetGroupArn: network.targetGroup.targetGroupArn,
  });
  // The service pulls from the registry and registers into the target group,
  // so both must exist first.
  service.addDependency(registry);
  service.addDependency(network);
} else {
  cdk.Annotations.of(app).addInfo(
    `Service stack omitted: imageDigest and releaseSha are not set. Deploy ${names.registryStack} ` +
      `and ${names.networkStack} first, publish an image, then re-synth with both values.`,
  );
}

app.synth();
