import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Fail-closed configuration contract for the additive `engagement-api` CDK app.
 *
 * Deliberately NOT the `lib/config.ts` pattern. That module resolves an
 * environment from CDK context and carries live production identifiers as
 * defaults; the Phase 2 plan forbids both for this app, because a mistyped
 * `--context env=` must never silently target production. Every identifier here
 * is supplied by an explicit JSON file and validated before synthesis:
 *
 *   ENGAGEMENT_API_INFRA_CONFIG=/absolute/path/to/config.json
 *
 * There are no defaults. A missing, malformed, or unsafe field stops synthesis.
 */

export type EngagementApiEnvName = 'dev' | 'staging' | 'prod';

/** Fixed by the Phase 2 contract. Not tunable through config. */
export const ENGAGEMENT_API_CONTRACT = {
  containerPort: 4500,
  cpu: 512,
  memoryMiB: 1024,
  desiredCount: 1,
  minimumCount: 1,
  maximumCount: 2,
  previewRulePriority: 6,
  previewHeaderName: 'X-Capiro-Engagement-Preview',
  previewHeaderValue: 'v3',
  healthCheckPath: '/health',
  dbSafeCeilingRatio: 0.8,
  dbHeadroomRatio: 0.1,
} as const;

export interface EngagementApiUiContract {
  /** SHA-256 of the Outreach V3 standalone prototype file. */
  prototypeSha256: string;
  /** SHA-256 of the committed prototype state manifest. */
  prototypeManifestSha256: string;
  /** SHA-256 of the committed UI/API capability manifest. */
  capabilityManifestSha256: string;
}

export interface EngagementApiDbBudget {
  databaseMaxConnections: number;
  observedSevenDayPeak: number;
  perTaskPoolMaximum: number;
  alarmThreshold: number;
}

export interface EngagementApiInfraConfig {
  schemaVersion: 1;

  environment: EngagementApiEnvName;
  accountId: string;
  region: string;

  // apps/api/src/config/config.schema.ts's validateConfig() throws
  // "CLERK_JWT_ISSUER is required outside tests" whenever NODE_ENV !== 'test'
  // — gated on that, not on NODE_ENV === 'production', because capiro-dev-api
  // runs live with NODE_ENV=development. engagement-api boots the identical
  // validator (engagement-api.app.module.ts imports the same validateConfig),
  // so this is not optional the way lib/config.ts's `cfg.clerkJwtIssuer?`
  // is: an engagement-api task started without it fatally crash-loops at
  // ConfigModule init, repeating on every restart. Required here so that
  // failure mode can never again reach a deployed task definition.
  clerkJwtIssuer: string;

  vpcId: string;
  privateSubnetIds: string[];
  privateSubnetAvailabilityZones: string[];

  ecsClusterArn: string;
  serviceSecurityGroupId: string;

  httpsListenerArn: string;
  mainApiTargetGroupArn: string;
  genericApiRulePriority: number;
  previewRulePriority: number;

  auroraClusterIdentifier: string;

  // Live discovery (Phase 2 micro-session 2.15, capiro-dev, 2026-08-06) found
  // the main API task splits DB credentials across TWO secrets, not one:
  // /capiro/<env>/aurora/master supplies host/port, /capiro/<env>/aurora/app
  // supplies username/password. DB_NAME is not a secret at all — the main
  // task injects it as a literal env var. Modeled that way here rather than
  // the single-secret shape this contract originally assumed.
  databaseHostSecretArn: string;
  databaseAppSecretArn: string;
  databaseName: string;

  appConfigSecretArn: string;
  requiredSecretArns: string[];

  kmsKeyArns: { ecr: string; logs: string; data: string[] };

  bucketNames: {
    assets?: string;
    directory?: string;
    attachments?: string;
    otherReadOnly: string[];
  };

  alarmTopicArn: string;

  imageRepositoryName: string;
  imageDigest?: string;
  releaseSha?: string;

  cpu: 512;
  memoryMiB: 1024;
  desiredCount: 1;
  minimumCount: 1;
  maximumCount: 2;

