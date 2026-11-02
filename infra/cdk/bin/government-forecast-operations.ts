#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { GovernmentForecastOperationsStack } from '../lib/government-forecast-operations-stack';

// Independent operations app: never deploy the drifted shared Compute stack.
const app = new App();
new GovernmentForecastOperationsStack(app, 'Capiro-preview-GovernmentForecastOperations', {
  env: { account: '967807252336', region: 'us-east-1' },
  terminationProtection: true,
});
