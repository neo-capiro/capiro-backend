/**
 * engagement-api infrastructure configuration contract.
 *
 * The committed synthetic fixture is the artifact under test. Every rule the
 * Phase 2 plan requires is exercised by mutating a deep copy, so a validation
 * that silently stopped working would fail here rather than at deploy time.
 *
 * Run: pnpm --dir infra/cdk exec ts-node --prefer-ts-exts test/engagement-api-config.spec.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  ENGAGEMENT_API_CONTRACT,
  EngagementApiConfigError,
  collectConfigFailures,
  engagementApiNames,
  loadEngagementApiConfig,
  parseEngagementApiConfig,
  uiContractSha256,
  uiContractShortHash,
  type EngagementApiInfraConfig,
} from '../lib/engagement-api/engagement-api-config';

const CDK_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(CDK_ROOT, '../..');
const FIXTURE = path.join(CDK_ROOT, 'fixtures/engagement-api.test.json');
const API_FIXTURES = path.join(REPO_ROOT, 'apps/api/src/engagement/__fixtures__');

const base = (): EngagementApiInfraConfig =>
  JSON.parse(readFileSync(FIXTURE, 'utf8')) as EngagementApiInfraConfig;

/** Assert the config is rejected, and that it is rejected for the right reason. */
function rejects(mutate: (c: EngagementApiInfraConfig) => void, pattern: RegExp): void {
  const config = base();
  mutate(config);
  const { failures, config: parsed } = collectConfigFailures(config);
  assert.equal(parsed, undefined, 'expected the config to be rejected');
  assert.ok(
    failures.some((failure) => pattern.test(failure)),
    `no failure matched ${pattern}\n  actual: ${failures.join('\n          ')}`,
  );
}

// ───────────────────────────────────────────────────────────── positive path

test('the committed synthetic fixture is valid', () => {
  const { failures, config } = collectConfigFailures(base());
  assert.deepEqual(failures, []);
  assert.ok(config);
});

test('the fixture uses synthetic identifiers, never live ones', () => {
  const raw = readFileSync(FIXTURE, 'utf8');
  assert.match(raw, /"accountId": "000000000000"/);
  assert.doesNotMatch(raw, /967807252336/, 'the live account id must never appear in a fixture');
  assert.doesNotMatch(raw, /capiro-prod-alb/);
});

test('derived resource names follow the Phase 2 contract', () => {
  const names = engagementApiNames(base());
  assert.deepEqual(names, {
    repository: 'capiro/dev/engagement-api',
    service: 'capiro-dev-engagement-api',
    taskFamily: 'capiro-dev-engagement-api',
    targetGroup: 'capiro-dev-engagement-api',
    logGroup: '/capiro/dev/engagement-api',
    registryStack: 'Capiro-dev-EngagementApiRegistry',
    networkStack: 'Capiro-dev-EngagementApiNetwork',
    serviceStack: 'Capiro-dev-EngagementApiService',
  });
});

test('the UI contract hash is derived deterministically and is short-taggable', () => {
  const ui = base().uiContract;
  const expected = createHash('sha256')
    .update(`${ui.prototypeManifestSha256}:${ui.capabilityManifestSha256}`)
    .digest('hex');
  assert.equal(uiContractSha256(ui), expected);
  assert.equal(uiContractShortHash(ui), expected.slice(0, 12));
  assert.equal(uiContractSha256(ui), uiContractSha256(ui));
});

test('the fixture UI contract pins the committed Phase 2.1 and 2.2 manifests', () => {
  const sha = (file: string) =>
    createHash('sha256').update(readFileSync(path.join(API_FIXTURES, file))).digest('hex');
  const prototypeManifest = JSON.parse(
    readFileSync(path.join(API_FIXTURES, 'outreach-v3-prototype-state-manifest.v1.json'), 'utf8'),
  ) as { prototypeSha256: string };

  const ui = base().uiContract;
  assert.equal(ui.prototypeSha256, prototypeManifest.prototypeSha256);
  assert.equal(ui.prototypeManifestSha256, sha('outreach-v3-prototype-state-manifest.v1.json'));
  assert.equal(ui.capabilityManifestSha256, sha('outreach-v3-ui-api-capability-manifest.v1.json'));
});

// ─────────────────────────────────────────────────────────── Clerk JWT issuer

test('clerkJwtIssuer is required — its absence crash-loops the task at boot', () => {
  // engagement-api boots the identical NestJS ConfigModule validator as the
  // main API (validateConfig in apps/api/src/config/config.schema.ts), which
  // throws fatally without CLERK_JWT_ISSUER outside NODE_ENV=test. Missing
  // from the initial Phase 2 build; found by independent review (2.14) and
  // confirmed absent from the actual synthesized template before this fix.
  rejects(
    (c) => void ((c as unknown as { clerkJwtIssuer?: string }).clerkJwtIssuer = undefined),
    /clerkJwtIssuer is required/,
  );
  rejects((c) => void (c.clerkJwtIssuer = ''), /clerkJwtIssuer is required/);
});

