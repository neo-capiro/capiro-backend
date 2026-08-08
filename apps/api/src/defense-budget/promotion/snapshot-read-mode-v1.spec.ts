/**
 * Phase 7 Workstream M — which source a read is served from.
 *
 * Pure policy, so every rollout state is decided here. The fail-safe matters
 * more than the happy path: an operator flips this flag on a live product, and
 * the only acceptable failure direction is back to legacy.
 */
import {
  DEFAULT_SNAPSHOT_READ_MODE_V1,
  legacyWritesUnsafeInModeV1,
  resolveSnapshotReadModeV1,
  SNAPSHOT_READ_MODE_V1_VALUES,
  type SnapshotReadModeV1,
} from './snapshot-read-mode-v1.js';

const TENANT = 'tenant-alpha';

function resolve(
  configuredMode: SnapshotReadModeV1,
  overrides: { tenantId?: string | null; canary?: string[]; hasActiveSnapshot?: boolean } = {},
) {
  return resolveSnapshotReadModeV1({
    configuredMode,
    tenantId: overrides.tenantId === undefined ? TENANT : overrides.tenantId,
    canaryTenantIds: overrides.canary,
    hasActiveSnapshot: overrides.hasActiveSnapshot ?? true,
  });
}

describe('Phase 7 WS M — the default is inert', () => {
  it('defaults to legacy, so the workstream lands changing nothing', () => {
    expect(DEFAULT_SNAPSHOT_READ_MODE_V1).toBe('legacy');
    expect(resolve('legacy')).toEqual({
      serve: 'legacy',
      compare: false,
      reason: 'mode_legacy',
    });
  });
});

describe('Phase 7 WS M — mode resolution', () => {
  it('serves legacy and compares in shadow', () => {
    expect(resolve('shadow')).toEqual({ serve: 'legacy', compare: true, reason: 'mode_shadow' });
  });

  it('serves the snapshot to a canary tenant', () => {
    expect(resolve('snapshot_canary', { canary: [TENANT] })).toEqual({
      serve: 'snapshot',
      compare: true,
      reason: 'canary_tenant',
    });
  });

  it('still compares for a non-canary tenant in canary mode', () => {
    // The canary exists to find what shadow missed. Switching comparison off
    // for the traffic still on legacy would discard the larger sample at
    // exactly the moment it matters most.
    expect(resolve('snapshot_canary', { canary: ['someone-else'] })).toEqual({
      serve: 'legacy',
      compare: true,
      reason: 'canary_non_tenant',
    });
  });

  it('treats a system context as non-canary rather than as a match', () => {
    expect(resolve('snapshot_canary', { tenantId: null, canary: [TENANT] }).serve).toBe('legacy');
  });

  it('serves the snapshot to everyone and stops comparing in snapshot mode', () => {
    expect(resolve('snapshot')).toEqual({
      serve: 'snapshot',
      compare: false,
      reason: 'mode_snapshot',
    });
  });

  it('has an answer for every mode in the vocabulary', () => {
    for (const mode of SNAPSHOT_READ_MODE_V1_VALUES) {
      expect(['legacy', 'snapshot']).toContain(resolve(mode).serve);
    }
  });
});

describe('Phase 7 WS M — no active snapshot is always legacy', () => {
  it('forces legacy in every mode, including full snapshot mode', () => {
    // A snapshot read with no activation pointer is not an empty result, it is a
    // product outage: the finder returns nothing and every profile 404s. The
    // pointer is absent exactly when that would be worst — before the first
    // promotion, and right after a rollback.
    for (const mode of SNAPSHOT_READ_MODE_V1_VALUES) {
      const decision = resolve(mode, { hasActiveSnapshot: false, canary: [TENANT] });
      expect(decision.serve).toBe('legacy');
      expect(decision.reason).toBe('no_active_snapshot');
    }
  });

  it('does not compare against a snapshot that does not exist', () => {
    // A "mismatch" against an absent snapshot is pure noise on the dashboard an
    // operator is watching to decide whether to proceed.
    expect(resolve('shadow', { hasActiveSnapshot: false }).compare).toBe(false);
  });
});

describe('Phase 7 WS M — reads and writes are coupled', () => {
  it('treats legacy writes as unsafe once any tenant is on the snapshot', () => {
    expect(legacyWritesUnsafeInModeV1('legacy')).toBe(false);
    expect(legacyWritesUnsafeInModeV1('shadow')).toBe(false);
    expect(legacyWritesUnsafeInModeV1('snapshot_canary')).toBe(true);
    expect(legacyWritesUnsafeInModeV1('snapshot')).toBe(true);
  });
});
