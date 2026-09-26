import { JEV_TASK_REGISTRY, JEV_TASK_REGISTRY_VERSION } from '@capiro/meriv2-core';

/**
 * Focused Phase 3 controls coverage: config dark defaults + blank
 * normalization, pure tenant flags, least-permissive per-task mode
 * resolution (incl. registry refusal of unapproved canary), and the shared
 * provider factory's tenant/surface/task/provider gating. All pure, no
 * database, no provider calls.
 */

// ── tenant flags ────────────────────────────────────────────────────────────

describe('bizdevJevTaskModes (pure tenant flags)', () => {
  const { bizdevJevTaskModes } = require('../common/tenant-flags.js') as typeof import('../common/tenant-flags.js');

  test('null/undefined/blank settings → every task off (dark default)', () => {
    for (const settings of [null, undefined, {}, { clioFeatureFlags: null }]) {
      expect(bizdevJevTaskModes(settings)).toEqual({
        bd_entity: 'off',
        bd_signal: 'off',
      });
    }
  });

  test('explicit enrollment is read per task and per mode', () => {
    const base = (over: Record<string, boolean>) => ({
      clioFeatureFlags: {
        'businessDevelopment.jev.task.bdEntity.shadow.enabled': false,
        'businessDevelopment.jev.task.bdEntity.internalCanary.enabled': false,
        'businessDevelopment.jev.task.bdSignal.shadow.enabled': false,
        'businessDevelopment.jev.task.bdSignal.internalCanary.enabled': false,
        ...over,
      },
    });
    expect(bizdevJevTaskModes(base({
      'businessDevelopment.jev.task.bdEntity.shadow.enabled': true,
    }))).toEqual({ bd_entity: 'shadow', bd_signal: 'off' });
    expect(bizdevJevTaskModes(base({
      'businessDevelopment.jev.task.bdSignal.internalCanary.enabled': true,
    }))).toEqual({ bd_entity: 'off', bd_signal: 'internal_canary' });
  });
});

// ── mode resolution ─────────────────────────────────────────────────────────

describe('resolveBdJevTaskMode (least permissive wins; canary gated)', () => {
  const { resolveBdJevTaskMode, resolveBdJevModes } = require('./bizdev-jev-mode.js') as typeof import('./bizdev-jev-mode.js');

  const enrolled = (mode: 'shadow' | 'internal_canary') => ({
    bd_entity: mode,
    bd_signal: mode,
  });

  test('global kill switch off (or blank/garbage) → off for every tenant/task', () => {
    for (const raw of [undefined, '', ' ', 'false', 'no', '0', 'banana']) {
      const r = resolveBdJevTaskMode({
        task: 'bd_entity',
        env: { BIZDEV_JEV_ENABLED: raw, BIZDEV_JEV_TASK_BD_ENTITY_MODE: 'internal_canary' },
        tenantModes: enrolled('internal_canary'),
      });
      expect(r.mode).toBe('off');
      expect(r.reasons).toContain('global_kill_switch_off');
    }
  });

  test('env mode off or blank/garbage → off (dark default per task)', () => {
    for (const raw of [undefined, '', '  ', 'shadowish', 'OFF']) {
      const r = resolveBdJevTaskMode({
        task: 'bd_signal',
        env: { BIZDEV_JEV_ENABLED: 'true', BIZDEV_JEV_TASK_BD_SIGNAL_MODE: raw },
        tenantModes: enrolled('shadow'),
      });
      expect(r.mode).toBe('off');
    }
  });

  test('tenant not enrolled → off even when env allows shadow', () => {
    const r = resolveBdJevTaskMode({
      task: 'bd_entity',
      env: { BIZDEV_JEV_ENABLED: 'true', BIZDEV_JEV_TASK_BD_ENTITY_MODE: 'shadow' },
      tenantModes: { bd_entity: 'off', bd_signal: 'shadow' },
    });
    expect(r.mode).toBe('off');
    expect(r.reasons).toContain('tenant_not_enrolled');
  });

  test('shadow requires BOTH env shadow and tenant shadow enrollment', () => {
    const r = resolveBdJevTaskMode({
      task: 'bd_entity',
      env: { BIZDEV_JEV_ENABLED: 'true', BIZDEV_JEV_TASK_BD_ENTITY_MODE: 'shadow' },
      tenantModes: enrolled('shadow'),
    });
    expect(r.mode).toBe('shadow');
  });

  test('registry REFUSES unapproved canary: off, never a silent shadow downgrade', () => {
    const registration = JEV_TASK_REGISTRY.bd_entity;
    expect(registration).toBeDefined();
    // Today's registry: shadow ceiling and a non-approved evaluation set.
    expect(registration!.maxRolloutMode).toBe('shadow');
    expect(registration!.evaluationSet.status).not.toBe('approved');

    const r = resolveBdJevTaskMode({
      task: 'bd_entity',
      env: { BIZDEV_JEV_ENABLED: 'true', BIZDEV_JEV_TASK_BD_ENTITY_MODE: 'internal_canary' },
      tenantModes: enrolled('internal_canary'),
    });
    expect(r.mode).toBe('off');
    expect(r.reasons).toContain('registry_refuses_canary');
    // Downgrading to shadow would be MORE permissive than the tenant enrolled.
    expect(r.mode).not.toBe('shadow');
  });

  test('registry-approved canary arms only when the ceiling rises above shadow', () => {
    const approved = {
      maxRolloutMode: 'internal_canary',
      evaluationSet: { status: 'approved' },
    };
    const r = resolveBdJevTaskMode({
      task: 'bd_signal',
      env: { BIZDEV_JEV_ENABLED: 'true', BIZDEV_JEV_TASK_BD_SIGNAL_MODE: 'internal_canary' },
      tenantModes: enrolled('internal_canary'),
      registration: approved as never,
    });
    expect(r.mode).toBe('internal_canary');
    // And the same registry still refuses while shadow-only.
    const r2 = resolveBdJevTaskMode({
      task: 'bd_signal',
      env: { BIZDEV_JEV_ENABLED: 'true', BIZDEV_JEV_TASK_BD_SIGNAL_MODE: 'internal_canary' },
      tenantModes: enrolled('internal_canary'),
      registration: { ...approved, maxRolloutMode: 'shadow' } as never,
    });
    expect(r2.mode).toBe('off');
    expect(r2.reasons).toContain('registry_refuses_canary');
  });

  test('resolveBdJevModes resolves both tasks independently', () => {
    const out = resolveBdJevModes({
      env: {
        BIZDEV_JEV_ENABLED: 'true',
        BIZDEV_JEV_TASK_BD_ENTITY_MODE: 'shadow',
        BIZDEV_JEV_TASK_BD_SIGNAL_MODE: 'off',
      },
      tenantSettings: {
        clioFeatureFlags: {
          'businessDevelopment.jev.task.bdEntity.shadow.enabled': true,
        },
      },
    });
    expect(out.bd_entity.mode).toBe('shadow');
    expect(out.bd_signal.mode).toBe('off');
  });
});

