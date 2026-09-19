import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';
import { MERIV3_CHAT_FLAG } from '../common/meriv3-flags.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Truth table for `MeriFeatureFlagsService.isMeriV3ChatEnabled(tenantId, slug)`
 * — the gate behind `MeriV3ProxyService.shouldHandle`, i.e. the FIRST routing
 * decision for every full-chat turn (meriv3-runtime.proxy.ts). Three keys, all
 * default-closed, evaluated in this order with short-circuit:
 *
 *   1. env  MERIV3_ENABLED === 'true'                   (literal compare)
 *   2. slug ∈ MERIV3_CANARY_TENANT_SLUGS                 (default 'capiro-internal';
 *                                                        entries + slug trimmed and
 *                                                        lower-cased)
 *   3. DB   clioFeatureFlags['meriv3.fullChat'] === true (default false; a DB
 *                                                        failure also resolves false)
 *
 * Pins EXISTING behavior — this spec changes nothing. common/meriv3-flags.spec.ts
 * covers the pure helpers (meriV3ChatActive); meri-feature-flags.service.spec.ts
 * covers only the MeriV2 surface gate. This file is the service-level V3 matrix.
 *
 * Live cohort as verified 2026-09-18 (capiro-dev-api:384 / meriv2-orchestrator:65):
 * MERIV3_ENABLED=true, nine canary slugs, meriv3.fullChat=true on all nine — so
 * the "open" row below is what every live tenant resolves to today, and every
 * other row is the rollback path.
 *
 * If a cell here goes red, ROUTING CHANGED. Explain it as a defect (or an
 * explicitly authorized contract change); do not edit the expectation to match
 * the service.
 */

const TENANT_ID = 'tenant-1';

/** The live canary cohort on 2026-09-18 (api:384 / orch:65 env), used as a fixture. */
const LIVE_CANARY_SLUGS = [
  'c2-strategies',
  'capiro-internal',
  'dualsight',
  'maven',
  'prospering-solutions',
  'revere',
  'victory-six-advisors',
  'rubin-turnbull',
  'abramoff',
];

/** Fake PrismaService whose withTenant yields a tenant with the given settings and counts reads. */
function prismaWithSettings(settings: unknown, reads = { count: 0 }): PrismaService {
  return {
    withTenant: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
      reads.count += 1;
      return fn({ tenant: { findFirst: async () => ({ settings }) } });
    },
  } as unknown as PrismaService;
}

/** Fake PrismaService whose tenant row does not exist. */
const prismaWithoutTenantRow: PrismaService = {
  withTenant: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ tenant: { findFirst: async () => null } }),
} as unknown as PrismaService;

const prismaThatMustNotQuery: PrismaService = {
  withTenant: async () => {
    throw new Error('DB must not be queried while an earlier MeriV3 key is closed');
  },
} as unknown as PrismaService;

const prismaThatFails: PrismaService = {
  withTenant: async () => {
    throw new Error('simulated database outage');
  },
} as unknown as PrismaService;

const flagged = (value: unknown): unknown => ({ clioFeatureFlags: { [MERIV3_CHAT_FLAG]: value } });

const ENV_KEYS = ['MERIV3_ENABLED', 'MERIV3_CANARY_TENANT_SLUGS'] as const;
type EnvKey = (typeof ENV_KEYS)[number];
let savedEnv: Partial<Record<EnvKey, string | undefined>> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function envOn(): void {
  process.env.MERIV3_ENABLED = 'true';
}

function allowlist(slugs: string): void {
  process.env.MERIV3_CANARY_TENANT_SLUGS = slugs;
}

type FlagState = 'true' | 'false' | 'absent';

function settingsFor(flag: FlagState): unknown {
  return flag === 'absent' ? {} : flagged(flag === 'true');
}

interface Cell {
  env: 'on' | 'off';
  slug: 'in' | 'out';
  flag: FlagState;
  expected: boolean;
}

function row(env: Cell['env'], slug: Cell['slug'], flag: FlagState, expected: boolean): Cell {
  return { env, slug, flag, expected };
}

// Written out literally — NOT derived from the service's formula. Exactly ONE
// row is open: env on ∧ slug in cohort ∧ explicit DB true.
const CORE_TABLE: Cell[] = [
  //  env   slug   flag      → open?
  row('on', 'in', 'true', true),
  row('on', 'in', 'false', false),
  row('on', 'in', 'absent', false),
  row('on', 'out', 'true', false),
  row('on', 'out', 'false', false),
  row('on', 'out', 'absent', false),
  row('off', 'in', 'true', false),
  row('off', 'in', 'false', false),
  row('off', 'in', 'absent', false),
  row('off', 'out', 'true', false),
  row('off', 'out', 'false', false),
  row('off', 'out', 'absent', false),
];