test('clerkJwtIssuer must be a valid URL', () => {
  rejects((c) => void (c.clerkJwtIssuer = 'not-a-url'), /clerkJwtIssuer must be a valid URL/);
  rejects((c) => void (c.clerkJwtIssuer = 'clerk.app.capiro.ai'), /clerkJwtIssuer must be a valid URL/);
});

test('a well-formed clerkJwtIssuer passes', () => {
  const config = base();
  config.clerkJwtIssuer = 'https://clerk.app.capiro.ai';
  assert.deepEqual(collectConfigFailures(config).failures, []);
});

// ─────────────────────────────────────────────────────────── account/region

test('account and region must be well formed', () => {
  rejects((c) => void (c.accountId = '123'), /accountId must be 12 digits/);
  rejects((c) => void (c.region = 'nowhere'), /region is malformed/);
});

test('account and region must match the discovered environment exactly', () => {
  const { failures } = collectConfigFailures(base(), {
    expected: { accountId: '999999999999', region: 'eu-west-1' },
  });
  assert.ok(failures.some((f) => /does not match the discovered account/.test(f)));
  assert.ok(failures.some((f) => /does not match the discovered region/.test(f)));
});

// ─────────────────────────────────────────────────────────────────── network

test('at least two private subnets across two availability zones are required', () => {
  rejects((c) => {
    c.privateSubnetIds = ['subnet-0000000000000aaa'];
    c.privateSubnetAvailabilityZones = ['us-east-1a'];
  }, /at least two private subnets/);

  rejects((c) => {
    c.privateSubnetAvailabilityZones = ['us-east-1a', 'us-east-1a'];
  }, /at least two availability zones/);
});

test('subnet ids and availability zones must be the same length', () => {
  rejects(
    (c) => void (c.privateSubnetAvailabilityZones = ['us-east-1a']),
    /same length/,
  );
});

// ───────────────────────────────────────────────────── listener and priority

test('malformed imported ARNs are rejected', () => {
  rejects((c) => void (c.httpsListenerArn = 'not-an-arn'), /httpsListenerArn is malformed/);
  rejects((c) => void (c.mainApiTargetGroupArn = 'arn:aws:s3:::bucket'), /mainApiTargetGroupArn is malformed/);
  rejects((c) => void (c.ecsClusterArn = 'arn:aws:ecs:us-east-1:0:service/x'), /ecsClusterArn is malformed/);
});

test('the preview rule priority is fixed at 6', () => {
  assert.equal(ENGAGEMENT_API_CONTRACT.previewRulePriority, 6);
  rejects((c) => void (c.previewRulePriority = 7), /previewRulePriority must be 6/);
});

test('the preview priority may not collide with the generic /api/* rule', () => {
  rejects((c) => {
    c.previewRulePriority = 6;
    c.genericApiRulePriority = 6;
  }, /collides with genericApiRulePriority/);
});

test('the generic rule priority must match the discovered value', () => {
  const { failures } = collectConfigFailures(base(), {
    expected: { genericApiRulePriority: 10 },
  });
  assert.deepEqual(failures, []);

  const drifted = collectConfigFailures(base(), { expected: { genericApiRulePriority: 12 } });
  assert.ok(drifted.failures.some((f) => /does not match the discovered value 12/.test(f)));
});

test('NC-2.3-B an occupied preview priority is rejected', () => {
  const { failures } = collectConfigFailures(base(), {
    expected: { occupiedRulePriorities: [6, 10] },
  });
  assert.ok(
    failures.some((f) => /previewRulePriority 6 is already occupied/.test(f)),
    failures.join('\n'),
  );
  // Not vacuous: a free priority passes the same check.
  assert.deepEqual(
    collectConfigFailures(base(), { expected: { occupiedRulePriorities: [8, 10] } }).failures,
    [],
  );
});

// ───────────────────────────────────────────────────────────────────── image

test('the image repository name is derived from the environment', () => {
  rejects((c) => void (c.imageRepositoryName = 'capiro/engagement-api'), /must be capiro\/dev\/engagement-api/);
  rejects((c) => {
    c.environment = 'prod';
    // repository still says dev
  }, /must be capiro\/prod\/engagement-api/);
});

test('a mutable tag cannot masquerade as a digest', () => {
  rejects((c) => void (c.imageDigest = 'latest'), /imageDigest must be sha256:/);
  rejects((c) => void (c.imageDigest = 'sha256:abc'), /imageDigest must be sha256:/);
  rejects((c) => void (c.releaseSha = 'HEAD'), /releaseSha must be 40 hex/);
});

// ───────────────────────────────────────────────────────────── fixed sizing

test('Phase 2 sizing is not tunable through config', () => {
  rejects((c) => void ((c as unknown as { cpu: number }).cpu = 1024), /cpu must be 512/);
  rejects((c) => void ((c as unknown as { memoryMiB: number }).memoryMiB = 2048), /memoryMiB must be 1024/);
  rejects((c) => void ((c as unknown as { maximumCount: number }).maximumCount = 6), /maximumCount must be 2/);
});