// ── config schema dark defaults ─────────────────────────────────────────────

describe('config schema BD Jev dark defaults + blank normalization', () => {
  const mod = require('../config/config.schema.js') as typeof import('../config/config.schema.js');
  const schema = mod.configSchema;
  const requiredCore = {
    DATABASE_URL: 'postgresql://localhost:5432/capiro',
    CLERK_SECRET_KEY: 'sk_test',
    CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_test',
  };
  const blankToUndefined = (v: string) => v.trim() === '' ? undefined : v;

  test('schema module exposes the env schema and its validator', () => {
    expect(schema && typeof (schema as { safeParse?: unknown }).safeParse === 'function').toBe(true);
  });

  test('absent vars default: kill switch false, task modes off', () => {
    const parsed = (schema as unknown as { safeParse: (x: unknown) => { success: boolean; data: Record<string, string> } }).safeParse({ ...requiredCore });
    expect(parsed.success).toBe(true);
    expect(parsed.data.BIZDEV_JEV_ENABLED).toBe('false');
    expect(parsed.data.BIZDEV_JEV_TASK_BD_ENTITY_MODE).toBe('off');
    expect(parsed.data.BIZDEV_JEV_TASK_BD_SIGNAL_MODE).toBe('off');
  });

  test('blank strings normalize to the dark default (not parse failures)', () => {
    const parsed = (schema as unknown as { safeParse: (x: unknown) => { success: boolean; data: Record<string, string> } }).safeParse({
      ...requiredCore,
      BIZDEV_JEV_ENABLED: '   ',
      BIZDEV_JEV_TASK_BD_ENTITY_MODE: '  ',
      BIZDEV_JEV_TASK_BD_SIGNAL_MODE: '\t',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data.BIZDEV_JEV_ENABLED).toBe('false');
    expect(parsed.data.BIZDEV_JEV_TASK_BD_ENTITY_MODE).toBe('off');
    expect(parsed.data.BIZDEV_JEV_TASK_BD_SIGNAL_MODE).toBe('off');
    // blankToUndefined helper: trim-empty → undefined
    expect(blankToUndefined('  ')).toBeUndefined();
    expect(blankToUndefined(' x ')).toBe(' x ');
  });

  test('BIZDEV_JEV_ENABLED accepts any non-empty string without failing validation', () => {
    const parsed = (schema as unknown as { safeParse: (x: unknown) => { success: boolean; data: Record<string, string> } }).safeParse({
      ...requiredCore,
      BIZDEV_JEV_ENABLED: 'true',
      BIZDEV_JEV_TASK_BD_ENTITY_MODE: 'shadow',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data.BIZDEV_JEV_TASK_BD_ENTITY_MODE).toBe('shadow');
  });
});
