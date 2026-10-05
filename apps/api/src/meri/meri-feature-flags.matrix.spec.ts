import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';
import { MERIV3_CHAT_FLAG } from '../common/meriv3-flags.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Truth table for `MeriFeatureFlagsService.isMeriV3ChatEnabled(tenantId)` — the
 * gate behind `MeriV3ProxyService.shouldHandle`, i.e. the FIRST routing decision
 * for every full-chat turn (meriv3-runtime.proxy.ts).
 *
 * Contract since the 2026-10-05 program plan (§2.2, §4.1): V3 is the only chat
 * runtime. Two keys, both default ON, evaluated in this order with short-circuit:
 *
 *   1. env MERIV3_ENABLED — global kill switch; unset or any value other than an
 *      explicit off value ('false', '0', 'off', 'no', trimmed, any case) is on.
 *   2. DB  clioFeatureFlags['meriv3.fullChat'] — tenant off switch; only an
 *      explicit boolean false closes it. A missing row, malformed settings or a
 *      DB read failure resolve to the default (on).
 *
 * A closed gate means the turn is REFUSED as "Meri is unavailable"; it never
 * falls back to MeriV2 or the legacy loop. There is no tenant slug allow-list:
 * MERIV3_CANARY_TENANT_SLUGS is ignored.
 *
 * This replaces the three-key canary matrix (env 'true' ∧ slug in cohort ∧ DB
 * true). If a cell goes red, ROUTING CHANGED: explain it as a defect or an
 * explicitly authorized contract change; do not edit the expectation to match.
 */

const TENANT_ID = 'tenant-1';

/** Fake PrismaService whose withTenant yields a tenant with the given settings and counts reads. */
function prismaWithSettings(settings: unknown, reads = { count: 0 }): PrismaService {
  return {
    withTenant: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
      reads.count += 1;
      return fn({ tenant: { findFirst: async () => ({ settings }) } });
    },
  } as unknown as PrismaService;
}

const prismaWithoutTenantRow: PrismaService = {
  withTenant: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ tenant: { findFirst: async () => null } }),
} as unknown as PrismaService;

const prismaThatMustNotQuery: PrismaService = {
  withTenant: async () => {
    throw new Error('DB must not be queried while the global kill switch is closed');
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

type EnvState = 'unset' | 'true' | 'false';
type FlagState = 'true' | 'false' | 'absent';

function applyEnv(env: EnvState): void {
  if (env !== 'unset') process.env.MERIV3_ENABLED = env;
}

function settingsFor(flag: FlagState): unknown {
  return flag === 'absent' ? {} : flagged(flag === 'true');
}

interface Cell {
  env: EnvState;
  flag: FlagState;
  expected: boolean;
}

const row = (env: EnvState, flag: FlagState, expected: boolean): Cell => ({ env, flag, expected });

// Written out literally — NOT derived from the service's formula.
const CORE_TABLE: Cell[] = [
  //  env      flag      → served by V3?
  row('unset', 'true', true),
  row('unset', 'absent', true),
  row('unset', 'false', false),
  row('true', 'true', true),
  row('true', 'absent', true),
  row('true', 'false', false),
  row('false', 'true', false),
  row('false', 'absent', false),
  row('false', 'false', false),
];

describe('isMeriV3ChatEnabled — 9-cell truth table (env × DB flag)', () => {
  test.each(CORE_TABLE)('env=$env flag=$flag → $expected', async (cell) => {
    applyEnv(cell.env);
    const svc = new MeriFeatureFlagsService(prismaWithSettings(settingsFor(cell.flag)));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID)).resolves.toBe(cell.expected);
  });

  test('the table enumerates every combination once; only explicit off values close it', () => {
    const keys = CORE_TABLE.map((cell) => `${cell.env}/${cell.flag}`);
    expect(new Set(keys).size).toBe(9);
    expect(CORE_TABLE.filter((cell) => !cell.expected)).toEqual([
      { env: 'unset', flag: 'false', expected: false },
      { env: 'true', flag: 'false', expected: false },
      { env: 'false', flag: 'true', expected: false },
      { env: 'false', flag: 'absent', expected: false },
      { env: 'false', flag: 'false', expected: false },
    ]);
  });
});

