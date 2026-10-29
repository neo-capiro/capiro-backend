/**
 * Render-only plan for the existing preview onboarding service.
 *
 * Produces the task definition and service request for the established preview identity
 * (`capiro-preview-onboard-api` in `capiro-dev`, ARM64, container `onboard-api:4400`,
 * `serve`, private subnets, existing target group `capiro-preview-onboard-api`) from
 * explicit immutable bindings. It makes no AWS call, reads no secret and is safe to run
 * as often as needed: the output is a pure function of the bindings.
 *
 * Owner invariants enforced here rather than in a deploy script:
 *   - the database host must be the literal preview clone host, never a secret reference
 *     and never the original onboarding database;
 *   - DB_HOST is not allowed as a secret reference and DATABASE_URL must not override it;
 *   - the command is exactly `serve` (no migrate, lifecycle, hard-delete or worker task);
 *   - the funnel and email presentation holds stay false, so nothing is delivered.
 */

const REGION = 'us-east-1';
const ACCOUNT = '967807252336';
const CLUSTER = 'capiro-dev';
const SERVICE = 'capiro-preview-onboard-api';
const FAMILY = 'capiro-preview-onboard-api';
const CONTAINER = 'onboard-api';
const PORT = 4400;
const CLONE_HOST = /^capiro-newstack-preview-clone\.[a-z0-9.-]+\.rds\.amazonaws\.com$/;
const IMAGE = new RegExp(`^${ACCOUNT}\\.dkr\\.ecr\\.${REGION}\\.amazonaws\\.com/capiro/(?:[a-z0-9-]+/)*(?:preview-)?onboard-api$`);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SOURCE = /^[0-9a-f]{40}$/;
const ARN = /^arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:.+$/;
const TARGET_GROUP = new RegExp(`^arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/${SERVICE}/[0-9a-f]{16}$`);
const SECRET_REF = new RegExp(`^arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:[A-Za-z0-9/_-]+$`);

const fail = (reason) => {
  throw new Error(`ONBOARD_PREVIEW_PLAN_INVALID:${reason}`);
};

const ALLOWED_BINDING_KEYS = [
  'image',
  'imageDigest',
  'source',
  'cloneDbHost',
  'subnets',
  'securityGroups',
  'executionRoleArn',
  'taskRoleArn',
  'targetGroupArn',
  'env',
  'secrets',
];

const requiredString = (value, reason) => {
  if (typeof value !== 'string' || value.length === 0) fail(reason);
  return value;
};

/** Env keys the onboarding API reads, rendered in a fixed order for idempotency. */
const ENV_KEYS = [
  'ONBOARD_PORT',
  'ONBOARD_BIND_HOST',
  'CAPIRO_ENV',
  'DB_NAME',
  'APP_ENV',
  'ONBOARD_APP_BASE_URL',
  'ONBOARD_APPS_API_BASE',
  'ONBOARD_API_PUBLIC_BASE_URL',
  'ONBOARD_PUBLIC_BASE_URL',
  'BILLING_RETURN_URL',
  'ONBOARD_FUNNEL_ENABLED',
  'ONBOARD_EMAIL_ENABLED',
  'ONBOARD_EMAIL_FROM',
  'ONBOARD_CS_NOTIFY_EMAIL',
  'ONBOARD_WIRE_DUE_DAYS',
  'CLERK_JWT_ISSUER',
  'CLERK_PUBLISHABLE_KEY',
  'STRIPE_PRICE_SLOTS',
  'STRIPE_PRICE_OVERAGE',
  'STRIPE_OVERAGE_METER_EVENT',
  'STRIPE_PUBLISHABLE_KEY',
];

/** Secret references the onboarding API needs, rendered in a fixed order. */
const SECRET_KEYS = [
  'DB_USER',
  'DB_PASSWORD',
  'CLERK_SECRET_KEY',
  'OAUTH_STATE_SECRET',
  'INTERNAL_SERVICE_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'MICROSOFT_CLIENT_ID',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
];

