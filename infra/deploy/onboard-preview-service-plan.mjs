/**
 * Render-only plan for the existing preview onboarding service.
 *
 * Produces (a) the task-definition input for `RegisterTaskDefinition` and (b) the
 * separate `CreateService` / `UpdateService` inputs from explicit immutable bindings.
 * It makes no AWS call, reads no secret, and its output is a pure function of the
 * bindings.
 *
 * Owner invariants enforced here rather than in a deploy script:
 *   - the five fields the serve entrypoint requires (DB_HOST, DB_PORT, DB_USER,
 *     DB_PASSWORD, DB_NAME) are rendered; DATABASE_URL is composed by the entrypoint
 *     from them and must never be supplied;
 *   - the database address is the literal preview clone; a secret reference or the
 *     original onboarding cluster is refused, and the ordinary application credential
 *     stays separate from the migration/admin credential;
 *   - existing ECS reference syntax is preserved verbatim, including the ARN JSON-key
 *     selectors and a pinned version for the internal service secret;
 *   - held provider credentials (Stripe, OAuth state, Microsoft, Google) are omitted
 *     rather than required, so no billing or IT provider client is constructed;
 *   - the command is exactly `serve` — no migrate, lifecycle or worker entrypoint;
 *   - operational shape follows the canonical serve task: the existing log group,
 *     container health check and circuit-breaker recovery settings are preserved.
 */

const REGION = 'us-east-1';
const ACCOUNT = '967807252336';
const CLUSTER = 'capiro-dev';
const SERVICE = 'capiro-preview-onboard-api';
const FAMILY = 'capiro-preview-onboard-api';
const CONTAINER = 'onboard-api';
const PORT = 4400;
const DB_PORT = '5432';
const LOG_GROUP = '/capiro/dev/onboard-api';
const LOG_PREFIX = 'onboard-api';
const CLONE_HOST = /^capiro-newstack-preview-clone\.[a-z0-9.-]+\.rds\.amazonaws\.com$/;
const IMAGE = new RegExp(`^${ACCOUNT}\\.dkr\\.ecr\\.${REGION}\\.amazonaws\\.com/capiro/(?:[a-z0-9-]+/)*(?:preview-)?onboard-api$`);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SOURCE = /^[0-9a-f]{40}$/;
const ARN = /^arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:.+$/;
const TASK_DEF_ARN = new RegExp(`^arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/${FAMILY}:[1-9]\\d*$`);
const TARGET_GROUP = new RegExp(`^arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/${SERVICE}/[0-9a-f]{16}$`);
const DB_NAME = /^[a-z][a-z0-9_]{2,62}$/;
const PUBLISHABLE_KEY = /^pk_(?:test|live)_[A-Za-z0-9]{8,}$/;

// Secrets Manager reference: name plus up to three optional `:` selector segments
// (json-key, version-stage, version-id). The generated ARN tail carries a `-XXXXXX`
// suffix without a colon, so the name itself never contains one.
const SECRET_ARN = new RegExp(`^arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:[A-Za-z0-9/_-]+((:[A-Za-z0-9/_.-]*){0,3})$`);
const PINNED_VERSION = /^(?:[A-Za-z0-9][A-Za-z0-9-]{15,}|AWSCURRENT|AWSPREVIOUS)$/;

const fail = (reason) => {
  throw new Error(`ONBOARD_PREVIEW_PLAN_INVALID:${reason}`);
};

