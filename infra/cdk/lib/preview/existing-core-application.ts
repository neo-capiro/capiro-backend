import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { existingCoreBindings } from './existing-core-bindings';
import { previewCoreRuntimeEnvironment } from './core-runtime-environment';

/** Source-only Core proposal borrowing existing resources. No lookup, DB or IAM owner. */
export function existingCorePreviewApplication(input: unknown, outdir: string) {
  const b = existingCoreBindings(input);
  const app = new cdk.App({ outdir });
  const stack = new cdk.Stack(app, 'Capiro-Existing-Database-Preview-Core', {
    env: { account: '967807252336', region: 'us-east-1' },
  });
  // L1 definitions retain exact existing references without adding grant policies.
  const task = new ecs.CfnTaskDefinition(stack, 'CoreTask', {
    family: 'capiro-preview-core-existing-db',
    cpu: '512',
    memory: '1024',
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    executionRoleArn: b.executionRoleArn,
    taskRoleArn: b.taskRoleArn,
    runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
    containerDefinitions: [
      {
        name: 'api',
        image: b.imageUri,
        essential: true,
        command: ['serve'],
        portMappings: [{ containerPort: 4000, protocol: 'tcp' }],
        environment: Object.entries({
          ...previewCoreRuntimeEnvironment(),
          NODE_ENV: 'production',
          DATABASE_URL: '',
          DB_NAME: b.databaseName,
          ASSETS_BUCKET: b.assetsBucket,
          AWS_REGION_DEFAULT: 'us-east-1',
          WEB_ORIGIN: 'https://portfolio-preview.app.capiro.ai',
          CLERK_JWT_ISSUER: 'https://clerk.app.capiro.ai',
          RELEASE_SHA: b.sourceHead,
        }).map(([name, value]) => ({ name, value })),
        secrets: [
          { name: 'DB_HOST', valueFrom: b.dbHostReference },
          { name: 'DB_PORT', valueFrom: b.dbPortReference },
          { name: 'DB_USER', valueFrom: b.dbUserReference },
          { name: 'DB_PASSWORD', valueFrom: b.dbPasswordReference },
          { name: 'CLERK_SECRET_KEY', valueFrom: b.clerkSecretReference },
          { name: 'CLERK_WEBHOOK_SIGNING_SECRET', valueFrom: b.clerkWebhookReference },
        ],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': '/capiro/dev/api',
            'awslogs-region': 'us-east-1',
            'awslogs-stream-prefix': 'preview-core-existing-db',
          },
        },
      },
    ],
  });
  const target = new elb.CfnTargetGroup(stack, 'CoreTarget', {
    vpcId: b.vpcId,
    port: 4000,
    protocol: 'HTTP',
    targetType: 'ip',
    healthCheckPath: '/health',
    healthCheckProtocol: 'HTTP',
    matcher: { httpCode: '200' },
  });
  const service = new ecs.CfnService(stack, 'CoreService', {
    cluster: b.clusterArn,
    serviceName: 'capiro-preview-core-existing-db',
    taskDefinition: task.ref,
    desiredCount: 0,
    launchType: 'FARGATE',
    deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true } },
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: b.subnetIds,
        securityGroups: [b.serviceSecurityGroupId],
        assignPublicIp: 'DISABLED',
      },
    },
    loadBalancers: [{ containerName: 'api', containerPort: 4000, targetGroupArn: target.ref }],
  });
  const rule = new elb.CfnListenerRule(stack, 'CoreHostRoute', {
    listenerArn: b.listenerArn,
    priority: b.listenerPriority,
    conditions: [
      { field: 'host-header', hostHeaderConfig: { values: [b.hostname] } },
      { field: 'path-pattern', pathPatternConfig: { values: ['/api/*', '/health'] } },
    ],
    actions: [{ type: 'forward', targetGroupArn: target.ref }],
  });
  service.addResourceDependency(rule);
  new cdk.CfnOutput(stack, 'PreviewCoreApiBaseUrl', { value: `https://${b.hostname}/api` });
  stack.addMetadata(
    'ActivationGate',
    'Zero tasks; image/schema/auth/roles/network/DNS/TLS/owner review required. No migration or production-service update.',
  );
  return { app, stack, bindings: b };
}