describe('key 1 — env MERIV3_ENABLED is a kill switch that defaults on', () => {
  test.each(['false', 'FALSE', ' false ', '0', 'off', 'OFF', 'no'])(
    'MERIV3_ENABLED=%p closes the gate and never reads the DB',
    async (value) => {
      process.env.MERIV3_ENABLED = value;
      const svc = new MeriFeatureFlagsService(prismaThatMustNotQuery);
      await expect(svc.isMeriV3ChatEnabled(TENANT_ID)).resolves.toBe(false);
    },
  );

  test.each(['true', 'TRUE', '1', 'yes', 'on', ''])(
    'MERIV3_ENABLED=%p leaves the gate open',
    async (value) => {
      process.env.MERIV3_ENABLED = value;
      const svc = new MeriFeatureFlagsService(prismaWithSettings(flagged(true)));
      await expect(svc.isMeriV3ChatEnabled(TENANT_ID)).resolves.toBe(true);
    },
  );
});

describe('no slug allow-list', () => {
  test('MERIV3_CANARY_TENANT_SLUGS is ignored; a tenant outside any list is served', async () => {
    process.env.MERIV3_ENABLED = 'true';
    process.env.MERIV3_CANARY_TENANT_SLUGS = 'capiro-internal';
    const svc = new MeriFeatureFlagsService(prismaWithSettings({}));
    await expect(svc.isMeriV3ChatEnabled('brand-new-tenant')).resolves.toBe(true);
  });
});

describe('key 2 — DB flag clioFeatureFlags["meriv3.fullChat"] closes only on explicit false', () => {
  test.each([
    { label: 'boolean true', settings: flagged(true), expected: true },
    { label: 'boolean false', settings: flagged(false), expected: false },
    { label: 'key absent', settings: { clioFeatureFlags: {} }, expected: true },
    { label: 'no clioFeatureFlags object', settings: {}, expected: true },
    { label: "string 'false'", settings: flagged('false'), expected: true },
    { label: 'number 0', settings: flagged(0), expected: true },
    { label: 'null value', settings: flagged(null), expected: true },
    { label: 'settings null', settings: null, expected: true },
    { label: 'settings is an array', settings: [], expected: true },
    { label: 'clioFeatureFlags is an array', settings: { clioFeatureFlags: [] }, expected: true },
  ])('$label → $expected', async ({ settings, expected }) => {
    const svc = new MeriFeatureFlagsService(prismaWithSettings(settings));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID)).resolves.toBe(expected);
  });

  test('a missing tenant row resolves to the default (on)', async () => {
    const svc = new MeriFeatureFlagsService(prismaWithoutTenantRow);
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID)).resolves.toBe(true);
  });

  test('a DB read failure resolves to the default (on) and never throws into the hot path', async () => {
    const svc = new MeriFeatureFlagsService(prismaThatFails);
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID)).resolves.toBe(true);
  });
});

describe('evaluation order, caching and invalidation', () => {
  test('env off → no DB read', async () => {
    process.env.MERIV3_ENABLED = 'false';
    const reads = { count: 0 };
    const svc = new MeriFeatureFlagsService(prismaWithSettings(flagged(true), reads));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID)).resolves.toBe(false);
    expect(reads.count).toBe(0);
  });

  test('env on → exactly one DB read decides the turn', async () => {
    const reads = { count: 0 };
    const svc = new MeriFeatureFlagsService(prismaWithSettings(flagged(true), reads));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID)).resolves.toBe(true);
    expect(reads.count).toBe(1);
  });

  test('the env key is re-read on every call: a warm settings cache cannot keep the gate open', async () => {
    const svc = new MeriFeatureFlagsService(prismaWithSettings(flagged(true)));
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID)).resolves.toBe(true);
    process.env.MERIV3_ENABLED = 'false';
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID)).resolves.toBe(false);
  });

  test('invalidate() makes a tenant flag flip land on the next turn', async () => {
    let settings: unknown = flagged(true);
    const prisma = {
      withTenant: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ tenant: { findFirst: async () => ({ settings }) } }),
    } as unknown as PrismaService;
    const svc = new MeriFeatureFlagsService(prisma);
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID)).resolves.toBe(true);
    settings = flagged(false);
    svc.invalidate(TENANT_ID);
    await expect(svc.isMeriV3ChatEnabled(TENANT_ID)).resolves.toBe(false);
  });
});