  dbConnectionBudget: EngagementApiDbBudget;

  uiContract: EngagementApiUiContract;

  /** Phase 2 forbids both. Present so a future edit is rejected, not silent. */
  allowPublicIp?: boolean;
  allowEcsExec?: boolean;
}

export interface ParseOptions {
  /**
   * Discovered live values the config must agree with. Supplying these turns
   * "well-formed" into "correct for this environment".
   */
  expected?: {
    accountId?: string;
    region?: string;
    genericApiRulePriority?: number;
    occupiedRulePriorities?: number[];
    uiContract?: EngagementApiUiContract;
  };
}

export class EngagementApiConfigError extends Error {
  readonly failures: string[];
  constructor(failures: string[]) {
    super(`engagement-api infrastructure config is invalid:\n  - ${failures.join('\n  - ')}`);
    this.name = 'EngagementApiConfigError';
    this.failures = failures;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function isArn(value: unknown, service: string, resource?: string): boolean {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length < 6) return false;
  const [arn, partition, svc, region, account] = parts;
  if (arn !== 'arn' || !partition || svc !== service || !region || !account) return false;
  // Everything from the sixth segment on is the resource; ARNs such as an ECS
  // cluster keep the type and name in one segment, so rejoin before matching.
  const resourcePart = parts.slice(5).join(':');
  if (resource && !resourcePart.startsWith(resource)) return false;
  return true;
}

/**
 * Validate a parsed config object. Returns every failure rather than the first,
 * so a bad config is fixed in one pass.
 */
export function collectConfigFailures(
  raw: unknown,
  options: ParseOptions = {},
): { failures: string[]; config?: EngagementApiInfraConfig } {
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { failures: ['config must be a JSON object'] };
  }
  const c = raw as Partial<EngagementApiInfraConfig>;
  const expected = options.expected ?? {};

  if (c.schemaVersion !== 1) fail(`schemaVersion must be 1, got ${JSON.stringify(c.schemaVersion)}`);

