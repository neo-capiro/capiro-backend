import * as cdk from 'aws-cdk-lib';
import { DataStack } from '../data-stack';
import { AssetsStack } from '../assets-stack';
import { previewConfig } from '../config';
import { previewBindings } from './bindings';
import { PreviewBackendNetwork } from './network-stack';
import { PreviewBackendServices } from './services-stack';

/** Import-safe composition; callers validate metadata before allocating a CDK app. */
export function previewBackendApplication(input: unknown, outdir: string) {
  const bindings = previewBindings(input);
  const cfg = previewConfig(bindings.clerkIssuer);
  const app = new cdk.App({ outdir });
  const env = { account: cfg.account, region: cfg.region };
  const network = new PreviewBackendNetwork(
    app,
    'Capiro-Portfolio-Preview-Backend-Network',
    bindings,
  );
  const data = new DataStack(app, 'Capiro-Portfolio-Preview-Data', {
    env,
    cfg,
    vpc: network.vpc,
    dbSecurityGroup: network.databaseGroup,
  });
  const assets = new AssetsStack(app, 'Capiro-Portfolio-Preview-Assets', { env, cfg });
  const services = new PreviewBackendServices(
    app,
    'Capiro-Portfolio-Preview-Backends',
    bindings,
    network,
    data,
    assets,
  );
  return { app, network, data, assets, services, bindings };
}