describe('isMeriV3ChatEnabled — 12-cell truth table (env × slug × DB flag)', () => {
  test.each(CORE_TABLE)('env=$env slug=$slug flag=$flag → $expected', async (cell) => {
    if (cell.env === 'on') envOn();
    allowlist('revere,abramoff');
    const slug = cell.slug === 'in' ? 'revere' : 'acme-lobby';
    const svc = new MeriFeatureFlagsService(prismaWithSettings(settingsFor(cell.flag)));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, slug)).resolves.toBe(cell.expected);
  });

  test('the table enumerates every combination exactly once and exactly one is open', () => {
    const keys = CORE_TABLE.map((cell) => `${cell.env}/${cell.slug}/${cell.flag}`);
    expect(CORE_TABLE).toHaveLength(12);
    expect(new Set(keys).size).toBe(12);
    expect(CORE_TABLE.filter((cell) => cell.expected)).toEqual([
      { env: 'on', slug: 'in', flag: 'true', expected: true },
    ]);
  });
});

describe('key 1 — env MERIV3_ENABLED is a literal compare against "true"', () => {
  test.each(['false', 'TRUE', 'True', '1', 'yes', 'on', ' true ', ''])(
    'MERIV3_ENABLED=%p stays closed (slug in cohort, DB flag true) and never reads the DB',
    async (value) => {
      process.env.MERIV3_ENABLED = value;
      allowlist('revere');
      const svc = new MeriFeatureFlagsService(prismaThatMustNotQuery);
      await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'revere')).resolves.toBe(false);
    },
  );

  test('unset stays closed and never reads the DB', async () => {
    allowlist('revere');
    const svc = new MeriFeatureFlagsService(prismaThatMustNotQuery);
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'revere')).resolves.toBe(false);
  });

  test("only the literal 'true' opens the key", async () => {
    envOn();
    allowlist('revere');
    const svc = new MeriFeatureFlagsService(prismaWithSettings(flagged(true)));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'revere')).resolves.toBe(true);
  });
});

describe('key 2 — slug allowlist MERIV3_CANARY_TENANT_SLUGS', () => {
  test('unset → the default cohort is capiro-internal only', async () => {
    envOn();
    const open = new MeriFeatureFlagsService(prismaWithSettings(flagged(true)));
    await expect(open.isMeriV3ChatEnabled(TENANT_ID, 'capiro-internal')).resolves.toBe(true);
    const closed = new MeriFeatureFlagsService(prismaThatMustNotQuery);
    await expect(closed.isMeriV3ChatEnabled(TENANT_ID, 'revere')).resolves.toBe(false);
  });

  test('empty string → falls back to the default cohort (capiro-internal)', async () => {
    envOn();
    allowlist('');
    const open = new MeriFeatureFlagsService(prismaWithSettings(flagged(true)));
    await expect(open.isMeriV3ChatEnabled(TENANT_ID, 'capiro-internal')).resolves.toBe(true);
    const closed = new MeriFeatureFlagsService(prismaThatMustNotQuery);
    await expect(closed.isMeriV3ChatEnabled(TENANT_ID, 'revere')).resolves.toBe(false);
  });

  test('membership is decided by slug, never by tenant id', async () => {
    envOn();
    allowlist('revere');
    const svc = new MeriFeatureFlagsService(prismaWithSettings(flagged(true)));
    await expect(svc.isMeriV3ChatEnabled('revere', 'acme-lobby')).resolves.toBe(false);
    await expect(svc.isMeriV3ChatEnabled('any-tenant-id', 'revere')).resolves.toBe(true);
  });

  test('normalization: list entries and the incoming slug are trimmed and lower-cased', async () => {
    envOn();
    allowlist(' Revere , ABRAMOFF ,, ');
    const svc = new MeriFeatureFlagsService(prismaWithSettings(flagged(true)));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, ' REVERE ')).resolves.toBe(true);
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'abramoff')).resolves.toBe(true);
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'Abramoff')).resolves.toBe(true);
  });

  test('a list of only separators closes the cohort entirely — even capiro-internal (fail-closed)', async () => {
    envOn();
    allowlist(',,,');
    const svc = new MeriFeatureFlagsService(prismaThatMustNotQuery);
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'capiro-internal')).resolves.toBe(false);
  });

  test.each(['', '   '])('a blank slug (%p) is never in the cohort', async (slug) => {
    envOn();
    allowlist('revere,capiro-internal');
    const svc = new MeriFeatureFlagsService(prismaThatMustNotQuery);
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, slug)).resolves.toBe(false);
  });

  test('a non-member slug never reads the DB', async () => {
    envOn();
    allowlist('revere');
    const svc = new MeriFeatureFlagsService(prismaThatMustNotQuery);
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'acme-lobby')).resolves.toBe(false);
  });
});