export function renderOnboardPreviewPlan(bindings) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings))
    fail('bindings');
  // Closed binding set: a caller cannot inject a command, a public IP or a log target.
  for (const key of Object.keys(bindings))
    if (!ALLOWED_BINDING_KEYS.includes(key)) fail(`binding-key:${key}`);

  const image = requiredString(bindings.image, 'image');
  if (!IMAGE.test(image)) fail('image-repository');
  const digest = requiredString(bindings.imageDigest, 'imageDigest');
  if (!DIGEST.test(digest)) fail('image-digest');
  const source = requiredString(bindings.source, 'source');
  if (!SOURCE.test(source)) fail('source');

  const cloneDbHost = requiredString(bindings.cloneDbHost, 'cloneDbHost');
  if (SECRET_REF.test(cloneDbHost) || !CLONE_HOST.test(cloneDbHost)) fail('clone-db-host');

  const subnets = bindings.subnets;
  if (!Array.isArray(subnets) || subnets.length < 2 || subnets.some((id) => !/^subnet-[0-9a-f]{8,17}$/.test(id)))
    fail('subnets');
  const securityGroups = bindings.securityGroups;
  if (!Array.isArray(securityGroups) || securityGroups.length < 1
      || securityGroups.some((id) => !/^sg-[0-9a-f]{8,17}$/.test(id)))
    fail('security-groups');

  for (const key of ['executionRoleArn', 'taskRoleArn', 'targetGroupArn'])
    if (!ARN.test(requiredString(bindings[key], key))) fail(key);
  if (!TARGET_GROUP.test(bindings.targetGroupArn)) fail('target-group');

  const env = bindings.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('env');
  for (const key of Object.keys(env)) if (!ENV_KEYS.includes(key)) fail(`env-key:${key}`);
  for (const key of ENV_KEYS) if (!Object.hasOwn(env, key)) fail(`env-missing:${key}`);
  for (const [key, value] of Object.entries(env))
    if (typeof value !== 'string' || /[\u0000-\u001f]/.test(value)) fail(`env-value:${key}`);
  // Presentation and delivery holds are not authorization; keep them off in this cohort.
  if (env.ONBOARD_FUNNEL_ENABLED !== 'false') fail('funnel-hold');
  if (env.ONBOARD_EMAIL_ENABLED !== 'false') fail('email-hold');

  const secrets = bindings.secrets;
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) fail('secrets');
  for (const key of Object.keys(secrets)) if (!SECRET_KEYS.includes(key)) fail(`secret-key:${key}`);
  for (const key of SECRET_KEYS)
    if (!SECRET_REF.test(requiredString(secrets[key], `secret:${key}`))) fail(`secret-ref:${key}`);

  const containerEnvironment = [
    ...ENV_KEYS.map((name) => ({ name, value: env[name] })),
    // The literal clone host is the only database address; DB_HOST is never a secret ref.
    { name: 'DB_HOST', value: cloneDbHost },
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const containerSecrets = SECRET_KEYS.map((name) => ({ name, valueFrom: secrets[name] }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const taskDefinition = {
    family: FAMILY,
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: '512',
    memory: '1024',
    runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
    executionRoleArn: bindings.executionRoleArn,
    taskRoleArn: bindings.taskRoleArn,
    containerDefinitions: [
      {
        name: CONTAINER,
        image: `${image}@${digest}`,
        essential: true,
        command: ['serve'],
        portMappings: [{ containerPort: PORT, protocol: 'tcp' }],
        environment: containerEnvironment,
        secrets: containerSecrets,
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': `/capiro/portfolio-preview`,
            'awslogs-region': REGION,
            'awslogs-stream-prefix': SERVICE,
          },
        },
      },
    ],
    tags: [
      { key: 'capiro:purpose', value: 'portfolio-preview' },
      { key: 'capiro:source', value: source },
    ],
  };

  const service = {
    cluster: CLUSTER,
    serviceName: SERVICE,
    taskDefinition: `${FAMILY}:<registered-revision>`,
    desiredCount: 1,
    launchType: 'FARGATE',
    platformVersion: 'LATEST',
    healthCheckGracePeriodSeconds: 60,
    deploymentConfiguration: { minimumHealthyPercent: 0, maximumPercent: 200 },
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets,
        securityGroups,
        assignPublicIp: 'DISABLED',
      },
    },
    loadBalancers: [
      { targetGroupArn: bindings.targetGroupArn, containerName: CONTAINER, containerPort: PORT },
    ],
  };

  return {
    schemaVersion: 1,
    kind: 'onboard-preview-service-plan',
    source,
    imageDigest: digest,
    taskDefinition,
    service,
    notes: {
      database: 'literal preview clone host; DB_HOST is never a secret reference',
      command: 'serve only; no migrate, lifecycle, hard-delete or worker entrypoint',
      holds: 'funnel and email disabled; no billing sends, provider activation or invitations',
      targetGroup: `${SERVICE} health /health on port ${PORT}`,
      identity: `${CLUSTER}/${SERVICE} ARM64 FARGATE, private subnets, no public IP`,
    },
  };
}
