/** Explicit metadata for the already-approved existing-database route; never secret values. */
export interface ExistingCoreBindings {
  clusterArn: string;
  vpcId: string;
  subnetIds: string[];
  serviceSecurityGroupId: string;
  executionRoleArn: string;
  taskRoleArn: string;
  listenerArn: string;
  hostname: string;
  listenerPriority: number;
  imageUri: string;
  sourceHead: string;
  databaseName: string;
  assetsBucket: string;
  dbHostReference: string;
  dbPortReference: string;
  dbUserReference: string;
  dbPasswordReference: string;
  clerkSecretReference: string;
  clerkWebhookReference: string;
}
const keys = [
  'clusterArn',
  'vpcId',
  'subnetIds',
  'serviceSecurityGroupId',
  'executionRoleArn',
  'taskRoleArn',
  'listenerArn',
  'hostname',
  'listenerPriority',
  'imageUri',
  'sourceHead',
  'databaseName',
  'assetsBucket',
  'dbHostReference',
  'dbPortReference',
  'dbUserReference',
  'dbPasswordReference',
  'clerkSecretReference',
  'clerkWebhookReference',
];
const account = '967807252336';
const region = 'us-east-1';
function text(value: unknown, pattern: RegExp): string {
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    /[\u0000-\u0020\u007f]/.test(value) ||
    !pattern.test(value)
  ) {
    throw new Error('Invalid existing Core public metadata');
  }
  return value;
}
export function existingCoreBindings(value: unknown): ExistingCoreBindings {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== [...keys].sort().join('|')
  ) {
    throw new Error('Closed existing Core metadata required');
  }
  const x = value as Record<string, unknown>;
  if (
    !Array.isArray(x.subnetIds) ||
    x.subnetIds.length < 2 ||
    x.subnetIds.length > 3 ||
    new Set(x.subnetIds).size !== x.subnetIds.length
  ) {
    throw new Error('Distinct existing private subnets required');
  }
  // Priorities below generic /api routing are required. Availability is an owner readback gate.
  if (
    !Number.isInteger(x.listenerPriority) ||
    Number(x.listenerPriority) < 1 ||
    Number(x.listenerPriority) > 4
  )
    throw new Error('Dedicated early host rule required');
  const arn = `arn:aws:secretsmanager:${region}:${account}:secret:`;
  const databaseReference = (field: string, family: string, property: string) =>
    text(x[field], new RegExp(`^${arn}/capiro/dev/aurora/${family}-[A-Za-z0-9]{6}:${property}::$`));
  return {
    clusterArn: text(x.clusterArn, /^arn:aws:ecs:us-east-1:967807252336:cluster\/capiro-dev$/),
    vpcId: text(x.vpcId, /^vpc-[0-9a-f]{17}$/),
    subnetIds: x.subnetIds.map((s) => text(s, /^subnet-[0-9a-f]{17}$/)),
    serviceSecurityGroupId: text(x.serviceSecurityGroupId, /^sg-[0-9a-f]{17}$/),
    executionRoleArn: text(
      x.executionRoleArn,
      /^arn:aws:iam::967807252336:role\/[A-Za-z0-9_+=,.@/-]+$/,
    ),
    taskRoleArn: text(x.taskRoleArn, /^arn:aws:iam::967807252336:role\/[A-Za-z0-9_+=,.@/-]+$/),
    listenerArn: text(
      x.listenerArn,
      /^arn:aws:elasticloadbalancing:us-east-1:967807252336:listener\/app\/capiro-prod-alb\/[0-9a-f]{16}\/[0-9a-f]{16}$/,
    ),
    // This is a proposal hostname, not an assertion of DNS/TLS admission.
    hostname: text(x.hostname, /^core-preview\.capiro\.ai$/),
    listenerPriority: Number(x.listenerPriority),
    imageUri: text(
      x.imageUri,
      /^967807252336\.dkr\.ecr\.us-east-1\.amazonaws\.com\/capiro\/dev\/api@sha256:[0-9a-f]{64}$/,
    ),
    sourceHead: text(x.sourceHead, /^[0-9a-f]{40}$/),
    databaseName: text(x.databaseName, /^capiro$/),
    assetsBucket: text(x.assetsBucket, /^capiro-dev-tenant-assets-967807252336$/),
    dbHostReference: databaseReference('dbHostReference', 'master', 'host'),
    dbPortReference: databaseReference('dbPortReference', 'master', 'port'),
    dbUserReference: databaseReference('dbUserReference', 'app', 'username'),
    dbPasswordReference: databaseReference('dbPasswordReference', 'app', 'password'),
    clerkSecretReference: text(
      x.clerkSecretReference,
      new RegExp(`^${arn}/capiro/dev/clerk/secret-key-[A-Za-z0-9]{6}$`),
    ),
    clerkWebhookReference: text(
      x.clerkWebhookReference,
      new RegExp(`^${arn}/capiro/dev/clerk/webhook-signing-secret-[A-Za-z0-9]{6}$`),
    ),
  };
}