describe('key 3 — DB flag clioFeatureFlags["meriv3.fullChat"] requires an explicit boolean true', () => {
  test.each([
    { label: 'boolean true', settings: flagged(true), expected: true },
    { label: 'boolean false', settings: flagged(false), expected: false },
    { label: 'key absent', settings: { clioFeatureFlags: {} }, expected: false },
    { label: 'no clioFeatureFlags object', settings: {}, expected: false },
    { label: "string 'true'", settings: flagged('true'), expected: false },
    { label: 'number 1', settings: flagged(1), expected: false },
    { label: 'null value', settings: flagged(null), expected: false },
    { label: 'settings null', settings: null, expected: false },
    { label: 'settings undefined', settings: undefined, expected: false },
    { label: 'settings is an array', settings: [], expected: false },
    { label: 'clioFeatureFlags is an array', settings: { clioFeatureFlags: [] }, expected: false },
    {
      label: 'clioFeatureFlags is a string',
      settings: { clioFeatureFlags: 'meriv3.fullChat' },
      expected: false,
    },
  ])('$label → $expected (env on, slug in cohort)', async ({ settings, expected }) => {
    envOn();
    allowlist('revere');
    const svc = new MeriFeatureFlagsService(prismaWithSettings(settings));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'revere')).resolves.toBe(expected);
  });

  test('a missing tenant row fails closed', async () => {
    envOn();
    allowlist('revere');
    const svc = new MeriFeatureFlagsService(prismaWithoutTenantRow);
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'revere')).resolves.toBe(false);
  });

  test('a DB read failure fails closed (never throws into the chat hot path)', async () => {
    envOn();
    allowlist('revere');
    const svc = new MeriFeatureFlagsService(prismaThatFails);
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'revere')).resolves.toBe(false);
  });
});

describe('evaluation order and short-circuit', () => {
  test('env off → no DB read even when the slug is in the cohort and the flag would be true', async () => {
    allowlist('revere');
    const reads = { count: 0 };
    const svc = new MeriFeatureFlagsService(prismaWithSettings(flagged(true), reads));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'revere')).resolves.toBe(false);
    expect(reads.count).toBe(0);
  });

  test('slug out → no DB read even when env is on and the flag would be true', async () => {
    envOn();
    allowlist('revere');
    const reads = { count: 0 };
    const svc = new MeriFeatureFlagsService(prismaWithSettings(flagged(true), reads));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'acme-lobby')).resolves.toBe(false);
    expect(reads.count).toBe(0);
  });

  test('env on ∧ slug in → exactly one DB read decides the turn', async () => {
    envOn();
    allowlist('revere');
    const reads = { count: 0 };
    const svc = new MeriFeatureFlagsService(prismaWithSettings(flagged(true), reads));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'revere')).resolves.toBe(true);
    expect(reads.count).toBe(1);
  });

  test('the env key is re-read on every call: cached tenant settings cannot keep the gate open after MERIV3_ENABLED is removed', async () => {
    envOn();
    allowlist('revere');
    const svc = new MeriFeatureFlagsService(prismaWithSettings(flagged(true)));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'revere')).resolves.toBe(true);
    delete process.env.MERIV3_ENABLED;
    // No invalidate(): the 60s settings cache is still warm, yet the gate closes.
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'revere')).resolves.toBe(false);
  });

  test('the slug allowlist is re-read on every call: shrinking the cohort closes the gate immediately', async () => {
    envOn();
    allowlist('revere,abramoff');
    const svc = new MeriFeatureFlagsService(prismaWithSettings(flagged(true)));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'revere')).resolves.toBe(true);
    allowlist('abramoff');
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'revere')).resolves.toBe(false);
  });
});

describe('live canary cohort fixture (as verified 2026-09-18 on api:384 / orch:65)', () => {
  const cohort = LIVE_CANARY_SLUGS.join(',');

  test.each(LIVE_CANARY_SLUGS)('%s opens with env on + DB flag true', async (slug) => {
    envOn();
    allowlist(cohort);
    const svc = new MeriFeatureFlagsService(prismaWithSettings(flagged(true)));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, slug)).resolves.toBe(true);
  });

  test('a tenant outside the cohort stays closed even with env on + DB flag true', async () => {
    envOn();
    allowlist(cohort);
    const svc = new MeriFeatureFlagsService(prismaThatMustNotQuery);
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID, 'acme-lobby')).resolves.toBe(false);
  });

  test('cohort membership alone is not enough: with the DB flag absent every member is closed', async () => {
    envOn();
    allowlist(cohort);
    const svc = new MeriFeatureFlagsService(prismaWithSettings({}));
    for (const slug of LIVE_CANARY_SLUGS) {
      await expect(svc.isMeriV3ChatEnabled(`${slug}-id`, slug)).resolves.toBe(false);
    }
  });
});