const ALLOWED_BINDING_KEYS = [
  'image',
  'imageDigest',
  'source',
  'cloneDbHost',
  'dbName',
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

/** Non-secret environment the serve entrypoint and the app read. Fixed render order. */
const ENV_KEYS = [
  'AWS_REGION_DEFAULT',
  'BILLING_RETURN_URL',
  'CAPIRO_ENV',
  'CLERK_JWT_ISSUER',
  'CLERK_PUBLISHABLE_KEY',
  'ONBOARD_APP_BASE_URL',
  'ONBOARD_APPS_API_BASE',
  'ONBOARD_API_PUBLIC_BASE_URL',
  'ONBOARD_BIND_HOST',
  'ONBOARD_CS_NOTIFY_EMAIL',
  'ONBOARD_EMAIL_ENABLED',
  'ONBOARD_EMAIL_FROM',
  'ONBOARD_FUNNEL_ENABLED',
  'ONBOARD_PORT',
  'ONBOARD_PUBLIC_BASE_URL',
  'ONBOARD_WIRE_DUE_DAYS',
];

/** Credentials the held preview posture requires; provider credentials are omitted. */
const REQUIRED_SECRET_KEYS = ['CLERK_SECRET_KEY', 'DB_PASSWORD', 'DB_USER', 'INTERNAL_SERVICE_SECRET'];

/** Held provider credentials: refused so no billing or IT client is constructed. */
const HELD_SECRET_KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'OAUTH_STATE_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

/** Held provider configuration: refused together with the credentials it pairs with. */
const HELD_ENV_KEYS = [
  'GOOGLE_CLIENT_ID',
  'MICROSOFT_CLIENT_ID',
  'STRIPE_OVERAGE_METER_EVENT',
  'STRIPE_PRICE_OVERAGE',
  'STRIPE_PRICE_SLOTS',
  'STRIPE_PUBLISHABLE_KEY',
];

function validateSecretReference(key, valueFrom) {
  if (!SECRET_ARN.test(valueFrom)) fail(`secret-ref:${key}`);
  if (key === 'DB_USER' && !/:username::$/.test(valueFrom)) fail('db-user-selector');
  if (key === 'DB_PASSWORD' && !/:password::$/.test(valueFrom)) fail('db-password-selector');
  // Ordinary application credentials only: the cluster master belongs to the migration owner.
  if (/aurora\/master/.test(valueFrom)) fail(`admin-credential:${key}`);
  if (key === 'INTERNAL_SERVICE_SECRET') {
    // Pinned form is name + json-key + stage + version-id, with the version last.
    const trailing = valueFrom.split(':').slice(7);
    if (trailing.length !== 3) fail('internal-version-pin');
    const versionId = trailing[2];
    if (!versionId || !PINNED_VERSION.test(versionId)) fail('internal-version-pin');
  }
}

function validateBindings(bindings) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) fail('bindings');
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
  if (SECRET_ARN.test(cloneDbHost) || !CLONE_HOST.test(cloneDbHost)) fail('clone-db-host');
  const dbName = requiredString(bindings.dbName, 'dbName');
  if (!DB_NAME.test(dbName)) fail('db-name');

  const subnets = bindings.subnets;
  if (!Array.isArray(subnets) || subnets.length < 2 || subnets.some((id) => !/^subnet-[0-9a-f]{8,17}$/.test(id)))
    fail('subnets');
  const securityGroups = bindings.securityGroups;
  if (!Array.isArray(securityGroups) || securityGroups.length < 1
      || securityGroups.some((id) => !/^sg-[0-9a-f]{8,17}$/.test(id)))
    fail('security-groups');

  for (const key of ['executionRoleArn', 'taskRoleArn']) {
    const arn = requiredString(bindings[key], key);
    if (!ARN.test(arn) || !/:role\//.test(arn)) fail(key);
  }
  const targetGroupArn = requiredString(bindings.targetGroupArn, 'targetGroupArn');
  if (!TARGET_GROUP.test(targetGroupArn)) fail('target-group');

  const env = bindings.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('env');
  for (const key of Object.keys(env)) {
    if (HELD_ENV_KEYS.includes(key)) fail(`provider-config-held:${key}`);
    if (!ENV_KEYS.includes(key)) fail(`env-key:${key}`);
  }
  for (const key of ENV_KEYS) if (!Object.hasOwn(env, key)) fail(`env-missing:${key}`);
  for (const [key, value] of Object.entries(env))
    if (typeof value !== 'string' || /[\u0000-\u001f]/.test(value)) fail(`env-value:${key}`);
  if (Number(env.ONBOARD_PORT) !== PORT) fail('env-port');
  if (!PUBLISHABLE_KEY.test(env.CLERK_PUBLISHABLE_KEY)) fail('clerk-publishable-key');
  // Presentation and delivery holds are not authorization; keep them off in this cohort.
  if (env.ONBOARD_FUNNEL_ENABLED !== 'false') fail('funnel-hold');
  if (env.ONBOARD_EMAIL_ENABLED !== 'false') fail('email-hold');

  const secrets = bindings.secrets;
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) fail('secrets');
  for (const key of Object.keys(secrets)) {
    if (HELD_SECRET_KEYS.includes(key)) fail(`provider-credential-held:${key}`);
    if (!REQUIRED_SECRET_KEYS.includes(key)) fail(`secret-key:${key}`);
  }
  for (const key of REQUIRED_SECRET_KEYS) {
    if (!Object.hasOwn(secrets, key)) fail(`secret-missing:${key}`);
    validateSecretReference(key, requiredString(secrets[key], `secret:${key}`));
  }

  return { image, digest, source, cloneDbHost, dbName, subnets, securityGroups, env, secrets };
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function renderTaskDefinition(bindings) {
  const v = validateBindings(bindings);
  const environment = [
    ...ENV_KEYS.map((name) => ({ name, value: v.env[name] })),
    // The serve entrypoint requires these five. DB_PORT is the Aurora port and
    // DATABASE_URL is composed inside the entrypoint, never supplied here.
    { name: 'DB_HOST', value: v.cloneDbHost },
    { name: 'DB_PORT', value: DB_PORT },
    { name: 'DB_NAME', value: v.dbName },
    // The chosen image source is carried explicitly as well as in the image reference.
    { name: 'RELEASE_SHA', value: v.source },
  ].sort(byName);

  const secrets = REQUIRED_SECRET_KEYS.map((name) => ({ name, valueFrom: v.secrets[name] })).sort(byName);

  return {
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
        image: `${v.image}@${v.digest}`,
        essential: true,
        command: ['serve'],
        portMappings: [{ containerPort: PORT, protocol: 'tcp' }],
        environment,
        secrets,
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': LOG_GROUP,
            'awslogs-region': REGION,
            'awslogs-stream-prefix': LOG_PREFIX,
          },
        },
        healthCheck: {
          command: ['CMD-SHELL', `wget -q -O /dev/null http://127.0.0.1:${PORT}/health || exit 1`],
          interval: 30,
          timeout: 5,
          retries: 3,
          startPeriod: 30,
        },
      },
    ],
    tags: [
      { key: 'capiro:purpose', value: 'portfolio-preview' },
      { key: 'capiro:source', value: v.source },
    ],
  };
}