// ───────────────────────────────────────────────────────────────── posture

test('no environment may enable a public IP or ECS Exec', () => {
  for (const environment of ['dev', 'staging', 'prod'] as const) {
    rejects((c) => {
      c.environment = environment;
      c.imageRepositoryName = `capiro/${environment}/engagement-api`;
      c.allowPublicIp = true;
    }, /allowPublicIp must be false/);

    rejects((c) => {
      c.environment = environment;
      c.imageRepositoryName = `capiro/${environment}/engagement-api`;
      c.allowEcsExec = true;
    }, /allowEcsExec must be false/);
  }
});

// ────────────────────────────────────────────────────── database connection

test('an unsafe database connection budget is rejected', () => {
  // 420 + 2 * 300 = 1020 > floor(1000 * 0.8) = 800
  rejects(
    (c) => void (c.dbConnectionBudget.perTaskPoolMaximum = 300),
    /exceeds the safe ceiling/,
  );
});

test('a budget leaving under 10% operational headroom is rejected', () => {
  rejects((c) => {
    c.dbConnectionBudget = {
      databaseMaxConnections: 100,
      observedSevenDayPeak: 79,
      perTaskPoolMaximum: 1,
      alarmThreshold: 80,
    };
    // projected 81, ceiling 80 -> ceiling breach fires first
  }, /exceeds the safe ceiling|operational headroom/);
});

test('an alarm threshold that would fire constantly is rejected', () => {
  rejects(
    (c) => void (c.dbConnectionBudget.alarmThreshold = 400),
    /at or below the observed peak/,
  );
  rejects(
    (c) => void (c.dbConnectionBudget.alarmThreshold = 900),
    /exceeds the safe ceiling/,
  );
});

test('a safe budget passes', () => {
  const config = base();
  const projected =
    config.dbConnectionBudget.observedSevenDayPeak +
    config.maximumCount * config.dbConnectionBudget.perTaskPoolMaximum;
  assert.equal(projected, 440);
  assert.ok(projected <= Math.floor(config.dbConnectionBudget.databaseMaxConnections * 0.8));
  assert.deepEqual(collectConfigFailures(config).failures, []);
});

// ───────────────────────────────────────────────────────────── UI contract

test('UI contract hashes are required', () => {
  rejects((c) => void delete (c as Partial<EngagementApiInfraConfig>).uiContract, /uiContract is required/);
  rejects(
    (c) => void (c.uiContract.capabilityManifestSha256 = ''),
    /capabilityManifestSha256 must be 64 lowercase hex/,
  );
  rejects(
    (c) => void (c.uiContract.prototypeSha256 = 'ABC'),
    /prototypeSha256 must be 64 lowercase hex/,
  );
});

test('NC-2.3-A a wrong prototype hash is rejected against the committed contract', () => {
  const expected = base().uiContract;
  const config = base();
  config.uiContract.prototypeSha256 = 'f'.repeat(64);

  const { failures } = collectConfigFailures(config, { expected: { uiContract: expected } });
  assert.ok(
    failures.some((f) => /uiContract.prototypeSha256 does not match the committed contract/.test(f)),
    failures.join('\n'),
  );

  // and the unmutated config still passes, so the control is not vacuous
  assert.deepEqual(
    collectConfigFailures(base(), { expected: { uiContract: expected } }).failures,
    [],
  );
});

// ────────────────────────────────────────────────────────────── fail closed

test('there is no default config path — an unset variable is an error', () => {
  const previous = process.env.ENGAGEMENT_API_INFRA_CONFIG;
  delete process.env.ENGAGEMENT_API_INFRA_CONFIG;
  try {
    assert.throws(() => loadEngagementApiConfig(), (error: unknown) => {
      assert.ok(error instanceof EngagementApiConfigError);
      assert.match(error.message, /ENGAGEMENT_API_INFRA_CONFIG is not set/);
      return true;
    });
  } finally {
    if (previous !== undefined) process.env.ENGAGEMENT_API_INFRA_CONFIG = previous;
  }
});

test('loading the committed fixture by path succeeds', () => {
  const config = loadEngagementApiConfig({ path: FIXTURE });
  assert.equal(config.environment, 'dev');
  assert.equal(config.previewRulePriority, 6);
});

test('a missing file is an error, not an empty config', () => {
  assert.throws(
    () => loadEngagementApiConfig({ path: path.join(CDK_ROOT, 'fixtures/does-not-exist.json') }),
    /could not read config/,
  );
});

test('parse throws with every failure listed at once', () => {
  const config = base();
  config.accountId = 'nope';
  config.previewRulePriority = 9;
  try {
    parseEngagementApiConfig(config);
    assert.fail('expected a rejection');
  } catch (error) {
    assert.ok(error instanceof EngagementApiConfigError);
    assert.ok(error.failures.length >= 2, 'expected all failures, not just the first');
  }
});

test('a non-object config is rejected', () => {
  for (const value of [null, 'string', 42, []]) {
    const { config } = collectConfigFailures(value);
    assert.equal(config, undefined);
  }
});