  // ── identity ────────────────────────────────────────────────────────────
  if (!c.environment || !['dev', 'staging', 'prod'].includes(c.environment)) {
    fail(`environment must be dev, staging or prod, got ${JSON.stringify(c.environment)}`);
  }
  if (!/^\d{12}$/.test(String(c.accountId))) fail(`accountId must be 12 digits, got ${c.accountId}`);
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(String(c.region))) fail(`region is malformed: ${c.region}`);
  if (expected.accountId && c.accountId !== expected.accountId) {
    fail(`accountId ${c.accountId} does not match the discovered account ${expected.accountId}`);
  }
  if (expected.region && c.region !== expected.region) {
    fail(`region ${c.region} does not match the discovered region ${expected.region}`);
  }

  // The API's ConfigModule validator fatally rejects boot without this
  // outside NODE_ENV=test. Validated as a URL, matching the main app's own
  // `z.string().url()` schema field, so a malformed value fails here rather
  // than at container boot.
  if (typeof c.clerkJwtIssuer !== 'string' || c.clerkJwtIssuer.length === 0) {
    fail('clerkJwtIssuer is required; engagement-api fatally refuses to boot without it');
  } else {
    try {
      new URL(c.clerkJwtIssuer);
    } catch {
      fail(`clerkJwtIssuer must be a valid URL, got ${c.clerkJwtIssuer}`);
    }
  }

  // ── network ─────────────────────────────────────────────────────────────
  if (!/^vpc-[0-9a-f]+$/.test(String(c.vpcId))) fail(`vpcId is malformed: ${c.vpcId}`);
  const subnets = c.privateSubnetIds ?? [];
  const azs = c.privateSubnetAvailabilityZones ?? [];
  if (!Array.isArray(subnets) || subnets.length < 2) {
    fail('privateSubnetIds must contain at least two private subnets');
  }
  if (!Array.isArray(azs) || azs.length !== subnets.length) {
    fail('privateSubnetIds and privateSubnetAvailabilityZones must be the same length');
  }
  if (new Set(azs).size < 2) {
    fail('private subnets must span at least two availability zones');
  }
  for (const subnet of subnets) {
    if (!/^subnet-[0-9a-f]+$/.test(String(subnet))) fail(`subnet id is malformed: ${subnet}`);
  }
  if (!/^sg-[0-9a-f]+$/.test(String(c.serviceSecurityGroupId))) {
    fail(`serviceSecurityGroupId is malformed: ${c.serviceSecurityGroupId}`);
  }

  // ── imported resources ──────────────────────────────────────────────────
  if (!isArn(c.ecsClusterArn, 'ecs', 'cluster/')) fail(`ecsClusterArn is malformed: ${c.ecsClusterArn}`);
  if (!isArn(c.httpsListenerArn, 'elasticloadbalancing', 'listener/')) {
    fail(`httpsListenerArn is malformed: ${c.httpsListenerArn}`);
  }
  if (!isArn(c.mainApiTargetGroupArn, 'elasticloadbalancing', 'targetgroup/')) {
    fail(`mainApiTargetGroupArn is malformed: ${c.mainApiTargetGroupArn}`);
  }
  if (!isArn(c.databaseHostSecretArn, 'secretsmanager')) {
    fail(`databaseHostSecretArn is malformed: ${c.databaseHostSecretArn}`);
  }
  if (!isArn(c.databaseAppSecretArn, 'secretsmanager')) {
    fail(`databaseAppSecretArn is malformed: ${c.databaseAppSecretArn}`);
  }
  if (typeof c.databaseName !== 'string' || c.databaseName.length === 0) {
    fail('databaseName is required (it is a plain env var on the live task, not a secret)');
  }
  if (!isArn(c.appConfigSecretArn, 'secretsmanager')) {
    fail(`appConfigSecretArn is malformed: ${c.appConfigSecretArn}`);
  }
  for (const arn of c.requiredSecretArns ?? []) {
    if (!isArn(arn, 'secretsmanager')) fail(`requiredSecretArns contains a malformed ARN: ${arn}`);
  }
  if (!isArn(c.kmsKeyArns?.ecr, 'kms')) fail(`kmsKeyArns.ecr is malformed: ${c.kmsKeyArns?.ecr}`);
  if (!isArn(c.kmsKeyArns?.logs, 'kms')) fail(`kmsKeyArns.logs is malformed: ${c.kmsKeyArns?.logs}`);
  for (const arn of c.kmsKeyArns?.data ?? []) {
    if (!isArn(arn, 'kms')) fail(`kmsKeyArns.data contains a malformed ARN: ${arn}`);
  }
  if (!isArn(c.alarmTopicArn, 'sns')) fail(`alarmTopicArn is malformed: ${c.alarmTopicArn}`);
  if (c.environment === 'prod' && !c.alarmTopicArn) fail('prod requires an alarm topic');
  if (!c.auroraClusterIdentifier) fail('auroraClusterIdentifier is required');
  if (!Array.isArray(c.bucketNames?.otherReadOnly)) {
    fail('bucketNames.otherReadOnly must be an array (may be empty)');
  }

  // ── listener rule priorities ────────────────────────────────────────────
  if (c.previewRulePriority !== ENGAGEMENT_API_CONTRACT.previewRulePriority) {
    fail(
      `previewRulePriority must be ${ENGAGEMENT_API_CONTRACT.previewRulePriority} unless a ` +
        `reviewed plan revision changes it, got ${c.previewRulePriority}`,
    );
  }
  if (typeof c.genericApiRulePriority !== 'number') {
    fail('genericApiRulePriority is required');
  } else if (c.genericApiRulePriority === c.previewRulePriority) {
    fail('previewRulePriority collides with genericApiRulePriority');
  }
  if (
    expected.genericApiRulePriority !== undefined &&
    c.genericApiRulePriority !== expected.genericApiRulePriority
  ) {
    fail(
      `genericApiRulePriority ${c.genericApiRulePriority} does not match the discovered ` +
        `value ${expected.genericApiRulePriority}`,
    );
  }
  if ((expected.occupiedRulePriorities ?? []).includes(Number(c.previewRulePriority))) {
    fail(`previewRulePriority ${c.previewRulePriority} is already occupied on the live listener`);
  }

  // ── image ───────────────────────────────────────────────────────────────
  const expectedRepository = `capiro/${c.environment}/engagement-api`;
  if (c.imageRepositoryName !== expectedRepository) {
    fail(`imageRepositoryName must be ${expectedRepository}, got ${c.imageRepositoryName}`);
  }
  if (c.imageDigest !== undefined && !DIGEST.test(c.imageDigest)) {
    fail(`imageDigest must be sha256: plus 64 lowercase hex characters, got ${c.imageDigest}`);
  }
  if (c.releaseSha !== undefined && !SHA40.test(c.releaseSha)) {
    fail(`releaseSha must be 40 hex characters, got ${c.releaseSha}`);
  }

  // ── fixed sizing ────────────────────────────────────────────────────────
  const fixed: Array<[keyof EngagementApiInfraConfig, number]> = [
    ['cpu', ENGAGEMENT_API_CONTRACT.cpu],
    ['memoryMiB', ENGAGEMENT_API_CONTRACT.memoryMiB],
    ['desiredCount', ENGAGEMENT_API_CONTRACT.desiredCount],
    ['minimumCount', ENGAGEMENT_API_CONTRACT.minimumCount],
    ['maximumCount', ENGAGEMENT_API_CONTRACT.maximumCount],
  ];
  for (const [key, value] of fixed) {
    if (c[key] !== value) fail(`${String(key)} must be ${value} in Phase 2, got ${c[key]}`);
  }

  // ── posture ─────────────────────────────────────────────────────────────
  if (c.allowPublicIp === true) {
    fail(`allowPublicIp must be false (${c.environment ?? 'unknown'}); Phase 2 runs private only`);
  }
  if (c.allowEcsExec === true) {
    fail(`allowEcsExec must be false (${c.environment ?? 'unknown'}); ECS Exec stays disabled`);
  }

  // ── database connection budget ──────────────────────────────────────────
  const budget = c.dbConnectionBudget;
  if (!budget || typeof budget !== 'object') {
    fail('dbConnectionBudget is required');
  } else {
    const { databaseMaxConnections, observedSevenDayPeak, perTaskPoolMaximum, alarmThreshold } =
      budget;
    const positives: Array<[string, number]> = [
      ['databaseMaxConnections', databaseMaxConnections],
      ['observedSevenDayPeak', observedSevenDayPeak],
      ['perTaskPoolMaximum', perTaskPoolMaximum],
      ['alarmThreshold', alarmThreshold],
    ];
    let numeric = true;
    for (const [key, value] of positives) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        fail(`dbConnectionBudget.${key} must be a positive number`);
        numeric = false;
      }
    }
    if (numeric) {
      const maximumCount = Number(c.maximumCount ?? ENGAGEMENT_API_CONTRACT.maximumCount);
      const projectedPeak = observedSevenDayPeak + maximumCount * perTaskPoolMaximum;
      const safeCeiling = Math.floor(
        databaseMaxConnections * ENGAGEMENT_API_CONTRACT.dbSafeCeilingRatio,
      );
      const headroom = databaseMaxConnections - projectedPeak;
      const requiredHeadroom = databaseMaxConnections * ENGAGEMENT_API_CONTRACT.dbHeadroomRatio;
      if (projectedPeak > safeCeiling) {
        fail(
          `unsafe database connection budget: projected peak ${projectedPeak} exceeds the safe ` +
            `ceiling ${safeCeiling} (80% of ${databaseMaxConnections})`,
        );
      }
      if (headroom < requiredHeadroom) {
        fail(
          `unsafe database connection budget: operational headroom ${headroom} is below the ` +
            `required ${requiredHeadroom} (10% of ${databaseMaxConnections})`,
        );
      }
      if (alarmThreshold > safeCeiling) {
        fail(`dbConnectionBudget.alarmThreshold ${alarmThreshold} exceeds the safe ceiling ${safeCeiling}`);
      }
      if (alarmThreshold <= observedSevenDayPeak) {
        fail(
          `dbConnectionBudget.alarmThreshold ${alarmThreshold} is at or below the observed ` +
            `peak ${observedSevenDayPeak} and would alarm constantly`,
        );
      }
    }
  }

  // ── UI contract provenance ──────────────────────────────────────────────
  const ui = c.uiContract;
  if (!ui || typeof ui !== 'object') {
    fail('uiContract is required');
  } else {
    const fields: Array<keyof EngagementApiUiContract> = [
      'prototypeSha256',
      'prototypeManifestSha256',
      'capabilityManifestSha256',
    ];
    for (const field of fields) {
      if (!HEX64.test(String(ui[field]))) {
        fail(`uiContract.${field} must be 64 lowercase hex characters, got ${ui[field]}`);
      }
    }
    const want = expected.uiContract;
    if (want) {
      for (const field of fields) {
        if (ui[field] && want[field] && ui[field] !== want[field]) {
          fail(
            `uiContract.${field} does not match the committed contract\n      config   ` +
              `${ui[field]}\n      expected ${want[field]}`,
          );
        }
      }
    }
  }

  if (failures.length > 0) return { failures };
  return { failures, config: c as EngagementApiInfraConfig };
}