/**
 * The field sets themselves. `CreateService` identifies the new service by `serviceName`
 * and rejects `service`; `UpdateService` identifies the existing one by `service`. Sharing
 * one identifier object between them is what made the earlier create input invalid.
 */
function serviceRequestFields(bindings, mode, taskDefinitionArn) {
  const shared = {
    cluster: CLUSTER,
    taskDefinition: taskDefinitionArn,
    desiredCount: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: bindings.subnets,
        securityGroups: bindings.securityGroups,
        assignPublicIp: 'DISABLED',
      },
    },
    loadBalancers: [
      { targetGroupArn: bindings.targetGroupArn, containerName: CONTAINER, containerPort: PORT },
    ],
    healthCheckGracePeriodSeconds: 60,
    deploymentConfiguration: {
      minimumHealthyPercent: 100,
      maximumPercent: 200,
      deploymentCircuitBreaker: { enable: true, rollback: true },
    },
  };

  if (mode === 'update') return { ...shared, service: SERVICE };

  return {
    ...shared,
    serviceName: SERVICE,
    launchType: 'FARGATE',
    platformVersion: 'LATEST',
    schedulingStrategy: 'REPLICA',
    propagateTags: 'SERVICE',
    enableExecuteCommand: false,
    tags: [{ key: 'capiro:purpose', value: 'portfolio-preview' }],
  };
}

/**
 * `CreateService` and `UpdateService` take different field sets, and both need the exact
 * positive task-definition revision that registration returned, so a fabricated or
 * placeholder revision is refused.
 */
export function renderServiceRequest(bindings, options) {
  validateBindings(bindings);
  const { taskDefinitionArn, mode } = options ?? {};
  if (mode !== 'create' && mode !== 'update') fail('service-mode');
  if (typeof taskDefinitionArn !== 'string' || !TASK_DEF_ARN.test(taskDefinitionArn))
    fail(`task-definition-arn:${mode}`);
  return { executable: true, mode, request: serviceRequestFields(bindings, mode, taskDefinitionArn) };
}

/** Pre-registration plan: non-executable until an owner returns a task-definition ARN. */
export function renderOnboardPreviewPlan(bindings) {
  const v = validateBindings(bindings);
  return {
    schemaVersion: 3,
    kind: 'onboard-preview-service-plan',
    source: v.source,
    imageDigest: v.digest,
    imageRef: `${v.image}@${v.digest}`,
    registration: {
      status: 'not-registered',
      executable: false,
      blockedOn: 'taskDefinitionArn',
      reason: 'Register this task definition, then render the service request with the returned ARN.',
    },
    registerTaskDefinition: {
      executable: false,
      blockedOn: 'owner-submit',
      request: renderTaskDefinition(bindings),
    },
    // Pending field sets carry no fabricated ARN: `taskDefinition` stays null until the
    // owner returns the actual positive revision from RegisterTaskDefinition.
    createService: {
      executable: false,
      blockedOn: 'taskDefinitionArn',
      reason: 'The named service does not exist yet; render an ARN-bound create request separately.',
      request: serviceRequestFields(bindings, 'create', null),
    },
    updateService: {
      executable: false,
      blockedOn: ['taskDefinitionArn', 'existing-service-readback'],
      reason: 'If the named service appears before the write, describe it and reconcile its baseline first.',
      request: serviceRequestFields(bindings, 'update', null),
    },
    existingServiceReconciliation: {
      describe: ['ecs:DescribeServices', 'elbv2:DescribeTargetHealth'],
      preserve: [
        'current taskDefinition revision and image digest',
        'desiredCount and deployment configuration',
        'networkConfiguration subnets and securityGroups',
        'loadBalancers and healthCheckGracePeriodSeconds',
      ],
      rule: 'Never submit create-only fields as an update, and never reset a running baseline to this plan.',
    },
    notes: {
      database: 'literal preview clone host, port 5432 and DB_NAME; DATABASE_URL is composed by the entrypoint',
      credentials: 'ordinary application DB selectors, pinned internal-service version and Clerk secret; no admin secret',
      providers: 'Stripe, OAuth state, Microsoft and Google omitted so no provider client is constructed',
      command: 'serve only; no migrate, lifecycle, hard-delete or worker entrypoint',
      holds: 'funnel and email disabled; no billing sends, provider activation or invitations',
      operational: `existing log group ${LOG_GROUP}, container health check and circuit-breaker recovery preserved`,
    },
  };
}