/** Parse and validate, throwing on any failure. */
export function parseEngagementApiConfig(
  raw: unknown,
  options: ParseOptions = {},
): EngagementApiInfraConfig {
  const { failures, config } = collectConfigFailures(raw, options);
  if (!config) throw new EngagementApiConfigError(failures);
  return config;
}

/**
 * Load the config named by ENGAGEMENT_API_INFRA_CONFIG.
 *
 * There is no default path and no default environment: an unset variable is an
 * error, never an implicit production target.
 */
export function loadEngagementApiConfig(
  options: ParseOptions & { path?: string } = {},
): EngagementApiInfraConfig {
  const file = options.path ?? process.env.ENGAGEMENT_API_INFRA_CONFIG;
  if (!file) {
    throw new EngagementApiConfigError([
      'ENGAGEMENT_API_INFRA_CONFIG is not set. Pass an absolute path to a config JSON file. ' +
        'There is no default, so a missing value can never silently target production.',
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new EngagementApiConfigError([
      `could not read config ${file}: ${(error as Error).message}`,
    ]);
  }
  return parseEngagementApiConfig(parsed, options);
}

/**
 * The single nonsecret provenance value handed to the task as
 * OUTREACH_V3_UI_CONTRACT_SHA256. Derived so one value pins both manifests.
 */
export function uiContractSha256(ui: EngagementApiUiContract): string {
  return createHash('sha256')
    .update(`${ui.prototypeManifestSha256}:${ui.capabilityManifestSha256}`)
    .digest('hex');
}

/** Short form used for the `capiro:ui-contract` resource tag. */
export function uiContractShortHash(ui: EngagementApiUiContract): string {
  return uiContractSha256(ui).slice(0, 12);
}

/** Resource names derived from the environment. Never free text. */
export function engagementApiNames(cfg: EngagementApiInfraConfig) {
  return {
    repository: `capiro/${cfg.environment}/engagement-api`,
    service: `capiro-${cfg.environment}-engagement-api`,
    taskFamily: `capiro-${cfg.environment}-engagement-api`,
    targetGroup: `capiro-${cfg.environment}-engagement-api`,
    logGroup: `/capiro/${cfg.environment}/engagement-api`,
    registryStack: `Capiro-${cfg.environment}-EngagementApiRegistry`,
    networkStack: `Capiro-${cfg.environment}-EngagementApiNetwork`,
    serviceStack: `Capiro-${cfg.environment}-EngagementApiService`,
  };
}
